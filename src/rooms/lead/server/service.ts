import { z } from "zod";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { writerExecutionSelection } from "@lane-pilot/models";

import type { ServerCore } from "../../contracts/server";
import { fullAccessSpawn, modelCatalogOf, resolveSpawnModel, scheduleIsolated, spawnUsageOf, warmSpawnUsage } from "../../platform/server";
import { stringAt } from "@lane-pilot/kit";
import { closeOwnerItem, closeOwnerItemsByPrefix, loadPushConfig, postOwnerItem } from "../../owner-waiting";
import { loadProjectSettings, saveProjectSetting } from "../../storage";
import { mentionContext } from "../../native-agent";
import { projectRoleField } from "../../runs/server";
import { storeNativeSelection } from "../../native-agent/server";
import { lanePilotProjectOrNotice } from "../../self-repair/server";
import { fireTimes } from "../../schedule";
import { LEAD_ID, LEAD_NAME, LEAD_TICK } from "../lead-agent";
import { examAll, type Verdict } from "../logic";
import { parseLeadSettings, type LeadSettings } from "../settings";
import { identityBlock, loadIdentity, writeRoadExport } from "./identity";
import { answerDecision, examRows, getDecision, labelDecision, listDecisions, openDecision, pendingLabelCount, pendingLabels, refineVerdict, type PendingLabel } from "./journal";
import { createLeadSchedule } from "./lead-schedule";
import { formatMemoryExam, MEMORY_EXAM_KEY, runMemoryExam, type MemoryExam } from "./memory-exam";
import { actsVia, applyExam, rightsView, type TierChange } from "./rights";
import { decideRoad, doneRoad, getRoad, rejectRoad, roadCounts, roadMarkdown, roadPayload, type RoadRow } from "./road";
import { architectPrompt, architectSeedOf, postArchitectHand, registerLeadTickActions, proposalDecisionId, proposalItemKey, seedForm, type ProposalDecision } from "./tick";
import { WORKFLOW_ARCHITECT_ID } from "../../workflow";
import { closeTick, getTick, listTicks, openTick, patchTick, sweepStaleTicks, type TickRow } from "./tick-store";

import type { DocsNightlyApi } from "../../docs/server/docs-nightly";
import type { PhaseIntake } from "../../phase/server/intake";
import type { WorkflowEngineApi } from "../../workflow/server/workflow";
import type { WorkflowTriggersApi } from "../../workflow/server/workflow-triggers-live";

import type { ScheduleService } from "../../schedule/server/schedule-service";

import type { RuleScanApi } from "../../self-repair/server/rule-scan";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  docsPlaces: DocsNightlyApi["docsPlaces"];
  lead: LeadApi;
  phaseIntake: PhaseIntake;
  ruleScan: RuleScanApi;
  schedules: ScheduleService;
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
}

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
/** Monday morning: one line on the owner's list with up to 20 judged rows to label (the judge's kappa is measured against his labels). */
export const LEAD_LABELS_CRON = "30 7 * * 1";
const LABELS_BATCH = 20;
/** Sunday before dawn: the memory exam (recall probes and the decision replay with an empty control), stored for the panel and `lead status`. */
export const LEAD_MEMORY_EXAM_CRON = "10 5 * * 0";
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
  /** Judged rows waiting for the owner's own label (up to 20, random order) and how many there are in all. */
  labels: { pending: number; rows: PendingLabel[] };
  /** The last memory exam (src/rooms/lead/server/memory-exam.ts), null before the first. */
  memoryExam: MemoryExam | null;
};

