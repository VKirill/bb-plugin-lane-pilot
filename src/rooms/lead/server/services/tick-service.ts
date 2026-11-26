import { GLOBAL_SETTINGS_PROJECT_ID, SETTING_EPISODES_PROCESS_KEY } from "@lane-pilot/settings-catalog";
import { listGraphlessErrandRows } from "@lane-pilot/workflow-engine";
import type { RoadEvidence, RoadRow } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { errandStem, errandTitle, routeConfidence } from "../../../errands";
import { taskMemoryContext } from "../../../memory/server";
import { collectOwnerWaiting, isSandboxProject, loadPushConfig } from "../../../owner-waiting";
import type { WorkflowEngineApi } from "../../../platform/server";
import { specialistSnapshot } from "../../../specialist/server";
import { countAcceptedForProject, countProjectTasksSince, errandEpisodeColumns, listErrandEpisodeFacts, listErrandEpisodeTraces, loadProjectSettings, runStateCounts, type LanePilotDatabase } from "../../../storage";
import { budgetSpentSweep, type ThreadToolTraceEntry } from "../../../writer/server";
import { loadIdentity } from "../../identity";
import type { GraphlessRow, HubSnapshot } from "../../models/tick";
import type { LeadSettings } from "../../settings";
import { addRoad, getRoad, listRoad, roadCounts } from "../repositories/road-repository";
import { dayStart, listTicks, spentSince } from "../repositories/tick-repository";
import { attachNearest } from "./nearest";
import { OWNER_ITEM_SWEEPS } from "./sweeps";

const USD = 1_000_000;
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The fields of the services bag this file reads, typed by the rooms that own them. */
export interface TickServices {
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  runBudgetFor?: import("../../../writer/server").WriterStateApi["runBudgetFor"];
}

/** The root of a project's branches when a proposal names no parent: one direction per project, made on first use. */
export function projectRoot(db: LanePilotDatabase, projectId: string | null, projectName: string | null, now: number): RoadRow {
  const id = `dir:${projectId ?? "hub"}`;
  return getRoad(db, id) ?? addRoad(db, { id, projectId, title: projectId ? `${projectName ?? projectId}: directions` : "Above projects", kind: "direction", source: "lead", why: "the root the lead files a project's branches under when a proposal names no parent" }, now);
}

/** The episode columns `graphlessErrands` reads; the process-key pair arrives with a parallel stream, so each is checked on its own. */
type EpisodeColumns = { processKey: boolean; processKeyProposed: boolean; provider: boolean; model: boolean; trace: boolean };

function episodeColumns(db: LanePilotDatabase): EpisodeColumns {
  const none: EpisodeColumns = { processKey: false, processKeyProposed: false, provider: false, model: false, trace: false };
  try {
    const names = errandEpisodeColumns(db);
    return { processKey: names.has("process_key"), processKeyProposed: names.has("process_key_proposed"), provider: names.has("provider_id"), model: names.has("model"), trace: names.has("trace_json") };
  } catch { return none; }
}

type EpisodeFacts = { processKey: string | null; processKeyProposed: string | null; provider: string | null };

/** Facts of the group's episodes, one batched read per chunk of run ids; run_id -> facts (first version wins, the keys do not change between extractors). */
function episodeFacts(db: LanePilotDatabase, runIds: string[], columns: EpisodeColumns): Map<string, EpisodeFacts> {
  const facts = new Map<string, EpisodeFacts>();
  if (!runIds.length || (!columns.processKey && !columns.processKeyProposed && !columns.provider && !columns.model)) return facts;
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = [...listErrandEpisodeFacts(db, chunk, columns).entries()].map(([, row]) => row);
    for (const row of rows) {
      const runId = row.run_id;
      if (typeof runId !== "string" || facts.has(runId)) continue;
      facts.set(runId, {
        processKey: typeof row.process_key === "string" && row.process_key ? row.process_key : null,
        processKeyProposed: typeof row.process_key_proposed === "string" && row.process_key_proposed ? row.process_key_proposed : null,
        provider: typeof row.provider_id === "string" && row.provider_id ? row.provider_id : typeof row.model === "string" && row.model ? row.model : null,
      });
    }
  }
  return facts;
}

/** Trace json of the group's episodes, same chunked read; run_id -> parsed trace (null when absent or unreadable). */
function episodeTraces(db: LanePilotDatabase, runIds: string[], columns: EpisodeColumns): Map<string, ThreadToolTraceEntry[] | null> {
  const traces = new Map<string, ThreadToolTraceEntry[] | null>();
  if (!columns.trace) return traces;
  for (let at = 0; at < runIds.length; at += 400) {
    const chunk = runIds.slice(at, at + 400);
    const rows = [...listErrandEpisodeTraces(db, chunk).entries()].map(([run_id, trace_json]) => ({ run_id, trace_json }));
    for (const row of rows) {
      if (traces.has(row.run_id)) continue;
      try { traces.set(row.run_id, row.trace_json ? (JSON.parse(row.trace_json) as ThreadToolTraceEntry[]) : null); } catch { traces.set(row.run_id, null); }
    }
  }
  return traces;
}

