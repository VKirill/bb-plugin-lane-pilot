import { breakerKey } from "@lane-pilot/resilience";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { SANDBOX_PROJECT_ID } from "../../stability/server";
import { adapterVersions, capabilityTable, dueProbes, providersInUse } from "../logic";
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
    const rows = (db.prepare(`SELECT key, value FROM lane_pilot_project_settings WHERE binding_id='' AND (key LIKE '%.provider' OR key LIKE '%.model' OR key IN ('pmProviderId','pmModel','writerProviderId','writerModel'))`).all() as Array<{ key: string; value: string }>)
      .map((row) => { try { return { key: row.key, value: JSON.parse(row.value) as unknown }; } catch { return { key: row.key, value: row.value as unknown }; } });
    const inUse = providersInUse(rows, BASE_PROVIDERS);
    const hostId = (db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key='hostId'").get(SANDBOX_PROJECT_ID) as { value: string } | undefined)?.value;
    const providers = rowsOf(await bb.sdk.providers.list({ hostId: hostId ? JSON.parse(hostId) as string : undefined } as never).catch(() => []), "providers");
    const plugins = rowsOf(await (bb.sdk.plugins.list() as Promise<unknown>).catch(() => []), "plugins");
    const versions = adapterVersions(providers.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, pluginId: typeof row.pluginId === "string" ? row.pluginId : null }] : []),
      plugins.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, version: typeof row.version === "string" ? row.version : null }] : []));
    return { inUse, versions };
  }

  /** The latest sandbox run with a PM chat: the place the helper probe starts its helper in. */
  function probeRun(): string | null {
    return (db.prepare("SELECT id FROM lane_pilot_run WHERE project_id=? AND pm_thread_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(SANDBOX_PROJECT_ID) as { id: string } | undefined)?.id ?? null;
  }

  async function sweep(now = Date.now()) {
    const { inUse, versions } = await snapshot();
    const due = dueProbes(inUse, versions, listReceipts(db));
    const runId = probeRun();
    const probed: Array<{ providerId: string; version: string; state: string; reason: string | null }> = [];
    for (const item of due) {
      if (ctx.isDisposed()) break;
      if (!runId) { ctx.log("capability: no sandbox run with a PM chat to probe in"); break; }
      const result = await services.startHelperProbe(SANDBOX_PROJECT_ID, runId, item.providerId, item.model).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
      const state = result.ok ? "supported" : "not_supported";
      saveReceipt(db, { providerId: item.providerId, version: item.version, capability: "answers", state, model: item.model, detail: result.ok ? null : (result.reason ?? "no answer").slice(0, 500), at: now });
      if (!result.ok) services.providerBreaker.record(breakerKey(item.providerId, item.model), "exhausted", now);
      ctx.log(`capability: ${item.providerId} ${item.version} answers=${state}${result.ok ? "" : ` (${result.reason ?? "no answer"})`}`);
      probed.push({ providerId: item.providerId, version: item.version, state, reason: result.ok ? null : result.reason ?? null });
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
