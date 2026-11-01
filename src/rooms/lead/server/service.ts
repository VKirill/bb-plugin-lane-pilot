import { z } from "zod";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { writerExecutionSelection } from "@lane-pilot/models";
import type { ServerCore, Services } from "../../core/server";
import { fullAccessSpawn, modelCatalogOf, resolveSpawnModel, scheduleIsolated, spawnUsageOf, stringAt, warmSpawnUsage } from "../../core/server";
import { closeOwnerItem, loadPushConfig, postOwnerItem } from "../../owner-waiting";
import { loadProjectSettings, saveProjectSetting } from "../../storage";
import { mentionContext } from "../../native-agent";
import { storeNativeSelection } from "../../native-agent/server";
import { CONFIG_KEY, SELF_REPAIR_DEFAULTS } from "../../self-repair/server";
import { fireTimes } from "../../schedule";
import { LEAD_ID, LEAD_NAME, LEAD_TICK } from "../lead-agent";
import { examAll } from "../logic";
import { parseLeadSettings, type LeadSettings } from "../settings";
import { identityBlock, loadIdentity, writeRoadExport } from "./identity";
import { answerDecision, examRows, getDecision, listDecisions, openDecision } from "./journal";
import { applyExam, rightsView, type TierChange } from "./rights";
import { decideRoad, getRoad, roadCounts, roadMarkdown, type RoadRow } from "./road";
import { registerLeadTickActions, proposalDecisionId, proposalItemKey, type ProposalDecision } from "./tick";
import { closeTick, getTick, listTicks, openTick, patchTick, sweepStaleTicks, type TickRow } from "./tick-store";

/**
 * The lead's service (roadmap §2.3, §2.5): the tick on its cron, the nightly exam of the rights, the daily export of ROAD.md, the owner's
 * answers to proposals, the state the panel and the CLI show, and the lead's chat. The tick itself is the graph `lead-tick`
 * (workflows/lead-tick.json; its code steps are tick.ts). Crons are mounted by `mountLead` from server.ts so a test can build the
 * service without a scheduler.
 */
const STALE_TICK_MS = 90 * 60_000;
const ROAD_EXPORT_KEY = "lead:road-exported";
const EXAM_KEY = "lead:exam";
export const LEAD_SWEEP_CRON = "*/15 * * * *";
export const LEAD_EXAM_CRON = "40 4 * * *";
const DEAD_STATUSES = new Set(["error", "stopped"]);

export type LeadState = {
  generatedAt: number;
  settings: LeadSettings;
  homeProjectId: string;
  identity: { sha: string; path: string; bytes: number; seeded: boolean };
  nextTickAt: number | null;
  running: TickRow | null;
  ticks: TickRow[];
  road: Record<string, number>;
  proposalsOpen: number;
  rights: ReturnType<typeof rightsView>;
  exam: ReturnType<typeof examAll>;
  journal: { total: number; exam: number; backtest: number };
  lastExam: { at: number; changes: TierChange[] } | null;
};