/**
 * The repeated command sequence of a group: episodes whose tool+argsSha256 sequence is identical, in at least three of them.
 * `ok` when every call of the repeated sequence succeeded, `failed` when one failed (the trap the runs keep hitting), null below three.
 */
function repeatedTrace(traces: Array<ThreadToolTraceEntry[] | null>): "ok" | "failed" | null {
  const counts = new Map<string, { n: number; ok: boolean }>();
  for (const trace of traces) {
    if (!Array.isArray(trace) || !trace.length) continue;
    const key = trace.map((entry) => `${entry.tool}:${entry.argsSha256}`).join("|");
    const ok = trace.every((entry) => entry.ok);
    const cur = counts.get(key);
    counts.set(key, { n: (cur?.n ?? 0) + 1, ok: (cur?.ok ?? true) && ok });
  }
  const best = [...counts.values()].filter((entry) => entry.n >= 3).sort((a, b) => b.n - a.n)[0];
  return best ? (best.ok ? "ok" : "failed") : null;
}

/** `episodes.process_key` is active only on an explicit word; absent or «shadow» keeps the proposed key in charge. */
function processKeyActive(db: LanePilotDatabase): boolean {
  const value = loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)[SETTING_EPISODES_PROCESS_KEY];
  return value === "active" || value === true || value === 1 || value === "on";
}

/** Errand runs of the last 30 days in the lead's zone with no route or a route under 90 confidence, grouped by (kind, process key); groups of one are dropped. */
export function graphlessErrands(db: LanePilotDatabase, zoneIds: ReadonlySet<string>, since: number): GraphlessRow[] {
  const rows = listGraphlessErrandRows(db as never, since) as
    Array<{ id: string; project_id: string | null; inputs_json: string; cost_micro_usd: number | null; thread_id: string | null }>;
  const candidates: Array<{ runId: string; projectId: string | null; kind: string; title: string; cost: number; threadId: string | null }> = [];
  for (const row of rows) {
    if (row.project_id !== null && !zoneIds.has(row.project_id)) continue;
    let inputs: Record<string, unknown> = {};
    try { inputs = JSON.parse(row.inputs_json) as Record<string, unknown>; } catch { continue; }
    const routeTop = typeof inputs.routeTop === "string" ? inputs.routeTop.trim() : "";
    if (routeTop && routeConfidence(routeTop) >= 90) continue;
    const kind = typeof inputs.kind === "string" && inputs.kind ? inputs.kind : "errand";
    const title = errandTitle(inputs);
    if (!errandStem(title)) continue;
    candidates.push({ runId: row.id, projectId: row.project_id, kind, title, cost: (row.cost_micro_usd ?? 0) / USD, threadId: row.thread_id });
  }
  if (!candidates.length) return [];
  const columns = episodeColumns(db);
  const facts = episodeFacts(db, candidates.map((run) => run.runId), columns);
  const active = processKeyActive(db);
  const groups = new Map<string, GraphlessRow & { seen: Set<string>; runIds: string[]; providers: Set<string> }>();
  for (const run of candidates) {
    const stem = errandStem(run.title);
    const episode = facts.get(run.runId);
    // Active: the confirmed process key, the proposed one as the bridge, the title stem last. Shadow: proposed, then stem.
    const key = active ? (episode?.processKey || episode?.processKeyProposed || stem) : (episode?.processKeyProposed || stem);
    const groupKey = `${run.kind}:${key}`;
    let group = groups.get(groupKey);
    if (!group) { group = { key: groupKey, kind: run.kind, count30d: 0, costUsd: 0, projects: [], samples: [], threadIds: [], seen: new Set(), runIds: [], providers: new Set(), nearest: [], hint: null, signals: { repeatedTrace: null, providers: 0 } }; groups.set(groupKey, group); }
    group.count30d += 1;
    group.costUsd += run.cost;
    if (run.projectId && !group.projects.includes(run.projectId)) group.projects.push(run.projectId);
    if (group.samples.length < 3) group.samples.push(run.title);
    if (run.threadId && !group.seen.has(run.threadId)) { group.seen.add(run.threadId); group.threadIds.push(run.threadId); }
    group.runIds.push(run.runId);
    if (episode?.provider) group.providers.add(episode.provider);
  }
  return [...groups.values()].filter((group) => group.count30d >= 2).sort((a, b) => b.count30d - a.count30d).slice(0, 10)
    .map(({ seen: _seen, runIds, providers, ...row }) => {
      const traces = episodeTraces(db, runIds, columns);
      return { ...row, signals: { repeatedTrace: repeatedTrace(runIds.map((runId) => traces.get(runId) ?? null)), providers: providers.size } };
    });
}

/** Every project of the hub; a host without the call (a test harness, an old core) is an empty hub, not a failed tick. */
export async function listProjects(bb: ServerCore["bb"]): Promise<Array<{ id: string; name: string }>> {
  try { return await (bb.sdk.projects.list({ includePersonal: true }) as Promise<Array<{ id: string; name: string }>>); } catch { return []; }
}

