import { breakerKey } from "@lane-pilot/resilience";
import { claimDailySchedule, listProviderSettingRows, listRunsWithPmThread, projectSettingValue } from "../../storage";
import { scheduleIsolated, bindDocumentaryGate } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { SANDBOX_PROJECT_ID } from "../../contracts";
import { CAPABILITIES, DOCUMENTARY_CELLS, adapterVersions, capabilityState, capabilityTable, dueProbes, probeSetupFailed, providersInUse, receiptKey } from "../logic";
import { listReceipts, saveReceipt } from "../store";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import { NATIVE_HOOK_SOURCES } from "../../contracts";

import type { ProbesApi } from "../../stability/server/probes";
import type { WriterStateApi } from "../../writer/server/state";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  providerBreaker: WriterStateApi["providerBreaker"];
  startHelperProbe: ProbesApi["startHelperProbe"];
}

/**
 * The probing service of the capability table (SMA D2-7). Every hour it lists the providers in use (all projects' settings and the three
 * base providers), reads the installed adapter version of each (its BB plugin's version) and probes every provider whose receipt key —
 * the adapter version plus the fingerprint of its model, settings and installed hooks — has no receipt yet with one cheap helper on the
 * sandbox project. A failed probe opens the provider breaker for that model, so writers and helpers fall back to another provider until
 * the adapter answers again; a passed one is the receipt that the version works. The documentary gate (`bindDocumentaryGate`) reads the
 * same table before a documentary stage spawns: an unproved provider is refused, not started.
 */
export const BASE_PROVIDERS: Readonly<Record<string, string>> = { "claude-code": "claude-sonnet-5-5", codex: "gpt-6-luna", opencode2: "zai-coding-plan/glm-5.3-flash" };
type Listed = Array<{ id?: unknown; pluginId?: unknown; version?: unknown }>;
const rowsOf = (value: unknown, key: string): Listed => (Array.isArray(value) ? value : ((value as Record<string, unknown> | null)?.[key] as unknown[] | undefined) ?? []) as Listed;

/** The fingerprint of the hooks installed for helpers: a receipt is void the moment any hook source changes. */
const hookFingerprint = (): string => JSON.stringify(NATIVE_HOOK_SOURCES);