export function createLeadService(ctx: ServerCore, services: Services) {
  const { db, bb } = ctx;

  const settings = (): LeadSettings => parseLeadSettings(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID));
  const timezone = () => loadPushConfig(db).timezone;

  async function homeProjectId(): Promise<string> {
    const own = settings().project;
    if (own) return own;
    const raw = await bb.storage.kv.get(CONFIG_KEY).catch(() => null) as { projectId?: unknown } | null;
    return typeof raw?.projectId === "string" && raw.projectId ? raw.projectId : SELF_REPAIR_DEFAULTS.projectId;
  }

  /** The next time the lead's cron fires after `afterMs`, in the owner's time zone; null when the cron is unreadable. */
  function nextTickAt(afterMs: number): number | null {
    try { return fireTimes(settings().tickCron, timezone(), afterMs, { limit: 1 })[0] ?? null; } catch { return null; }
  }

  /** Due when a fire time of the cron lies between the last tick's start (or a day ago) and now. */
  function due(now: number): boolean {
    const last = listTicks(db, 1)[0]?.started_at ?? now - 86_400_000;
    try { return fireTimes(settings().tickCron, timezone(), last, { untilMs: now, limit: 1 }).length > 0; } catch { return false; }
  }

  async function runTick(trigger: "cron" | "manual", now: number = Date.now()): Promise<{ ok: true; tickId: string; runId: string } | { ok: false; reason: string; tickId?: string }> {
    const running = listTicks(db, 3).find((row) => row.status === "running" && now - row.started_at < STALE_TICK_MS);
    if (running) return { ok: false, reason: `tick ${running.id} is still running (started ${new Date(running.started_at).toISOString()})`, tickId: running.id };
    const tick = openTick(db, trigger, now);
    try {
      const projectId = await homeProjectId();
      const result = await services.workflowTriggers.start({ projectId, workflowId: LEAD_TICK, source: "manual", key: `lead-tick:${tick.id}`, inputs: { tickId: tick.id, trigger }, detached: true });
      if (!result.ok) { closeTick(db, tick.id, "error", now); ctx.log(`lead tick ${tick.id} not started: ${result.reason}: ${result.message}`); return { ok: false, reason: `${result.reason}: ${result.message}`, tickId: tick.id }; }
      patchTick(db, tick.id, { wf_run_id: result.runId });
      return { ok: true, tickId: tick.id, runId: result.runId };
    } catch (cause) {
      closeTick(db, tick.id, "error", now);
      const message = cause instanceof Error ? cause.message : String(cause);
      ctx.log(`lead tick ${tick.id} failed to start: ${message}`);
      return { ok: false, reason: message, tickId: tick.id };
    }
  }

  function failedTicks(now: number): string[] {
    const closed: string[] = [];
    for (const tick of listTicks(db, 5)) {
      if (tick.status !== "running" || !tick.wf_run_id) continue;
      const run = services.workflowEngine.get(tick.wf_run_id);
      if (!run || (run.status !== "failed" && run.status !== "canceled")) continue;
      closeTick(db, tick.id, "error", now);
      closed.push(tick.id);
      try { postOwnerItem(db, { key: `lead-tick:${tick.id}`, source: "lead", kind: "tick_error", projectId: null, wake: false, what: `Тик Штурмана ${tick.id} не дошёл до квитанции`, why: `The workflow run ${run.status}${run.failedNode ? ` at ${run.failedNode}` : ""}: ${(run.error ?? run.reason ?? "no reason recorded").slice(0, 300)}`, evidence: [{ kind: "text", ref: tick.wf_run_id, label: "workflow run" }] }, now); } catch { /* informational */ }
    }
    return closed;
  }

  /** Every 15 minutes: stale receipts closed, a due tick started when the lead is on, ROAD.md exported once a day. */
  async function sweep(now: number = Date.now()): Promise<{ stale: string[]; started: string | null; exported: boolean }> {
    // A tick whose graph ended without its receipt (the agent step failed to start, the run was cancelled) is closed now, not after 90 minutes.
    const failed = failedTicks(now);
    const stale = [...failed, ...sweepStaleTicks(db, STALE_TICK_MS, now)];
    for (const id of stale) {
      if (failed.includes(id)) continue;
      try { postOwnerItem(db, { key: `lead-tick:${id}`, source: "lead", kind: "tick_no_receipt", projectId: null, wake: false, what: `Тик Штурмана ${id} без квитанции`, why: "The tick started more than 90 minutes ago and never closed its receipt; see the workflow run.", evidence: [{ kind: "text", ref: getTick(db, id)?.wf_run_id ?? id, label: "workflow run" }] }, now); } catch { /* informational */ }
    }
    let started: string | null = null;
    if (settings().enabled && due(now)) { const result = await runTick("cron", now); started = result.ok ? result.tickId : null; }
    const day = new Date(now).toISOString().slice(0, 10);
    let exported = false;
    const last = await bb.storage.kv.get(ROAD_EXPORT_KEY).catch(() => null);
    if (last !== day) {
      try { writeRoadExport(roadMarkdown(db, now)); await bb.storage.kv.set(ROAD_EXPORT_KEY, day); exported = true; } catch (cause) { ctx.log(`lead: ROAD.md not exported: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return { stale, started, exported };
  }

  /** The nightly exam: the rights table moves by the rules of logic.ts; each change is one quiet line for the owner. */
  async function exam(now: number = Date.now()): Promise<{ exams: ReturnType<typeof examAll>; changes: TierChange[] }> {
    const exams = examAll(examRows(db));
    const changes = applyExam(db, exams, now);
    for (const change of changes) {
      try {
        postOwnerItem(db, { key: `lead-right:${change.class}:${now}`, source: "lead", kind: "right_changed", projectId: null, wake: false,
          what: change.to === "decides" ? `Штурман получил право решать в классе ${change.class}` : `Штурман потерял право решать в классе ${change.class}`,
          why: change.to === "decides" ? "The nightly exam over the decision journal met every rule (Wilson LB ≥ 0.8, coverage ≥ 0.5, N ≥ 20, kappa ≥ 0.6, no high-risk miss)." : `The exam: ${change.reasons.join("; ") || "the recent window degraded"}.`,
          evidence: [{ kind: "command", ref: "bb lane-pilot lead exam" }] }, now);
      } catch { /* informational */ }
    }
    await bb.storage.kv.set(EXAM_KEY, { at: now, changes }).catch(() => undefined);
    return { exams, changes };
  }

  async function state(now: number = Date.now()): Promise<LeadState> {
    const current = settings();
    const identity = loadIdentity();
    const ticks = listTicks(db, 10);
    const counts = (split: string) => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_decision WHERE split=?").get(split) as { n: number }).n;
    // The hub kv answers `undefined` for a key never written, and the RPC layer refuses undefined anywhere in a result (lead_shadow, 0.1.448: HTTP 500 until the first exam).
    const lastExam = ((await bb.storage.kv.get(EXAM_KEY).catch(() => null)) ?? null) as { at: number; changes: TierChange[] } | null;
    return {
      generatedAt: now, settings: current, homeProjectId: await homeProjectId(),
      identity: { sha: identity.sha, path: identity.path, bytes: identity.bytes, seeded: identity.seeded },
      nextTickAt: current.enabled ? nextTickAt(now) : null,
      running: ticks.find((row) => row.status === "running") ?? null, ticks,
      road: roadCounts(db),
      proposalsOpen: (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE source='lead' AND kind='proposal' AND state='open'").get() as { n: number }).n,
      rights: rightsView(db), exam: examAll(examRows(db)),
      journal: { total: listDecisions(db, { limit: 100_000 }).length, exam: counts("exam"), backtest: counts("backtest") },
      lastExam,
    };
  }

  /** The owner's answer to a proposal (the button on his list, the CLI, the lead's chat on his word): the tree, the journal and the list move together. */
  function decide(roadId: string, decision: ProposalDecision, text: string | undefined, by: string, now: number = Date.now()): { ok: true; road: RoadRow; verdict: string | null } | { ok: false; reason: string } {
    const row = getRoad(db, roadId);
    if (!row) return { ok: false, reason: `no branch ${roadId}` };
    if (row.state !== "proposed") return { ok: false, reason: `branch ${roadId} is ${row.state}, not proposed` };
    decideRoad(db, roadId, decision, text, now);
    const decisionId = row.decision_id ?? proposalDecisionId(roadId);
    const judged = answerDecision(db, decisionId, { option: decision, ...(text ? { text } : {}) }, by, now);
    closeOwnerItem(db, proposalItemKey(roadId), by, now);
    return { ok: true, road: getRoad(db, roadId)!, verdict: judged?.judge_verdict ?? null };
  }

  /** The owner's word on the switch itself is a decision of the journal (split design: nothing predicted it), so the record says when and by whom the lead was turned on. */
  function setEnabled(on: boolean, by: string, now: number = Date.now()): void {
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.enabled", on ? "on" : "off");
    const id = `lead:enabled:${now}`;
    openDecision(db, { id, surface: "lead", class: "process", situation: { question: "switch the lead's ticks on?", setting: "lead.enabled" }, options: ["on", "off"], split: "design" }, now);
    answerDecision(db, id, { option: on ? "on" : "off" }, by, now);
  }

  // --- the lead's chat (the architect's pattern: a visible thread in the home project's folder, the profile marker in a hidden part) ---
  const chatKey = (projectId: string) => `lead-chat-thread:${projectId}`;
  async function liveThread(projectId: string): Promise<string | null> {
    const threadId = await bb.storage.kv.get<string>(chatKey(projectId)).catch(() => null);
    if (typeof threadId !== "string" || !threadId) return null;
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null) as { archivedAt?: unknown } | null;
    if (!thread || thread.archivedAt || stringAt(thread, "projectId") !== projectId || DEAD_STATUSES.has(stringAt(thread, "status") ?? "")) return null;
    return threadId;
  }
  async function placeThread(threadId: string, projectId: string, folderId: string): Promise<void> {
    try { await bb.sdk.plugins.callRpc({ pluginId: "project-folders", method: "thread_place", input: { threadId, projectId, folderId }, outputSchema: z.object({ ok: z.literal(true) }) }); }
    catch (cause) { bb.log.warn(`lead: could not file @thread:${threadId} in section ${folderId}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }
  const inflight = new Map<string, Promise<{ threadId: string; projectId: string; reused: boolean }>>();

  async function chatStart(input: { sectionId?: string } = {}): Promise<{ threadId: string; projectId: string; reused: boolean }> {
    const projectId = await homeProjectId();
    const reused = await liveThread(projectId);
    if (reused) return { threadId: reused, projectId, reused: true };
    const places = await services.docsPlaces(projectId).catch(() => []);
    const root = places.find((place) => place.scopes.length === 0) ?? places[0];
    if (!root) throw new Error(`project ${projectId} has no source folder on a machine: set lead.project to a project that has one`);
    const { selection } = await storeNativeSelection(ctx, { projectId, agentId: LEAD_ID });
    const values = (await ctx.effectiveProjectSettings(projectId).catch(() => ({ values: {} }))).values;
    const usage = spawnUsageOf(ctx);
    await warmSpawnUsage(usage, null);
    const picked = resolveSpawnModel({ role: "lead", settings: values, catalog: modelCatalogOf(ctx).peek(), usage }); // the `lead` row of the role table (packages/models/src/role-models.ts)
    const identity = loadIdentity();
    const snapshot = await state();
    const brief = [
      identityBlock(identity),
      `The owner opened your chat from Lane Pilot (project ${projectId}). The road tree holds ${snapshot.road.open ?? 0} open, ${snapshot.road.proposed ?? 0} proposed, ${snapshot.road.accepted ?? 0} accepted, ${snapshot.road.done ?? 0} done and ${snapshot.road.rejected ?? 0} rejected branches; ${snapshot.proposalsOpen} proposal(s) wait on his list; ticks are ${snapshot.settings.enabled ? "on" : "off"}. Open in Russian: one or two sentences on where the road stands and the one thing you would propose first, then one question.`,
    ].join("\n\n");
    const part = (text: string, hide: boolean) => ({ type: "text" as const, text, mentions: [] as [], ...(hide ? { visibility: "agent-only" as const } : {}) });
    const spawned = await fullAccessSpawn(bb, {
      projectId,
      ...writerExecutionSelection(picked.providerId, picked.model, picked.reasoningEffort, "default"),
      title: LEAD_NAME.ru,
      input: [part("Чат Штурмана.", false), part(`${mentionContext(selection)}\n\n${brief}`, true)],
      environment: { type: "host", hostId: root.hostId, workspace: { type: "unmanaged", path: root.path } },
      visibility: "visible",
      pluginMetadata: { role: LEAD_ID, spawnId: `lead-chat:${projectId}`, leadProjectId: projectId },
    } as unknown as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("threads.spawn returned no thread id for the lead's chat");
    await bb.storage.kv.set(chatKey(projectId), threadId);
    if (input.sectionId) await placeThread(threadId, projectId, input.sectionId);
    return { threadId, projectId, reused: false };
  }
  const chatStartOnce = (input: { sectionId?: string } = {}) => {
    const pending = inflight.get("chat");
    if (pending) return pending;
    const run = chatStart(input).finally(() => inflight.delete("chat"));
    inflight.set("chat", run);
    return run;
  };

  return { settings, homeProjectId, nextTickAt, due, runTick, sweep, exam, state, decide, setEnabled, chatStart: chatStartOnce, decisionOf: (id: string) => getDecision(db, id) };
}
export type LeadApi = ReturnType<typeof createLeadService>;

/**
 * After the services are built: the tick's code steps go on the engine (the service only starts the graph), then the crons: the sweep every
 * 15 minutes (the tick's own cron is read inside it, so a changed setting needs no reload) and the exam at 04:40 hub time.
 */
export function mountLead(ctx: ServerCore, services: Services): void {
  const lead = services.lead;
  registerLeadTickActions(services.workflowEngine, ctx, services);
  scheduleIsolated(ctx.bb, "lead-sweep", LEAD_SWEEP_CRON, () => lead.sweep().then(() => undefined), { timeoutMs: 10 * 60_000 });
  scheduleIsolated(ctx.bb, "lead-exam", LEAD_EXAM_CRON, () => lead.exam().then(() => undefined), { timeoutMs: 5 * 60_000 });
}