export async function hubSnapshot(ctx: Pick<ServerCore, "db" | "bb">, settings: LeadSettings, input: { tickId: string; trigger: string }, now: number = Date.now(), services?: TickServices): Promise<HubSnapshot> {
  const { db, bb } = ctx;
  const identity = loadIdentity();
  const zone = loadPushConfig(db).timezone;
  const spent = spentSince(db, dayStart(now, zone));
  const listed = await listProjects(bb);
  // A sandbox or bench project is out of the zone unless the owner names it: the owner's list refuses its rows, so a proposal on it was a card nobody saw (hub, tick 2026-11-01 13:31).
  const inZone = settings.projects.length ? listed.filter((project) => settings.projects.includes(project.id)) : listed.filter((project) => !isSandboxProject(project.id));
  // The owner's order (`lead.priority`) ranks the projects of the brief; the ranked come first, the rest keep the hub's order. The map
  // itself (names, runs, phases, memory) is read here every tick, so LEAD.md holds no list of projects that would go stale.
  const rankOf = (id: string): number | null => { const at = settings.priority.indexOf(id); return at === -1 ? null : at + 1; };
  const ordered = [...inZone].sort((a, b) => (rankOf(a.id) ?? Number.MAX_SAFE_INTEGER) - (rankOf(b.id) ?? Number.MAX_SAFE_INTEGER));
  const since30 = now - 30 * 86_400_000;
  // The brief carries at most 12 project maps a tick; a larger zone rotates by tick so every project gets its turn within a few ticks,
  // and the brief says how many wait (Astra F-013: the thirteenth project used to be cut silently, forever).
  const WINDOW = 12;
  const shift = ordered.length > WINDOW ? (spent.ticks * WINDOW) % ordered.length : 0;
  const windowed = [...ordered.slice(shift), ...ordered.slice(0, shift)].slice(0, WINDOW);
  const omitted = ordered.length - windowed.length;
  const zoneIds = new Set(inZone.map((project) => project.id));
  const projects = windowed.map((project) => {
    const runs = runStateCounts(db, project.id);
    const tasks30d = countProjectTasksSince(db, project.id, since30);
    const accepted30d = countAcceptedForProject(db, project.id, since30);
    const livePhases: Array<{ id: string; title: string; stage: string }> = [];
    const memory = clip(taskMemoryContext(db, project.id, null, "what the project should do next; open problems; the owner's priorities"), 1_800);
    return { id: project.id, name: project.name, priority: rankOf(project.id), runs, tasks30d, accepted30d, livePhases, memory };
  });
  // The tree and the open proposals are read within the zone too: a branch of a project outside it is not the lead's business this tick (Astra F-010).
  const open = listRoad(db, { state: ["open", "later", "proposed"], limit: 60 }).filter((row) => row.project_id === null || zoneIds.has(row.project_id)).map((row) => ({
    id: row.id, parent_id: row.parent_id, project_id: row.project_id, title: row.title, kind: row.kind, state: row.state, source: row.source, why: clip(row.why, 400), class: row.class, cost_estimate: row.cost_estimate,
    evidence: (JSON.parse(row.evidence_json) as RoadEvidence[]).slice(0, 4),
  }));
  const waiting = collectOwnerWaiting(db, now, [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)]).items.filter((item) => item.projectId === null || zoneIds.has(item.projectId)).slice(0, 15).map((item) => ({ key: item.key, source: item.source, kind: item.kind, projectId: item.projectId, what: clip(item.what, 200) }));
  const lastTicks = listTicks(db, 5).filter((row) => row.id !== input.tickId).map((row) => ({
    id: row.id, startedAt: row.started_at, status: row.status, proposed: (JSON.parse(row.proposed_json ?? "[]") as unknown[]).length, costUsd: (row.cost_micro_usd ?? 0) / USD,
  }));
  const graphless = graphlessErrands(db, zoneIds, since30);
  // The nearest catalog units and the form hint are read once per tick, only when the rooms that own the catalogs are wired.
  if (services?.workflowCatalog && graphless.length) {
    await attachNearest({ bb, workflowCatalog: services.workflowCatalog, fallbackProjectId: settings.project || null, rows: graphless, log: (message) => bb.log.warn(message) });
  }
  return {
    at: new Date(now).toISOString(), tickId: input.tickId, trigger: input.trigger,
    settings: { projects: settings.projects, priority: settings.priority, budgetDailyUsd: settings.budgetDailyUsd, maxProposals: settings.maxProposals },
    budget: { spentUsd: spent.costMicroUsd / USD, leftUsd: Math.max(0, settings.budgetDailyUsd - spent.costMicroUsd / USD), ticksToday: spent.ticks },
    identity: { sha: identity.sha, path: identity.path, seeded: identity.seeded },
    projects, omitted, zone: settings.projects.length ? [...zoneIds] : null, road: { counts: roadCounts(db), open },
    proposalsOpen: open.filter((item) => item.state === "proposed").length,
    waiting, lastTicks,
    graphless, specialists: specialistSnapshot(db, undefined, now),
  };
}