export function createCapabilities(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;

  async function snapshot() {
    const rows = listProviderSettingRows(db)
      .map((row) => { try { return { project: row.project_id, key: row.key, value: JSON.parse(row.value) as unknown }; } catch { return { project: row.project_id, key: row.key, value: row.value as unknown }; } });
    // A provider and its model pair up within one project's settings, never across projects.
    const inUse = new Map<string, string>();
    const projectOf = new Map<string, string>();
    for (const project of new Set(rows.map((row) => row.project))) for (const [provider, model] of providersInUse(rows.filter((row) => row.project === project))) if (!inUse.has(provider)) { inUse.set(provider, model); projectOf.set(provider, project); }
    for (const [provider, model] of Object.entries(BASE_PROVIDERS)) if (!inUse.has(provider)) inUse.set(provider, model);
    const hostId = projectSettingValue(db, SANDBOX_PROJECT_ID, "hostId");
    const providers = rowsOf(await bb.sdk.providers.list({ hostId: hostId ? JSON.parse(hostId) as string : undefined } as never).catch(() => []), "providers");
    const plugins = rowsOf(await (bb.sdk.plugins.list() as Promise<unknown>).catch(() => []), "plugins");
    const pluginVersions = adapterVersions(providers.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, pluginId: typeof row.pluginId === "string" ? row.pluginId : null }] : []),
      plugins.flatMap((row) => typeof row.id === "string" ? [{ id: row.id, version: typeof row.version === "string" ? row.version : null }] : []));
    // The key a receipt applies to is the adapter version plus the fingerprint of the model, the provider's own settings rows and the
    // installed hook sources (SMA «Receipt applies now»): a change of any of them leaves the cells unproven.
    const hooks = hookFingerprint();
    const versions = new Map<string, string | null>();
    for (const [providerId, model] of inUse) {
      const pluginVersion = pluginVersions.get(providerId) ?? null;
      const own = projectOf.has(providerId) ? rows.filter((row) => row.project === projectOf.get(providerId)) : [];
      const stems = own.filter((row) => row.key.endsWith(".provider") && row.value === providerId).map((row) => row.key.slice(0, -"provider".length));
      for (const lead of ["pm", "writer"]) if (own.some((row) => row.key === `${lead}ProviderId` && row.value === providerId)) stems.push(lead);
      const settings = own.filter((row) => stems.some((stem) => row.key.startsWith(stem)));
      versions.set(providerId, pluginVersion ? receiptKey({ version: pluginVersion, model, settings, hooks }) : null);
    }
    return { inUse, versions };
  }

  /** The latest sandbox run whose PM chat is still there (not archived or deleted): a helper needs a live parent. */
  async function probeRun(): Promise<string | null> {
    const runs = listRunsWithPmThread(db, SANDBOX_PROJECT_ID);
    for (const run of runs) {
      const thread = await orMiss(bb.sdk.threads.get({ threadId: run.pm_thread_id }), null, isNotFound) as { archivedAt?: unknown; deletedAt?: unknown } | null;
      if (thread && !thread.archivedAt && !thread.deletedAt) return run.id;
    }
    return null;
  }

  // A probe setup failure (a dead parent, no such model) is one log line per (provider, key, capability) streak — the hourly
  // sweep re-reads it once it changed, like the permit sweep's downLogged set, instead of repeating the same line every pass.
  const setupFailedLogged = new Set<string>();

  async function sweep(now = Date.now()) {
    const { inUse, versions } = await snapshot();
    const due = dueProbes(inUse, versions, listReceipts(db));
    const runId = due.length ? await probeRun() : null;
    const probed: Array<{ providerId: string; version: string; state: string; reason: string | null }> = [];
    const have = new Set(listReceipts(db).map((row) => `${row.providerId}\u0000${row.version}\u0000${row.capability}`));
    for (const item of due) {
      if (ctx.isDisposed()) break;
      if (!runId) { ctx.log("capability: no sandbox run with a PM chat to probe in"); break; }
      // Every capability the installed key has no receipt for: answers first; the rest only once it answers.
      const silent = listReceipts(db).some((row) => row.providerId === item.providerId && row.version === item.version && row.capability === "answers" && row.state === "not_supported");
      if (silent) continue;
      for (const capability of CAPABILITIES.filter((name) => !have.has(`${item.providerId}\u0000${item.version}\u0000${name}`))) {
        const result = await services.startHelperProbe(SANDBOX_PROJECT_ID, runId, item.providerId, item.model, capability).catch((cause: unknown) => ({ ok: false, started: false, reason: cause instanceof Error ? cause.message : String(cause) }));
        // A probe that could not even be set up (a dead parent, no such model) says nothing about the adapter: no receipt, no breaker.
        if (!result.ok && probeSetupFailed(result.reason ?? null)) {
          const key = `${item.providerId}\u0000${item.version}\u0000${capability}`;
          if (!setupFailedLogged.has(key)) {
            setupFailedLogged.add(key);
            ctx.log(`capability: ${item.providerId} ${item.version} ${capability} not probed: ${result.reason}`);
          }
          probed.push({ providerId: item.providerId, version: item.version, state: "not_probed", reason: result.reason ?? null });
          break;
        }
        const state = result.ok ? "supported" : "not_supported";
        // A real answer ends the setup-failure streak for this key: the next setup failure is a new line.
        setupFailedLogged.delete(`${item.providerId}\u0000${item.version}\u0000${capability}`);
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

  // The gate a documentary stage is asked through before it spawns (SMA ap_caps/ap_caps_held): the spawn layer calls this
  // with the provider it is about to start; the answer is null (every documentary cell of the installed key is supported)
  // or the reason the spawn must refuse, which names the provider and the unproved cell.
  const SNAPSHOT_TTL_MS = 60_000;
  let snapshotCache: { at: number; versions: Map<string, string | null> } | null = null;
  async function cachedVersions(): Promise<Map<string, string | null>> {
    if (!snapshotCache || Date.now() - snapshotCache.at > SNAPSHOT_TTL_MS) snapshotCache = { at: Date.now(), versions: (await snapshot()).versions };
    return snapshotCache.versions;
  }
  async function documentaryProof(providerId: string): Promise<string | null> {
    const version = (await cachedVersions()).get(providerId);
    if (!version) return null;
    const receipts = listReceipts(db);
    // Only a red receipt holds (SMA ap_caps_held): a missing or stale one is observed, never refused, so a new adapter
    // version after a deploy stops nothing. The hold names the receipt and the command that re-runs the probe.
    const red = DOCUMENTARY_CELLS.find((cell) => capabilityState(receipts, providerId, version, cell) === "not_supported");
    return red ? `capability_unproven:${providerId}:${red} (receipt ${providerId} ${version} ${red}=not_supported; re-probe: bb lane-pilot capabilities --probe)` : null;
  }

  // Hold by default (SMA ap_caps/ap_caps_held): `capability.documentary_gate` = observe only logs; unset holds —
  // but only on a red receipt, so an install without one is exactly as before.
  const holds = (projectId: string | undefined): boolean => {
    const raw = projectId ? projectSettingValue(db, projectId, "capability.documentary_gate") : undefined;
    let value: unknown = raw;
    try { value = raw !== undefined ? JSON.parse(raw) : undefined; } catch { /* stored as a bare word */ }
    return value !== "observe" && value !== "off";
  };
  bindDocumentaryGate(bb, {
    deny: async (providerId, _model, projectId) => holds(projectId) ? documentaryProof(providerId) : null,
    // The offer a documentary pick is drawn from: the providers in use whose installed key has no red receipt
    // (an observed, missing or supported receipt counts the same — only red removes a provider).
    proved: async (projectId) => {
      if (!holds(projectId)) return null;
      const versions = await cachedVersions();
      const ok = new Set<string>();
      for (const [providerId, version] of versions)
        if (version && !(await documentaryProof(providerId))) ok.add(providerId);
      return ok;
    },
  });

  return { capabilities: { sweep, table, documentaryProof } };
}
export type CapabilitiesApi = ReturnType<typeof createCapabilities>["capabilities"];

export function mountCapabilities(ctx: ServerCore, api: CapabilitiesApi): void {
  scheduleIsolated(ctx.bb, "capability-sweep", "7 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.sweep().catch((cause: unknown) => ctx.log(`capability sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    // C1: once a month the capability table is reconciled and the drift is recorded in the log — adapters released since
    // their receipts and unproven cells. Facts only; no chat message (a sweep never wakes a PM thread).
    const monthKey = new Date().toISOString().slice(0, 7);
    if (!ctx.isDisposed() && claimDailySchedule(ctx.db, SANDBOX_PROJECT_ID, "capability-reconcile", monthKey)) {
      try {
        const table = await api.table();
        const receipts = listReceipts(ctx.db);
        for (const row of table) {
          const receipted = [...new Set(receipts.filter((r) => r.providerId === row.providerId).map((r) => r.version))];
          const unproven = Object.values(row.capabilities).filter((state) => state === "unproven").length;
          const drifted = row.version !== null && !receipted.includes(row.version);
          ctx.log(`capability reconcile ${monthKey}: ${row.providerId} adapter=${row.version ?? "none"}${drifted ? ` (new since receipts: ${receipted.join(", ") || "none"})` : ""} unproven=${unproven}`);
        }
      } catch (cause) { ctx.log(`capability reconcile failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
  }, { timeoutMs: 30 * 60_000 });
}
