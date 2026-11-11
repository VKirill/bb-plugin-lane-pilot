import { breakerKey } from "@lane-pilot/resilience";
import { claimDailySchedule, listProviderSettingRows, listRunsWithPmThread, projectSettingValue } from "../../storage";
import { scheduleIsolated, bindDocumentaryGate } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { SANDBOX_PROJECT_ID } from "../../contracts";
import { CAPABILITIES, DOCUMENTARY_CELLS, adapterVersions, capabilityState, capabilityTable, dueProbes, probeSetupFailed, providersInUse, receiptKey, type Capability } from "../logic";
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
  let snapshotCache: { at: number; inUse: Map<string, string>; versions: Map<string, string | null> } | null = null;
  async function cachedSnapshot(): Promise<{ inUse: Map<string, string>; versions: Map<string, string | null> }> {
    if (!snapshotCache || Date.now() - snapshotCache.at > SNAPSHOT_TTL_MS) snapshotCache = { at: Date.now(), ...(await snapshot()) };
    return snapshotCache;
  }

  /** One bounded probe per unproven documentary cell, deduplicated per receipt key; returns why the probe could not run, or null. */
  const gateProbing = new Map<string, Promise<string | null>>();
  function gateProbe(providerId: string, version: string, cells: readonly Capability[]): Promise<string | null> {
    const key = `${providerId} ${version}`;
    const running = gateProbing.get(key);
    if (running) return running;
    const probe = (async (): Promise<string | null> => {
      const runId = await probeRun();
      const model = (await cachedSnapshot()).inUse.get(providerId) ?? null;
      if (!runId || !model || typeof services.startHelperProbe !== "function")
        return !model ? `the provider is not in use` : !runId ? "no sandbox run with a PM chat to probe in" : "the probe is not available";
      for (const cell of cells) {
        const result = await services.startHelperProbe(SANDBOX_PROJECT_ID, runId, providerId, model, cell).catch((cause: unknown) => ({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }));
        // A probe that could not be set up says nothing about the adapter: no receipt, and the stage holds with that reason.
        if (!result.ok && probeSetupFailed(result.reason ?? null)) return result.reason ?? "the probe could not be set up";
        saveReceipt(db, { providerId, version, capability: cell, state: result.ok ? "supported" : "not_supported", model, detail: result.ok ? null : (result.reason ?? "no answer").slice(0, 500), at: Date.now() });
        ctx.log(`capability: documentary gate probed ${providerId} ${cell}=${result.ok ? "supported" : "not_supported"}${result.ok ? "" : ` (${result.reason ?? "no answer"})`}`);
        if (!result.ok) return null;
      }
      return null;
    })().finally(() => gateProbing.delete(key));
    gateProbing.set(key, probe);
    return probe;
  }

  async function documentaryProof(providerId: string): Promise<string | null> {
    const version = (await cachedSnapshot()).versions.get(providerId);
    if (!version) return null;
    const state = (cell: Capability) => capabilityState(listReceipts(db), providerId, version, cell);
    const hold = (cell: string, detail: string) => `capability_unproven:${providerId}:${cell} (${detail}; re-probe: bb lane-pilot capabilities --probe)`;
    const red = DOCUMENTARY_CELLS.find((cell) => state(cell) === "not_supported");
    if (red) return hold(red, `receipt ${providerId} ${version} ${red}=not_supported`);
    // A documentary stage runs only on proof (SMA ap_caps): a missing or stale receipt (a receipt's validity is its
    // key — version, model, settings and hooks — so a stale one simply misses this key) is probed once before the
    // stage runs. Green lets it run; red, or a probe that cannot run, holds it exactly like a red receipt.
    const unproven = DOCUMENTARY_CELLS.filter((cell) => state(cell) === "unproven");
    if (!unproven.length) return null;
    const couldNot = await gateProbe(providerId, version, unproven);
    const failed = DOCUMENTARY_CELLS.find((cell) => state(cell) === "not_supported");
    if (failed) return hold(failed, `receipt ${providerId} ${version} ${failed}=not_supported`);
    const missing = DOCUMENTARY_CELLS.find((cell) => state(cell) === "unproven");
    return missing ? hold(missing, `the probe could not run: ${couldNot ?? "no answer"}`) : null;
  }

  // Hold by default (SMA ap_caps/ap_caps_held): `capability.documentary_gate` = observe only logs; unset holds —
  // on a red receipt, and on a missing or stale one once its probe came back red or could not run.
  const holds = (projectId: string | undefined): boolean => {
    const raw = projectId ? projectSettingValue(db, projectId, "capability.documentary_gate") : undefined;
    let value: unknown = raw;
    try { value = raw !== undefined ? JSON.parse(raw) : undefined; } catch { /* stored as a bare word */ }
    return value !== "observe" && value !== "off";
  };
  bindDocumentaryGate(bb, {
    // The gate reads the provider table through BB; when that read fails the answer is «observed», never a failed spawn:
    // a hold needs a red receipt that was actually read.
    deny: async (providerId, _model, projectId) => holds(projectId) ? documentaryProof(providerId).catch((cause) => { ctx.log(`documentary gate: the provider table did not answer (${cause instanceof Error ? cause.message : String(cause)}); nothing is held`); return null; }) : null,
    // The offer a documentary pick is drawn from: every provider except one the proof pass refused (a red receipt, or
    // a missing/stale one its probe could not settle). A provider with no known version, or a proved one, stays — the
    // same rule `deny` applies, so the pick and the spawn never disagree.
    proved: async (projectId) => {
      if (!holds(projectId)) return null;
      const red = new Set<string>();
      try {
        for (const [providerId] of (await cachedSnapshot()).versions)
          if (await documentaryProof(providerId)) red.add(providerId);
      } catch { return null; }
      return red.size ? { has: (providerId: string) => !red.has(providerId) } : null;
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