export function createLeadService(ctx: ServerCore, services: Services, migrations: readonly string[]) {
  const { db, bb } = ctx;

  const settings = (): LeadSettings => parseLeadSettings(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID));
  const timezone = () => loadPushConfig(db).timezone;

  async function homeProjectId(): Promise<string> {
    const own = settings().project;
    if (own) return own;
    const found = await lanePilotProjectOrNotice(db, bb, ctx.host);
    if (!found) throw new Error("lane_pilot_project_unresolved: self-repair:config has no projectId and no project source shares this repository's remote");
    return found.projectId;
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
      try { postOwnerItem(db, { key: `lead-tick:${tick.id}`, source: "lead", kind: "tick_error", projectId: null, wake: false, what: "Обход Штурмана прервался", why: `Запуск сценария ${run.status}${run.failedNode ? ` на шаге ${run.failedNode}` : ""}: ${(run.error ?? run.reason ?? "причина не записана").slice(0, 300)}`, evidence: [{ kind: "text", ref: tick.wf_run_id, label: "workflow run" }] }, now); } catch { /* informational */ }
    }
    return closed;
  }

  /** Every 15 minutes: stale receipts closed, a due tick started when the lead is on, ROAD.md exported once a day. */
  async function sweep(now: number = Date.now()): Promise<{ stale: string[]; started: string | null; exported: boolean }> {
    // A tick whose graph ended without its receipt (the agent step failed to start, the run was cancelled) is closed now, not after 90 minutes.
    const failed = failedTicks(now);
    const stale = [...failed, ...sweepStaleTicks(db, STALE_TICK_MS, now)];
    if (pendingLabelCount(db) === 0) closeOwnerItemsByPrefix(db, "lead-labels:", "janitor:labelled", now); // the Monday row asks for labels; none left, none asked (Gemini F-006.4)
    for (const id of stale) {
      if (failed.includes(id)) continue;
      try { postOwnerItem(db, { key: `lead-tick:${id}`, source: "lead", kind: "tick_no_receipt", projectId: null, wake: false, what: "Обход Штурмана завис", why: "Он начался больше полутора часов назад и не закрыл свой отчёт; подробности в запуске сценария.", evidence: [{ kind: "text", ref: getTick(db, id)?.wf_run_id ?? id, label: "workflow run" }] }, now); } catch { /* informational */ }
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
          what: change.to === "decides" ? `Штурман получил право решать сам: ${classRu(change.class)}` : `Штурман потерял право решать сам: ${classRu(change.class)}`,
          why: change.to === "decides" ? "Ночной экзамен: его прогнозы достаточно часто совпадали с вашими ответами, по всем правилам экзамена. Теперь такие решения он принимает без вас; каждое вы увидите здесь." : `Экзамен: ${change.reasons.join("; ") || "последние решения стали хуже"}. Такие решения снова ждут вашего ответа.`,
          evidence: [{ kind: "command", ref: "bb lane-pilot lead exam" }] }, now);
      } catch { /* informational */ }
    }
    await bb.storage.kv.set(EXAM_KEY, { at: now, changes }).catch((cause: unknown) => bb.log.warn?.(`lead: exam result not stored: ${cause instanceof Error ? cause.message : String(cause)}`));
    bb.log.info?.(`lead: exam ${exams.map((exam) => `${exam.class}=${exam.tier} n=${exam.n}`).join(", ") || "no rows"}; changes ${changes.length}`);
    return { exams, changes };
  }

  async function state(now: number = Date.now()): Promise<LeadState> {
    const current = settings();
    const identity = loadIdentity();
    const ticks = listTicks(db, 10);
    const counts = (split: string) => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_decision WHERE split=?").get(split) as { n: number }).n;
    // The hub kv answers `undefined` for a key never written, and the RPC layer refuses undefined anywhere in a result (lead_shadow, 0.1.448: HTTP 500 until the first exam).
    const lastExam = ((await bb.storage.kv.get(EXAM_KEY).catch(() => null)) ?? null) as { at: number; changes: TierChange[] } | null;
    const memoryExam = ((await bb.storage.kv.get(MEMORY_EXAM_KEY).catch(() => null)) ?? null) as MemoryExam | null;
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
      labels: { pending: pendingLabelCount(db), rows: pendingLabels(db, LABELS_BATCH) },
      memoryExam,
    };
  }

  /** The memory exam on demand or on its Sunday cron: two measurements with a control, stored under one key; nothing of it moves a right. */
  async function memoryExam(options: { limit?: number; recall?: boolean } = {}, now: number = Date.now()): Promise<MemoryExam> {
    const exam = await runMemoryExam(db, { ...options, settings: loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID) as never, now, migrations });
    await bb.storage.kv.set(MEMORY_EXAM_KEY, exam);
    bb.log.info(`lead memory exam: ${formatMemoryExam(exam).split("\n").slice(1, 3).join("; ")}`);
    return exam;
  }

  /** The owner's answer to a proposal (the button on his list, the CLI, the lead's chat on his word): the tree, the journal and the list move together. */
  async function decide(roadId: string, decision: ProposalDecision, text: string | undefined, by: string, now: number = Date.now()): Promise<{ ok: true; road: RoadRow; verdict: string | null; handover: Handover | null } | { ok: false; reason: string }> {
    const row = getRoad(db, roadId);
    if (!row) return { ok: false, reason: `no branch ${roadId}` };
    // «Да» again on an accepted branch retries only its hand-over (one start per key): a refused hand-over left it accepted with nothing
    // running and no way on (2026-11-03). The journal and the exam keep the first answer.
    if (row.state === "accepted" && decision === "yes") return { ok: true, road: row, verdict: null, handover: await handOverAccepted(row, by, now) };
    if (row.state !== "proposed") return { ok: false, reason: `branch ${roadId} is ${row.state}, not proposed` };
    decideRoad(db, roadId, decision, text, now);
    const decisionId = row.decision_id ?? proposalDecisionId(roadId);
    answerDecision(db, decisionId, { option: decision, ...(text ? { text } : {}) }, by, now);
    // A mismatch goes to the model judge at once: «later» to a predicted «yes» is a partial, not a miss.
    const verdict = await refineVerdict(db, decisionId, loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID) as never, now);
    closeOwnerItem(db, proposalItemKey(decisionId), by, now);
    const handover = decision === "yes" ? await handOverAccepted(row, by, now) : null;
    return { ok: true, road: getRoad(db, roadId)!, verdict, handover };
  }

  /**
   * A branch closed by hand (the chat's road_reject / road_done, the CLI): a proposed one also answers its journal row «no» and leaves
   * the owner's list, so no button outlives the branch (Astra F-006: a stale «да» used to return ok:false behind a green toast).
   */
  function settle(roadId: string, action: "reject" | "done", by: string, text: string | undefined, now: number = Date.now()): boolean {
    const row = getRoad(db, roadId);
    if (!row) return false;
    const ok = action === "reject" ? rejectRoad(db, roadId, text ?? "", by, now) : doneRoad(db, roadId, text, now);
    if (ok && row.state === "proposed" && row.decision_id) {
      answerDecision(db, row.decision_id, { option: "no", text: `${action} by ${by}${text ? `: ${text}` : ""}` }, by, now);
      closeOwnerItem(db, proposalItemKey(row.decision_id), by, now);
    }
    return ok;
  }

  /**
   * «Да» is a go, not a mark (the owner, 2026-11-01: his word must not die in a table): a branch of a project whose class acts through
   * the intake goes to the project's PM at once, the same way the act step hands an opened class over; the branch stays `accepted` either
   * way, and what stopped a hand-over is one quiet line on his list. A branch above projects, or a class that acts elsewhere, is a mark.
   */
  async function handOverAccepted(row: RoadRow, by: string, now: number): Promise<Handover> {
    const blocked = (reason: string): Handover => {
      postOwnerItem(db, { key: `lead-handover-blocked:${row.id}`, source: "lead", kind: "handover_blocked", projectId: row.project_id, wake: false,
        what: `Вы ответили «да», но работа не началась: ${row.title}`, why: `${reason}. Откройте чат проекта или заведите задачу вручную.`, evidence: [{ kind: "text", ref: row.id, label: "road" }] }, now);
      return { state: "blocked", reason };
    };
    const via = actsVia(row.class ?? "");
    if (via === "none") return { state: "skipped", reason: `class ${row.class ?? "?"} has no way to act` };
    // A process that needs a graph (a `process` branch carrying an architectSeed with form graph, G2) goes to the Workflow architect, not to
    // the PM intake: the service cannot start a chat, so the seed and the architect button land on the owner's list. The other four forms
    // (rule, reference, script, skill) go to the PM intake below with the seed's prompt: a writer writes the proposal from the helper threads.
    const seed = architectSeedOf(roadPayload(row));
    if (row.class === "process" && seed && seedForm(seed) === "graph") {
      postArchitectHand(db, { roadId: row.id, projectId: row.project_id ?? (await homeProjectId()), title: row.title, seed, kind: "handed" }, now);
      return { state: "started", via: "architect", id: WORKFLOW_ARCHITECT_ID };
    }
    if (!row.project_id) return { state: "skipped", reason: via === "schedule" ? "a schedule needs a project" : "a branch above projects has no PM to hand the work to" };
    if (via === "schedule") {
      // The schedule the proposal carried is created in the project's board through the schedule room's own save, as the lead.
      const made = await createLeadSchedule(services, { projectId: row.project_id, payload: roadPayload(row), roadId: row.id, by: `lead:${by}`, why: row.why });
      if (!made.ok) return blocked(made.reason);
      postOwnerItem(db, { key: `lead-handed:${row.id}`, source: "lead", kind: "handed", projectId: row.project_id, wake: false,
        what: `Ваше «да» пошло в работу: ${row.title}`, why: `Создано расписание «${made.name}» на доске проекта; там его можно снять или поставить на паузу.`, evidence: [{ kind: "text", ref: made.id, label: "schedule" }, { kind: "note", ref: row.id, label: "ветка" }] }, now);
      return { state: "started", via: "schedule", id: made.id };
    }
    try {
      const pm = await services.workflowTriggers.pmOf(row.project_id);
      if (!pm) return blocked("в проекте нет открытого чата Lane Pilot");
      const started = await services.phaseIntake.handOver({
        projectId: row.project_id, pmThreadId: pm.pmThreadId, runId: pm.runId, text: `${row.title}\n\n${row.why}${seed ? `\n\n${architectPrompt(seed, row.title)}` : ""}`, key: `lead:${row.id}`,
        origin: `Accepted by the owner («да», by: ${by}) on the lead's («Штурман») proposal: road tree branch ${row.id}, class ${row.class ?? "?"}.`,
      });
      if (!started.started) return blocked(started.reason);
      postOwnerItem(db, { key: `lead-handed:${row.id}`, source: "lead", kind: "handed", projectId: row.project_id, wake: false,
        what: `Ваше «да» пошло в работу: ${row.title}`, why: "Передано в проект, работа началась.", evidence: [{ kind: "text", ref: started.id, label: started.via }, { kind: "note", ref: row.id, label: "ветка" }] }, now);
      return { state: "started", via: started.via, id: started.id };
    } catch (cause) {
      return blocked(`передача не удалась: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 200));
    }
  }

  /** The owner's word on the switch itself is a decision of the journal (split design: nothing predicted it), so the record says when and by whom the lead was turned on. */
  function setEnabled(on: boolean, by: string, now: number = Date.now()): void {
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.enabled", on ? "on" : "off");
    const id = `lead:enabled:${now}`;
    openDecision(db, { id, surface: "lead", class: "process", situation: { question: "switch the lead's ticks on?", setting: "lead.enabled" }, options: ["on", "off"], split: "design" }, now);
    answerDecision(db, id, { option: on ? "on" : "off" }, by, now);
  }

  /** The owner's own label on a judged row: exact, partial or miss against the lead's guess; the exam's kappa is the judge against these. */
  function label(id: string, verdict: Exclude<Verdict, "deferred">, now: number = Date.now()): boolean {
    return labelDecision(db, id, verdict, now);
  }

  /**
   * Monday's line: up to 20 judged rows of the exam split the owner has not labelled, with the guess, his answer and the judge's word, and
   * the CLI to label each. One line a week (the key is the week), none when nothing waits; the panel's «Разметка» block has the buttons.
   */
  function labelsDue(now: number = Date.now()): { posted: boolean; pending: number } {
    const rows = pendingLabels(db, LABELS_BATCH);
    if (!rows.length) return { posted: false, pending: 0 };
    const week = (() => { const d = new Date(now); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); })();
    // The list line is clipped at 600 characters: it carries the count and three rows as a sample, the panel block carries all twenty.
    const line = (row: PendingLabel) => {
      const guess = row.prediction_json ? (JSON.parse(row.prediction_json) as { option: string | null }).option ?? "—" : "—";
      const answer = row.answer_json ? (JSON.parse(row.answer_json) as { option: string }).option : "—";
      return `${row.id}: прогноз ${guess}, ответ ${answer}, судья ${row.judge_verdict}`;
    };
    const { created } = postOwnerItem(db, {
      key: `lead-labels:${week}`, source: "lead", kind: "labels", projectId: null, wake: false,
      what: `Оцените ${rows.length} решений Штурмана: угадал ли он ваш ответ`,
      why: `Ваша оценка (совпал / отчасти / мимо) проверяет автоматического судью: пока оценок мало, Штурман не получит права решать сам. Блок «Разметка» на экране «Самоулучшение». Например: ${rows.slice(0, 3).map(line).join("; ")}.`,
      evidence: [{ kind: "command", ref: "bb lane-pilot lead label <id> exact|partial|miss" }],
    }, now);
    return { posted: created, pending: rows.length };
  }

  /** The owner's order of projects (`lead.priority`): ids as given, duplicates dropped; an empty list clears it. Not a journal row: the order is the owner's, not a decision the lead predicts. */
  function setPriority(ids: readonly string[]): string[] {
    const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.priority", clean.join(","));
    return clean;
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
      // The lead's chat answers from its brief and the lane_pilot_* tools; the «lead» profile keeps that plugin only.
      ...projectRoleField(bb, db, projectId, picked.providerId, "lead"),
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

  return { settings, homeProjectId, nextTickAt, due, runTick, sweep, exam, memoryExam, state, decide, settle, label, labelsDue, setEnabled, setPriority, chatStart: chatStartOnce, decisionOf: (id: string) => getDecision(db, id) };
}
export type LeadApi = ReturnType<typeof createLeadService>;
/** What became of an accepted branch: handed to the project (`started`), stopped with a reason the owner sees (`blocked`), or a mark only (`skipped`). */
export type Handover = { state: "started"; via: string; id: string } | { state: "skipped" | "blocked"; reason: string };

/**
 * After the services are built: the tick's code steps go on the engine (the service only starts the graph), then the crons: the sweep every
 * 15 minutes (the tick's own cron is read inside it, so a changed setting needs no reload) and the exam at 04:40 hub time.
 */
export function mountLead(ctx: ServerCore, services: Services): void {
  const lead = services.lead;
  registerLeadTickActions(services.workflowEngine, ctx, services);
  scheduleIsolated(ctx.bb, "lead-sweep", LEAD_SWEEP_CRON, () => lead.sweep().then(() => undefined), { timeoutMs: 10 * 60_000 });
  scheduleIsolated(ctx.bb, "lead-exam", LEAD_EXAM_CRON, () => lead.exam().then(() => undefined), { timeoutMs: 5 * 60_000 });
  scheduleIsolated(ctx.bb, "lead-labels", LEAD_LABELS_CRON, async () => { lead.labelsDue(); }, { timeoutMs: 60_000 });
  scheduleIsolated(ctx.bb, "lead-memory-exam", LEAD_MEMORY_EXAM_CRON, () => lead.memoryExam().then(() => undefined), { timeoutMs: 15 * 60_000 });
}

/** A decision class in the owner's words (the rows on «Ждут владельца»); an unknown class keeps its id. */
const CLASS_RU: Record<string, string> = { next_step: "следующий шаг", schedule: "расписания", landing: "приземление задач", process: "ход этапов", defer: "отложить", money: "деньги", external: "внешние действия" };
const classRu = (cls: string): string => CLASS_RU[cls] ?? cls;
