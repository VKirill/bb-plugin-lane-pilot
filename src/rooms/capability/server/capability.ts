import { CAPABILITIES } from "../logic";
import { breakerKey } from "@lane-pilot/resilience";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { SANDBOX_PROJECT_ID } from "../../stability/server";
import { adapterVersions, capabilityTable, dueProbes, probeSetupFailed, providersInUse } from "../logic";
import { listReceipts, saveReceipt } from "../store";

/**
 * The probing service of the capability table (SMA D2-7). Every hour it lists the providers in use (all projects' settings and the three
 * base providers), reads the installed adapter version of each (its BB plugin's version) and probes every provider whose version has no
 * receipt yet with one cheap helper on the sandbox project. A failed probe opens the provider breaker for that model, so writers and helpers
 * fall back to another provider until the adapter answers again; a passed one is the receipt that the version works.
 */
export const BASE_PROVIDERS: Readonly<Record<string, string>> = { "claude-code": "claude-sonnet-5-5", codex: "gpt-6-luna", opencode2: "zai-coding-plan/glm-5.3-flash" };
type Listed = Array<{ id?: unknown; pluginId?: unknown; version?: unknown }>;
const rowsOf = (value: unknown, key: string): Listed => (Array.isArray(value) ? value : ((value as Record<string, unknown> | null)?.[key] as unknown[] | undefined) ?? []) as Listed;

export function createCapabilities(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;

  async function snapshot() {
    const rows = (db.prepare(`SELECT project_id, key, value FROM lane_pilot_project_settings WHERE binding_id='' AND (key LIKE '%.provider' OR key LIKE '%.model' OR key IN ('pmProviderId','pmModel','writerProviderId','writerModel'))`).all() as Array<{ project_id: string; key: string; value: string }>)
      .map((row) => { try { return { project: row.project_id, key: row.key, value: JSON.parse(row.value) as unknown }; } catch { return { project: row.project_id, key: row.key, value: row.value as unknown }; } });
    // A provider and its model pair up within one project's settings, never across projects.
    const inUse = new Map<string, string>();
    for (const project of new Set(rows.map((row) => row.project))) for (const [provider, model] of providersInUse(rows.filter((row) => row.project === project))) if (!inUse.has(provider)) inUse.set(provider, model);
    for (const [provider, model] of Object.entries(BASE_PROVIDERS)) if (!inUse.has(provider)) inUse.set(provider, model);
    const hostId = (db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key='hostId'").get(SANDBOX_PROJECT_ID) as { value: string } | undefined)?.value;
    const providers = rowsOf(await bb.sdk.providers.list({ hostId: hostId ? JSON.parse(hostId) as string : undefined } as never).catch(() => []), "providers");
    const plugins = rowsOf(await (bb.sdk.plugins.list() as Promise<unknown>).catch(() => []), "plugins");
    const versions = adapterVersions(providers.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, pluginId: typeof row.pluginId === "string" ? row.pluginId : null }] : []),
      plugins.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, version: typeof row.version === "string" ? row.version : null }] : []));
    return { inUse, versions };
  }

  /** The latest sandbox run whose PM chat is still there (not archived or deleted): a helper needs a live parent. */
  async function probeRun(): Promise<string | null> {
    const runs = db.prepare("SELECT id, pm_thread_id FROM lane_pilot_run WHERE project_id=? AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 20").all(SANDBOX_PROJECT_ID) as Array<{ id: string; pm_thread_id: string }>;
    for (const run of runs) {
      const thread = await bb.sdk.threads.get({ threadId: run.pm_thread_id }).catch(() => null) as { archivedAt?: unknown; deletedAt?: unknown } | null;
      if (thread && !thread.archivedAt && !thread.deletedAt) return run.id;
    }
    return null;
  }

  async function sweep(now = Date.now()) {
    const { inUse, versions } = await snapshot();
    const due = dueProbes(inUse, versions, listReceipts(db));
    const runId = due.length ? await probeRun() : null;
    const probed: Array<{ providerId: string; version: string; state: string; reason: string | null }> = [];
    const have = new Set(listReceipts(db).map((row) => `${row.providerId}\u0000${row.version}\u0000${row.capability}`));
    for (const item of due) {
      if (ctx.isDisposed()) break;
      if (!runId) { ctx.log("capability: no sandbox run with a PM chat to probe in"); break; }
      // Every capability the installed version has no receipt for: answers first; documentary and pause only once it answers.
      for (const capability of CAPABILITIES.filter((name) => !have.has(`${item.providerId}\u0000${item.version}\u0000${name}`))) {
        const result = await services.startHelperProbe(SANDBOX_PROJECT_ID, runId, item.providerId, item.model, capability).catch((cause: unknown) => ({ ok: false, started: false, reason: cause instanceof Error ? cause.message : String(cause) }));
        // A probe that could not even be set up (a dead parent, no such model) says nothing about the adapter: no receipt, no breaker.
        if (!result.ok && probeSetupFailed(result.reason ?? null)) {
          ctx.log(`capability: ${item.providerId} ${item.version} ${capability} not probed: ${result.reason}`);
          probed.push({ providerId: item.providerId, version: item.version, state: "not_probed", reason: result.reason ?? null });
          break;
        }
        const state = result.ok ? "supported" : "not_supported";
        saveReceipt(db, { providerId: item.providerId, version: item.version, capability, state, model: item.model, detail: result.ok ? null : (result.reason ?? "no answer").slice(0, 500), at: now });
        // Only a provider that does not answer at all is held off; a documentary or pause gap is a cell of the table.
        if (!result.ok && capability === "answers") services.providerBreaker.record(breakerKey(item.providerId, item.model), "exhausted", now);
        ctx.log(`capability: ${item.providerId} ${item.version} ${capability}=${state}${result.ok ? "" : ` (${result.reason ?? "no answer"})`}`);
        probed.push({ providerId: item.providerId, version: item.version, state: `${capability}:${state}`, reason: result.ok ? null : result.reason ?? null });
        if (!result.ok && capability === "answers") break;
      }
    }
    return probed;
  }

  async function table() {
    const { inUse, versions } = await snapshot();
    return capabilityTable(inUse, versions, listReceipts(db));
  }

  return { capabilities: { sweep, table } };
}
export type CapabilitiesApi = ReturnType<typeof createCapabilities>["capabilities"];

export function mountCapabilities(ctx: ServerCore, api: CapabilitiesApi): void {
  scheduleIsolated(ctx.bb, "capability-sweep", "7 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.sweep().catch((cause: unknown) => ctx.log(`capability sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
