/** @vitest-environment jsdom */
// Region 9 · Person and window, batch g (n934 … n959 without n944): the work screens of the window rendered for real in jsdom — «Waiting for you», the new task
// and new batch forms, the task card (clarification, drawing, approach note, steps, timeline, spend, acceptance), the batch graph, the phase card with its
// discussion, acceptance, folder and pause, Today and its live feed, Memory. Each test drives what the person presses or reads and checks the whole text the
// screen shows or the whole call that goes out. What a screen drew or sent is also written down with observe(): the region scene sma_r09 compares it with the card.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { observe, recorder, text, type Table } from "./r09-world-g";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const button = (slot: { getByText: (text: string, options?: { selector: string }) => HTMLElement }, label: string) => slot.getByText(label, { selector: "button" }) as HTMLButtonElement;

// ---- n934 «Waiting for you» ----
const NOW = 1_800_000_000_000;
const decide = { projectId: "proj_1", id: "r1", action: "accept" };
const overnight = { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 };
const waiting = {
  generatedAt: NOW, counts: {}, overnight,
  items: [
    { key: "rule:proj_1:r1", source: "rule_proposal", kind: "rule_proposal", projectId: "proj_1", what: "Never edit lockfiles by hand", why: "A rule that goes into every writer prompt is yours to introduce.", since: NOW, wake: false,
      evidence: [{ kind: "attempt", ref: "att_1", label: "lockfile edited" }],
      actions: [{ id: "accept", label: "Accept the rule", cli: "echo accept", rpc: { method: "decide_rule_proposal", input: decide } }, { id: "reject", label: "Reject", cli: "echo reject", rpc: { method: "decide_rule_proposal", input: { ...decide, action: "reject" } } }] },
    { key: "deferral:dfr_b", source: "deferral_overdue", kind: "deferral_gate", projectId: null, what: "Gate X is put off", why: "The term you gave passed: the drill is red.", since: NOW - 3_600_000, wake: true,
      evidence: [{ kind: "command", ref: "bb lane-pilot deferrals --state overdue", label: "dfr_b" }],
      actions: [{ id: "term", label: "New term (by your message)", needsOwnerMessage: true, cli: "bb lane-pilot defer dfr_b --owner-msg <threadId>#<seq>" }] },
  ],
};

describe("region 9 · «Waiting for you»", () => {
  it("[sma:sc_wait_card] a card says what happened, why it is the owner's, and the action: a button where the plugin has the rpc (pressing it sends that rpc with its input), one plain «do» line where it has none; the command stays folded under «Details»", async () => {
    const { OwnerWaitingBoard } = await import("../../src/rooms/owner-waiting/ui");
    const r = recorder({ owner_waiting: () => waiting, owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }), decide_rule_proposal: () => ({ ok: true }) });
    const slot = await mount(() => <OwnerWaitingBoard projects={[{ id: "proj_1", name: "Shop" }]} />, r.table);
    await waitFor(() => expect(slot.getByTestId("owner-count").textContent).toBe("2"));
    const rule = slot.getByTestId("owner-item-rule:proj_1:r1");
    expect(text(rule.querySelector("p"))).toBe("Never edit lockfiles by hand");
    expect(text(rule.querySelector("span.shrink-0"))).toBe("Shop");
    expect(rule.textContent).toContain(`${t("ow_why")}: A rule that goes into every writer prompt is yours to introduce.`);
    const buttons = Array.from(rule.querySelectorAll("button[data-testid^='owner-run-']")).map((node) => text(node));
    expect(buttons).toEqual(["Accept the rule", "Reject"]);
    const term = slot.getByTestId("owner-item-deferral:dfr_b");
    expect(term.querySelector("button[data-testid^='owner-run-']")).toBeNull();
    expect(text(term.querySelector("p.text-xs.leading-5:not(:first-of-type)")) || term.textContent).toContain(`${t("ow_do")}: New term (by your message)`);
    expect(slot.getByTestId("owner-command-deferral:dfr_b-term").textContent).toContain("bb lane-pilot defer dfr_b --owner-msg <threadId>#<seq>");
    expect(slot.getByTestId("owner-details-deferral:dfr_b").closest("details")?.hasAttribute("open")).toBe(false);
    fireEvent.click(slot.getByTestId("owner-run-rule:proj_1:r1-accept"));
    await waitFor(() => expect(r.of("decide_rule_proposal")).toEqual([decide]));
    observe("n934", { what: `${text(rule.querySelector("p"))} (${text(rule.querySelector("span.shrink-0"))})`, buttons, commandOnlyCardButtons: term.querySelectorAll("button[data-testid^='owner-run-']").length, doLine: term.textContent!.includes(`${t("ow_do")}: New term (by your message)`), sent: r.of("decide_rule_proposal") });
  });
});

// ---- n935 / n946 the forms ----
async function tasksScreen(r: ReturnType<typeof recorder>, runId: string | null = null) {
  const { TasksScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
  return mount(() => <TasksScreen rpc={r.rpc as never} projectId="p1" runId={runId} hostId={null} />, r.table);
}

describe("region 9 · the new task and the new batch forms", () => {
  it("[sma:sc_new_task] one phrase proposes the title, the description and the promise by fixed rules, every field stays editable, a title with a path is refused with a hint, and Send queues the whole text through cockpit_request as a task", async () => {
    const r = recorder({ cockpit_request: () => ({}) });
    const slot = await tasksScreen(r);
    const phrase = "Show the date on the card. Keep the old layout; when the owner opens a card then the date is visible";
    fireEvent.change(slot.getByTestId("ck-new-task-phrase"), { target: { value: phrase } });
    const fields = { title: (slot.getByTestId("ck-new-task-title") as HTMLInputElement).value, what: (slot.getByLabelText(t("ckNewTaskWhat")) as HTMLTextAreaElement).value, promise: (slot.getByTestId("ck-new-task-promise") as HTMLTextAreaElement).value };
    expect(fields).toEqual({ title: "Show the date on the card", what: "Keep the old layout", promise: "When the owner opens a card, then the date is visible" });
    expect(slot.queryByTestId("ck-task-words")).toBeNull();
    fireEvent.click(button(within(slot.getByTestId("ck-new-task")), t("ckSend")));
    await waitFor(() => expect(r.of("cockpit_request")).toEqual([{ projectId: "p1", kind: "task", text: "Show the date on the card\n\nKeep the old layout\n\nОбещание:\nWhen the owner opens a card, then the date is visible" }]));
    // A title with a path is refused with the hint, and Send stays off.
    fireEvent.change(slot.getByTestId("ck-new-task-title"), { target: { value: "Fix src/app.ts" } });
    const hint = text(slot.getByTestId("ck-task-words"));
    expect(hint).toBe(t("ckSuggestWords").replace("{s}", "без путей и id: что увидит человек"));
    expect(button(within(slot.getByTestId("ck-new-task")), t("ckSend")).disabled).toBe(true);
    observe("n935", { fields, sent: r.of("cockpit_request")[0], hint, sendOffWithPath: true });
  });

  it("[sma:sc_new_batch] the lines of a batch are grouped by the area word they start with, the composition names the groups, and Send queues the grouped text as a batch", async () => {
    const r = recorder({ cockpit_request: () => ({}) });
    const slot = await tasksScreen(r);
    const panel = within(slot.getByTestId("ck-new-batch"));
    fireEvent.change(panel.getByLabelText(t("ckNewBatch")), { target: { value: "ui: Fix header\nui: Fix footer\napi: Add route" } });
    const composition = text(slot.getByTestId("ck-new-batch").querySelector("p.text-xs"));
    expect(composition).toBe(`${t("ckComposition").replace("{n}", "2")}: ui, api`);
    fireEvent.click(button(panel, t("ckSend")));
    await waitFor(() => expect(r.of("cockpit_request")).toEqual([{ projectId: "p1", kind: "batch", text: "ui:\nui: Fix header\nui: Fix footer\n\napi:\napi: Add route" }]));
    observe("n946", { composition, sent: r.of("cockpit_request")[0] });
  });
});

// ---- n937 / n938 / n945 the task detail: clarification, drawing, approach note ----
const VIEW = {
  displayTitle: "Task T", objective: "Make T work", area: null,
  clarify: { questions: ["Which file?"], answers: [{ question: "Which tone?", answer: "calm", by: "owner" }] },
  promise: { given: "a project", when: "the owner asks", then: "it answers" }, ownsPaths: ["a/**"], expectedOutputs: ["a/out.ts"], outOfScope: ["no docs"],
  blockers: [{ taskId: "dep", state: "blocked", reason: "no provider" }], drawing: [{ path: "docs/d.md", sha256: "s1" }], drawingOk: null, priority: "normal", heldUntil: null,
  approach: { approach: "Patch the form first", lesson: "tests first" },
};
async function openTask(view: Record<string, unknown>, extra: Table = {}) {
  const r = recorder({ cockpit_task: () => view, cockpit_task_correct: () => ({}), cockpit_task_drawing_ok: () => ({}), ...extra });
  const slot = await tasksScreen(r, "run1");
  fireEvent.change(slot.getByPlaceholderText(t("ckTaskLookup")), { target: { value: "t1" } });
  fireEvent.click(button(slot, t("ckTaskOpen")));
  const detail = await slot.findByTestId("ck-task-detail");
  return { slot, r, detail };
}

describe("region 9 · the task detail", () => {
  it("[sma:sc_clarify] the work clarification shows the promise, how to repeat it, the files, what is not part of the work, what blocks it and the questions with their answers; «Fix» sends the correction through the PM only when it has words", async () => {
    const { slot, r, detail } = await openTask(VIEW);
    expect(text(slot.getByTestId("ck-promise").querySelectorAll("p")[0]!)).toBe(`${t("ckPromise")}: it answers`);
    expect(text(slot.getByTestId("ck-promise").querySelectorAll("p")[1]!)).toBe(`${t("ckReproduce")}: a project · the owner asks`);
    const lists = Array.from(detail.querySelectorAll("details")).map((node) => [text(node.querySelector("summary")), Array.from(node.querySelectorAll("li, p")).map((item) => text(item))]);
    expect(lists).toEqual([[t("ckFiles"), ["a/**", "→ a/out.ts"]], [t("ckOutOfScope"), ["no docs"]], [t("ckClarify"), ["? Which file?", "✓ Which tone? → calm (owner)"]], [t("ckDrawing"), ["docs/d.md"]]]);
    expect(text(slot.getByTestId("ck-blockers").querySelector("li"))).toBe("dep — blocked (no provider)");
    const fix = within(slot.getByTestId("ck-promise")).getAllByRole("button")[1] as HTMLButtonElement;
    expect(fix.disabled).toBe(true);
    fireEvent.change(slot.getByTestId("ck-correction"), { target: { value: "use the other file" } });
    fireEvent.click(fix);
    await waitFor(() => expect(r.of("cockpit_task_correct")).toEqual([{ runId: "run1", taskId: "t1", text: "use the other file" }]));
    await waitFor(() => expect(text(slot.getByTestId("ck-task-said"))).toBe(t("ckSent")));
    observe("n937", { promise: text(slot.getByTestId("ck-promise").querySelectorAll("p")[0]!), reproduce: text(slot.getByTestId("ck-promise").querySelectorAll("p")[1]!), sections: lists, blocker: text(slot.getByTestId("ck-blockers").querySelector("li")), correction: r.of("cockpit_task_correct")[0] });
  });

  it("[sma:sc_design] the drawing lists its files, «Drawing ok» sends the owner's ok for THIS task, and a drawing that changed after the ok is named stale with the date of the ok's edition", async () => {
    const at = Date.UTC(2026, 10, 10, 12, 0);
    const fresh = await openTask({ ...VIEW, drawingOk: { at, stale: false } });
    const freshLine = text(fresh.slot.getByTestId("ck-drawing-state"));
    const files = text(fresh.detail.querySelectorAll("details")[3]!.querySelector("ul"));
    expect(files).toBe("docs/d.md");
    expect(text(fresh.slot.getByTestId("ck-drawing-state"))).toBe(t("ckDrawingOked"));
    fireEvent.click(fresh.slot.getByTestId("ck-drawing-ok"));
    await waitFor(() => expect(fresh.r.of("cockpit_task_drawing_ok")).toEqual([{ runId: "run1", taskId: "t1" }]));
    cleanup();
    const stale = await openTask({ ...VIEW, drawingOk: { at, stale: true } });
    const staleLine = text(stale.slot.getByTestId("ck-drawing-state"));
    expect(staleLine).toBe(t("ckDrawingStale").replace("{d}", new Date(at).toLocaleDateString()));
    cleanup();
    const none = await openTask({ ...VIEW, drawingOk: null });
    expect(none.slot.queryByTestId("ck-drawing-state")).toBeNull();
    observe("n938", { files, fresh: freshLine, okSent: fresh.r.of("cockpit_task_drawing_ok")[0], staleIsNamed: staleLine.includes(new Date(at).toLocaleDateString()) && staleLine !== t("ckDrawingOked"), noOkNoLine: true });
  });

  it("[sma:sc_journal] the approach note is the worker's own words with its lesson, and nothing when the attempt left none", async () => {
    const shown = await openTask(VIEW);
    const line = text(Array.from(shown.detail.querySelectorAll("p")).find((node) => node.textContent?.startsWith(t("ckApproach")))!);
    expect(line).toBe(`${t("ckApproach")}: Patch the form first · tests first`);
    cleanup();
    const noLesson = await openTask({ ...VIEW, approach: { approach: "Patch the form first", lesson: null } });
    expect(text(Array.from(noLesson.detail.querySelectorAll("p")).find((node) => node.textContent?.startsWith(t("ckApproach")))!)).toBe(`${t("ckApproach")}: Patch the form first`);
    cleanup();
    const none = await openTask({ ...VIEW, approach: null });
    expect(Array.from(none.detail.querySelectorAll("p")).some((node) => node.textContent?.startsWith(t("ckApproach")))).toBe(false);
    observe("n945", { line, withoutLesson: `${t("ckApproach")}: Patch the form first`, none: true });
  });
});

// ---- n936 / n941 the task card on the board: words, queue, timeline, threads, stop ----
const TASK = { kind: "task", key: "task:run:w1", runId: "run", taskId: "w1", title: "The form saves", techTitle: "Fix the form", taskKind: "fix", area: "page:orders", objective: "Login fixes", projectId: "proj_a",
  pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column: "running", state: "running", phase: "writing", stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 2, threadId: null, attemptId: "a-w1-2", updatedAt: 1_791_800_000_000, held: false, gates: null, wave: null };
const CARD = { kind: "task", title: "The form saves", techTitle: "Fix the form", taskKind: "fix", area: "page:orders", objective: "Login fixes", pmThreadId: "thr_pm", id: "w1", projectId: "proj_a", state: "running", reason: null,
  contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["a.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: null, stages: [],
  attempts: [{ id: "a-w1-1", no: 1, state: "validation_failed", reason: "verify_passes_exhausted", threadId: "thr_w1", createdAt: 1, updatedAt: 1_791_790_000_000 }, { id: "a-w1-2", no: 2, state: "running", reason: null, threadId: "thr_w2", createdAt: 2, updatedAt: 1_791_800_000_000 }],
  threads: { id: "thr_pm", role: "PM", title: "Coordinator", status: "idle", children: [{ id: "thr_w2", role: "writer#2", title: "Writer w1", status: "active", children: [] }] } };
async function openCard(card: Record<string, unknown> = CARD) {
  const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  const stops: Array<boolean> = [];
  const Stub = (props: { onStop?: (() => void) | null; finished: boolean }) => { stops.push(Boolean(props.onStop)); return <div data-testid="stub-acceptance" />; };
  void AcceptanceCard;
  const r = recorder({ task_board: () => ({ items: [TASK] }), task_card: () => card, cancel_attempt: () => ({ ok: true }), work_graph_task: () => ({ cells: [], stages: [], summary: { returns: 0, seconds: 0, costUsd: null, costState: null, models: [] } }), work_graph_strips: () => ({}), task_diff: () => ({ patch: "", truncated: false }) });
  const slot = await mount(() => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={Stub as never} />, r.table);
  fireEvent.click(await slot.findByTestId("board-card-task:run:w1"));
  await slot.findAllByTestId("task-rail");
  return { slot, r, stops };
}

describe("region 9 · the task card", () => {
  it("[sma:sc_task_card] the card opens with the goal and the title, a rail of status, kind, area, project, chat and attempts, the threads that worked on it and the stop: «Cancel» sends cancel_attempt for the running attempt with the trimmed reason, and the acceptance card gets the stop only while the task is at work", async () => {
    const { slot, r, stops } = await openCard();
    const card = slot.getByTestId("task-card");
    expect(text(card.querySelector("h1"))).toBe("The form saves");
    expect(card.textContent).toContain(`${t("boardGoal")}Login fixes`);
    const rail = Array.from(slot.getAllByTestId("task-rail")[0]!.children).map((row) => `${text(row.children[0]!)} ${text(row.children[1]!)}`);
    expect(rail).toEqual([`${t("boardStatus")} ${t("phase_writing")}`, `${t("boardKind")} Fix`, `${t("boardArea")} orders`, `${t("boardProject")} Alpha`, `${t("boardChat")} Coordinator`, `${t("boardAttempts")} 2`, expect.stringContaining(t("boardUpdated")), `${t("boardTechTitle")} Fix the form`, "ID w1"]);
    expect(text(slot.getByTestId("board-thread-thr_w2"))).toContain("Writer · attempt 2");
    expect(stops).toContain(true);
    fireEvent.change(slot.getByTestId("board-cancel-note"), { target: { value: "  wrong plan  " } });
    fireEvent.click(button(slot, t("cancel")));
    await waitFor(() => expect(r.of("cancel_attempt")).toEqual([{ attemptId: "a-w1-2", note: "wrong plan" }]));
    observe("n936", { title: text(card.querySelector("h1")), rail: rail.map((row, index) => (index === 6 ? "updated" : row)), thread: text(slot.getByTestId("board-thread-thr_w2")), cancel: r.of("cancel_attempt")[0], stopOffered: stops.at(0) });
  });

  it("[sma:sc_timeline] with more than one attempt the timeline lists every attempt in order with its number, its state in words and its ending reason; a task with one attempt has no timeline", async () => {
    const { slot } = await openCard();
    const section = Array.from(slot.getByTestId("task-card").querySelectorAll("section")).find((node) => text(node.firstElementChild).startsWith(t("boardAttempts")))!;
    const parts = Array.from(section.querySelectorAll(":scope > div > div")).map((row) => Array.from(row.children).map((cell) => text(cell)));
    expect(parts).toHaveLength(2);
    expect([parts[0]![0], parts[0]![1], parts[0]![3]]).toEqual(["#1", t("attempt_validation_failed"), "verify_passes_exhausted"]);
    expect(parts[0]).toHaveLength(4);
    expect([parts[1]![0], parts[1]![1]]).toEqual(["#2", t("attempt_running")]);
    expect(parts[1]).toHaveLength(3);
    cleanup();
    const single = await openCard({ ...CARD, attempts: [CARD.attempts[1]!] });
    const titles = Array.from(single.slot.getByTestId("task-card").querySelectorAll("section")).map((node) => text(node.firstElementChild));
    expect(titles.some((title) => title.startsWith(t("boardAttempts")))).toBe(false);
    observe("n941", { attempts: parts.map((row) => [row[0], row[1], row[3] ?? null]), singleHasTimeline: false });
  });
});

// ---- n939 the steps, n940 the live flow, n942 the spend ----
const cell = (stageId: string, state: string, rounds = 1) => ({ stageId, state, rounds, failures: 0, reason: null });
const row = (stageId: string, role: string, model: string | null, extra: Record<string, unknown> = {}) => ({ stageId, role, round: 1, threadId: role === "code" ? null : `thr_${role}`, providerId: "claude-code", model, seconds: null, tokens: null, costUsd: null, costState: null, turns: null, ...extra });
const GRAPH = {
  cells: [cell("plan-critique", "passed"), cell("writer-agent", "running"), cell("code-critique", "skipped", 0)],
  stages: [
    { cell: cell("plan-critique", "passed"), rows: [row("plan-critique", "reviewer", "claude-opus-5", { seconds: 90, turns: 2, costUsd: 0.5, costState: "measured" })] },
    { cell: cell("writer-agent", "running"), rows: [row("writer-agent", "writer", "composer-2.5", { seconds: 600, turns: 4, costState: "not_measured" })] },
    { cell: cell("code-critique", "skipped", 0), rows: [] },
  ],
  summary: { returns: 0, seconds: 690, costUsd: 0.5, costState: "partial", models: ["claude-opus-5", "composer-2.5"] }, turnCeiling: 5,
};

describe("region 9 · the steps, the live flow and the spend", () => {
  it("[sma:sc_stages] the steps say where the work is: one line per stage with its state, who ran it, the model, the turns, the time and the cost, a stage switched off in the settings is not a line but is named under them, and the live tail shows only for the running stage", async () => {
    const { StageSteps } = await import("../../src/rooms/work-graph/ui");
    const r = recorder({ work_graph_task: () => GRAPH, attempt_log_tail: () => ({ lines: ["reading the form", "editing a.ts"] }) });
    const slot = await mount(() => <StageSteps runId="run" taskId="w1" locale="en" projectId="p1" />, r.table);
    await slot.findByTestId("stage-steps");
    await waitFor(() => expect(text(slot.getByTestId("attempt-log-tail"))).toBe("reading the formediting a.ts"));
    const steps = Array.from(slot.getByTestId("stage-steps").querySelectorAll("[data-testid^='step-']:not([data-testid^='step-cell'])")).map((node) => text(node));
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe("Plan critiquepassedreviewer · opus-5 · turns 2 · 2m · $0.500↗");
    expect(steps[1]).toBe(`Writerrunningwriter · composer-2.5 · turns 4 · 10m · ${t("graphNotMeasured")}↗reading the formediting a.ts`);
    expect(slot.queryByTestId("step-code-critique")).toBeNull();
    expect(text(slot.getByTestId("stage-steps").lastElementChild)).toBe(t("graphOff").replace("{stages}", "Code critique"));
    expect(slot.getByTestId("step-writer-agent").contains(slot.getByTestId("attempt-log-tail"))).toBe(true);
    expect(r.of("attempt_log_tail")[0]).toEqual({ runId: "run", taskId: "w1", projectId: "p1" });
    observe("n939", { steps, off: text(slot.getByTestId("stage-steps").lastElementChild), tail: text(slot.getByTestId("attempt-log-tail")), tailUnder: "step-writer-agent" });
  });

  it("[sma:sc_live] the live flow lists what Lane Pilot does now in a PM chat: the task at work with its stage, model and minutes, the week's done tasks apart, and the summary counts at work, accepted and all", async () => {
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const item = (taskId: string, column: string, phase: string, extra: Record<string, unknown> = {}) => ({ key: `task:run:${taskId}`, runId: "run", taskId, title: `Task ${taskId}`, column, phase, stage: null, model: null, since: null, threadId: null, updatedAt: 1, detail: null, ...extra });
    const live = { role: "pm", pmThreadId: "thr_pm", items: [item("w1", "running", "writing", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 12 * 60_000, threadId: "thr_w" }), item("d1", "done", "accepted"), item("d2", "done", "failed"), item("d3", "done", "accepted")], strips: {} };
    const r = recorder({ thread_live: () => live, work_graph_task: () => GRAPH });
    const slot = await mount(() => <ThreadLive threadId="thr_pm" locale="en" />, r.table);
    await slot.findByTestId("thread-live");
    const whole = text(slot.getByTestId("thread-live"));
    const summary = whole.slice(0, whole.indexOf(t("liveNow")));
    expect(summary).toBe(`${t("liveTitle")}${t("liveSummary").replace("{work}", "1").replace("{done}", "2").replace("{all}", "4")}`);
    expect(whole).toMatch(/Now[\s\S]*Task w1[\s\S]*writing · .*composer-2\.5 · 12 min[\s\S]*This week[\s\S]*Task d1[\s\S]*Task d2[\s\S]*Task d3/);
    const weekFirst = whole.indexOf(t("liveWeek"));
    expect(whole.indexOf("Task w1")).toBeLessThan(weekFirst);
    expect(whole.indexOf("Task d1")).toBeGreaterThan(weekFirst);
    observe("n940", { summary: summary.trim(), atWork: "Task w1 before the week's list", line: whole.match(/writing · [^T]*? min/)?.[0] ?? null });
  });

  it("[sma:sc_spend] the work breakdown names the writer's turns against the session ceiling and the month's spend against the cap, and the money turns hot from 90 percent of the cap", async () => {
    const { WorkBreakdown } = await import("../../src/rooms/work-graph/ui");
    const hot = recorder({ work_graph_task: () => GRAPH, money_status: () => ({ monthUsd: 45, cap: 50 }) });
    const slot = await mount(() => <WorkBreakdown runId="run" taskId="w1" locale="en" />, hot.table);
    const turns = text(await slot.findByTestId("graph-turns-ceil"));
    expect(turns).toBe(t("graphTurnsCeil").replace("{n}", "4").replace("{max}", "5"));
    const month = slot.getByTestId("graph-month-ceil");
    expect(text(month)).toBe(t("graphMonthCeilOf").replace("{v}", "$45.00").replace("{cap}", "$50.00"));
    expect(month.className).toContain("text-destructive");
    cleanup();
    const calm = recorder({ work_graph_task: () => GRAPH, money_status: () => ({ monthUsd: 10, cap: null }) });
    const open = await mount(() => <WorkBreakdown runId="run" taskId="w1" locale="en" />, calm.table);
    const openMonth = await open.findByTestId("graph-month-ceil");
    expect(text(openMonth)).toBe(t("graphMonthCeil").replace("{v}", "$10.00"));
    expect(openMonth.className).not.toContain("text-destructive");
    observe("n942", { turns, month: text(month), hot: month.className.includes("text-destructive"), openMonth: text(openMonth), openHot: openMonth.className.includes("text-destructive") });
  });
});

// ---- n947 / n948 the batch view and its piece graph ----
describe("region 9 · the batch view", () => {
  const graph = {
    objective: "port the batch",
    nodes: [
      { id: "t1", title: "t1", state: "running" as const, threadId: "thr_1", area: "feature:a" },
      { id: "t2", title: "t2", state: "blocked" as const, threadId: null, area: "feature:a", reason: "verify_passes_exhausted", attemptId: "a2" },
      { id: "t3", title: "t3", state: "waiting" as const, threadId: null, area: "page:b" },
      { id: "t4", title: "t4", state: "queued" as const, threadId: null, area: null },
    ],
    edges: [{ from: "t2", to: "t3", kind: "depends" as const }, { from: "t1", to: "t4", kind: "files" as const }],
  };
  it("[sma:sc_batch] the batch view shows the scope (the run's goal), the composition by area, the blocked piece with its reason and the decision buttons on that piece only", async () => {
    const { TaskGraphView } = await import("../../src/rooms/native-agent/ui/task-graph-view");
    const retried: string[] = [], canceled: string[] = [];
    const view = render(createElement(TaskGraphView, { graph, onRetry: (id: string) => retried.push(id), onCancel: (id: string) => canceled.push(id) }));
    const scope = text(view.getByTestId("task-graph-scope"));
    const composition = text(view.getByTestId("task-graph-composition"));
    const blocked = text(view.getByTestId("task-blocked-t2"));
    expect(scope).toBe("Цель: port the batch");
    expect(composition).toBe("feature:a: 2 · page:b: 1");
    expect(blocked).toBe("t2: verify_passes_exhaustedПовторитьОстановить");
    expect(view.queryByTestId("task-blocked-t1")).toBeNull();
    expect(view.queryByTestId("task-retry-t1")).toBeNull();
    fireEvent.click(view.getByTestId("task-retry-t2"));
    fireEvent.click(view.getByTestId("task-cancel-t2"));
    expect([retried, canceled]).toEqual([["a2"], ["a2"]]);
    observe("n947", { scope, composition, blocked, decisions: { retried, canceled }, blockedPieces: view.container.querySelectorAll("[data-testid^='task-blocked-']").length });
  });

  it("[sma:sc_batch_graph] the pieces stand by step: one that waits for none is «now», one that waits for a piece stands a step below it, pieces on one step run side by side, and the legend names each kind of link", async () => {
    const { TaskGraphView, taskSteps } = await import("../../src/rooms/native-agent/ui/task-graph-view");
    const view = render(createElement(TaskGraphView, { graph }));
    const steps = Array.from(view.container.querySelectorAll("[data-testid^='task-step-']")).map((node) => [text(node.firstElementChild), Array.from(node.querySelectorAll("[data-testid^='task-node-']")).map((chip) => text(chip))]);
    expect(steps).toEqual([["Сейчас · параллельно", ["t1", "t2"]], ["Шаг 2 · параллельно", ["t3", "t4"]]]);
    expect(Object.fromEntries(taskSteps(graph))).toEqual({ t1: 0, t2: 0, t3: 1, t4: 1 });
    expect(taskSteps({ nodes: graph.nodes.slice(0, 3), edges: [{ from: "t1", to: "t2", kind: "depends" }, { from: "t2", to: "t3", kind: "depends" }] }).get("t3")).toBe(2);
    const legend = text(view.getByTestId("task-graph-legend"));
    expect(legend).toBe("после неё (depends_on)те же файлы");
    observe("n948", { steps, stepOf: Object.fromEntries(taskSteps(graph)), chain: 2, legend });
  });
});

// ---- the phase card: n949 … n953 ----
const PHASE = (record: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  phase: { id: "ph1", title: "Footer", goal: "Ship the footer", stage: "closed", state: "closed", record },
  next: { text: "done" }, withdrawable: [], ownerWord: {}, gates: {}, book: "# Phase ph1: Footer\n\nthe book", facts: {}, ...extra,
});
async function phaseCard(status: Record<string, unknown>, tableExtra: Table = {}) {
  const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
  const stage = (status.phase as { stage: string; state: string }).stage, state = (status.phase as { state: string }).state;
  const r = recorder({ phase_list: () => [{ id: "ph1", title: "Footer", goal: "Ship the footer", stage, state }], phase_get: () => status, phase_files: () => ({ files: [] }), phase_control: () => ({}), phase_act: () => ({}), ...tableExtra });
  const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />, r.table);
  fireEvent.click((await slot.findByTestId("ck-phase-ph1")).querySelector("button")!);
  await slot.findByTestId("ck-phase-card");
  return { slot, r };
}

describe("region 9 · the phase card", () => {
  it("[sma:sc_phase_card] the card shows the drawing the phase signed (files, who drew and who checked it, feasibility, the edition, archived editions), the lessons' analysis and the observation with its date; a phase without them shows none of the three", async () => {
    const until = Date.UTC(2026, 10, 20, 12, 0);
    const full = { design: { drawing: { paths: ["ui.md", "api.md"], sha256: "abcd1234ef", designer: "des", reviewer: "rev", feasible: true }, archived: [{}] }, lessons: { analysis: "went well", draft: { text: "t", state: "staged" } }, observation: { outcome: "failure", reverted: ["abc", "def"], until } };
    const { slot } = await phaseCard(PHASE(full));
    const drawing = Array.from(slot.getByTestId("ck-drawing").querySelectorAll("li")).map((node) => text(node));
    expect(drawing).toEqual(["ui.md, api.md", `${t("ckDrawingBy")}: des · ${t("ckDrawingReview")}: rev`, `✓ · ${t("ckDrawingEdition")} abcd1234 · ${t("ckDrawingArchived").replace("{n}", "1")}`]);
    expect(text(slot.getByTestId("ck-lessons").querySelector("p"))).toBe("went well");
    const observation = text(slot.getByTestId("ck-observation").querySelector("p"));
    expect(observation).toContain("abc, def");
    expect(observation).toContain(`${t("ckObservationUntil")} `);
    cleanup();
    const bare = await phaseCard(PHASE({}));
    expect([bare.slot.queryByTestId("ck-drawing"), bare.slot.queryByTestId("ck-lessons"), bare.slot.queryByTestId("ck-observation")]).toEqual([null, null, null]);
    observe("n949", { drawing, lessons: "went well", observationNamesReverted: observation.includes("abc, def"), bare: [null, null, null] });
  });

  it("[sma:sc_phase_disc] the discussion has six lines — problem, appetite, solution, rabbit holes, no-gos, risks — each under its own label, the plan's pieces joined as the solution, and «не названо» for the empty ones", async () => {
    const { discussionLines } = await import("../../src/rooms/cockpit/ui/screens-work");
    const lines = discussionLines({ goal: "Ship the footer", plan: { items: [{ title: "Footer piece" }, { title: "Header piece" }] }, context: { appetite: "a week", noGos: ["no auth", " ", "no payments"], risks: { feasibility: "the wall may fall", value: "v", usability: "u", viability: " ", security: "s" } } });
    expect(lines).toEqual([
      { label: "Проблема", text: "Ship the footer" }, { label: "Аппетит", text: "a week" }, { label: "Решение", text: "Footer piece; Header piece" },
      { label: "Подводные камни", text: "the wall may fall" }, { label: "Не делаем", text: "no auth; no payments" }, { label: "Риски", text: "v; u; s" },
    ]);
    const empty = discussionLines({});
    expect(empty.map((line) => line.text)).toEqual(Array(6).fill("не названо"));
    const { slot } = await phaseCard(PHASE({ context: { appetite: "a week", noGos: ["no auth"], risks: { feasibility: "the wall may fall" } }, plan: { items: [{ id: "a", title: "Footer piece", wave: 1, promise: { then: "x" } }] } }));
    const drawn = Array.from(slot.getByTestId("ck-discussion").querySelectorAll("li")).map((node) => text(node));
    expect(drawn).toEqual(["Проблема: Ship the footer", "Аппетит: a week", "Решение: Footer piece", "Подводные камни: the wall may fall", "Не делаем: no auth", "Риски: не названо"]);
    observe("n950", { lines, empty: empty.map((line) => line.text), drawn });
  });

  it("[sma:sc_phase_acc] at the acceptance turn the card shows the lines, the signed package (key, verdict, diff) and two bases that must both be ticked before «Yes» is open; «Yes» sends the word with both decisions and the package key, «No» needs the owner's words", async () => {
    const status = PHASE({ ownerWords: true, acceptance: { lines: [{ id: "w1", ok: true, detail: "checks green" }, { id: "w2", ok: false, detail: "header missing" }] } },
      { next: { text: "Waiting for your word on acceptance", key: "ph1:word:acceptance" }, acceptancePackage: { key: "pkg-7", verdict: { state: "green", detail: "main is green", mainSha: "0123456789abcdef" }, diffStat: " a.ts | 2 +-" } });
    (status.phase as { stage: string; state: string }).stage = "acceptance"; (status.phase as { stage: string; state: string }).state = "active";
    const { slot, r } = await phaseCard(status);
    const lines = Array.from(slot.getByTestId("ck-acceptance").querySelectorAll("li")).map((node) => text(node));
    expect(lines).toEqual(["✓ w1: checks green", "✗ w2: header missing"]);
    expect(text(slot.getByTestId("ck-package-key"))).toBe("package pkg-7");
    expect(text(slot.getByTestId("ck-acceptance-package"))).toContain("green: main is green (0123456789ab)");
    const yes = button(slot, t("ckYes"));
    const no = slot.getByText(t("ckNo"), { selector: "button" }) as HTMLButtonElement;
    expect([yes.disabled, no.disabled]).toEqual([true, true]);
    fireEvent.click(slot.getByTestId("ck-useful"));
    expect(yes.disabled).toBe(true);
    fireEvent.click(slot.getByTestId("ck-limits"));
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "acceptance", wave: undefined, decision: "yes", note: "да", useful: true, limits: true, key: "pkg-7" }]));
    observe("n951", { lines, packageKey: text(slot.getByTestId("ck-package-key")), yesDisabledWithOneBasis: true, sent: r.of("phase_control")[0], noNeedsWords: no.disabled });
  });

  it("[sma:sc_phase_folder] the folder names where the phase lives (its path, BOOK.md and the UAT file), lists its files with their sizes, reads one file's text on a click and shows the book", async () => {
    const status = PHASE({ uat: { path: ".agents/phases/ph1/UAT.md", lines: [] } }, { book: "# Phase ph1: Footer\n\nthe book text" });
    const files = { files: [{ path: ".agents/phases/ph1/BOOK.md", size: 120 }, { path: ".agents/phases/ph1/UAT.md", size: 33 }] };
    const { slot, r } = await phaseCard(status, { phase_files: (params: { path?: string }) => (params.path ? { content: { text: "- [ ] 1. a: given g", truncated: false } } : files) });
    const folder = Array.from(slot.getByTestId("ck-phase-card").querySelectorAll("details")).find((node) => text(node.querySelector("summary")) === t("ckPhaseFolder"))!;
    const where = text(folder.querySelector("p"));
    expect(where).toBe(".agents/phases/ph1/ — BOOK.md, UAT.md");
    const listed = await waitFor(() => { const items = Array.from(slot.getByTestId("ck-phase-files").querySelectorAll("li")).map((node) => text(node)); expect(items).toHaveLength(2); return items; });
    expect(listed).toEqual(["BOOK.md · 120 B", "UAT.md · 33 B"]);
    fireEvent.click(slot.getByText("UAT.md", { selector: "button" }));
    await waitFor(() => expect(text(slot.getByTestId("ck-phase-files").querySelector("pre"))).toBe("- [ ] 1. a: given g"));
    expect(r.of("phase_files").at(-1)).toEqual({ phaseId: "ph1", path: ".agents/phases/ph1/UAT.md" });
    expect(text(folder)).toContain("the book text");
    observe("n952", { where, listed, fileText: text(slot.getByTestId("ck-phase-files").querySelector("pre")), read: r.of("phase_files").at(-1), book: text(folder).includes("the book text") });
  });

  it("[sma:sc_scope_pause] one button pauses the whole phase and, once it is paused, the same place says «Resume» and sends resume; a paused phase also offers «interrupt», a running one does not", async () => {
    const active = PHASE({}, {});
    (active.phase as { stage: string; state: string }).stage = "execution"; (active.phase as { stage: string; state: string }).state = "active";
    const a = await phaseCard(active);
    const pauseLabel = text(a.slot.getByText(t("ckPause"), { selector: "button" }));
    fireEvent.click(a.slot.getByText(t("ckPause"), { selector: "button" }));
    await waitFor(() => expect(a.r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "pause" }]));
    expect(a.slot.queryByText(t("ckResume"), { selector: "button" })).toBeNull();
    expect(a.slot.queryByText("Прервать работу", { selector: "button" })).toBeNull();
    cleanup();
    const paused = PHASE({}, {});
    (paused.phase as { stage: string; state: string }).stage = "execution"; (paused.phase as { stage: string; state: string }).state = "paused";
    const p = await phaseCard(paused);
    expect(p.slot.queryByText(t("ckPause"), { selector: "button" })).toBeNull();
    const resumeLabel = text(p.slot.getByText(t("ckResume"), { selector: "button" }));
    fireEvent.click(p.slot.getByText(t("ckResume"), { selector: "button" }));
    await waitFor(() => expect(p.r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "resume" }]));
    expect(p.slot.getByText("Прервать работу", { selector: "button" })).toBeTruthy();
    observe("n953", { running: { button: pauseLabel, sent: a.r.of("phase_control")[0] }, paused: { button: resumeLabel, sent: p.r.of("phase_control")[0], interrupt: true } });
  });
});

// ---- n954 Today, n956 its live feed, n955 Memory ----
const feedRow = (title: string, kind = "task_accepted", at = Date.now()) => ({ at, kind, text: title, runId: "r", taskId: title, title });
describe("region 9 · Today, the live feed and Memory", () => {
  it("[sma:sc_today] Today opens with the day's five numbers, the work done today (a row opens what was promised and why it was accepted) and the day feed with each kind in words", async () => {
    const { TodayScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const rpc = { call: async (name: string) => name === "task_acceptance_card"
      ? { contract: { objective: "make the cap", acceptance: ["cap holds"] }, planFact: { items: [{ item: 1, acceptance: "cap holds", verdict: "proven", why: "tested" }] } }
      : { kpi: { accepted: 3, blocked: 1, running: 2, tokens: 12345, actions: 7 }, feed: [feedRow("Task A"), feedRow("Task B", "task_blocked"), feedRow("Task C", "task_running")] } };
    const view = render(createElement(TodayScreen, { rpc: rpc as never, projectId: "p1" }));
    await waitFor(() => expect(view.getByTestId("ck-kpi")).toBeTruthy());
    const kpi = Array.from(view.getByTestId("ck-kpi").children).map((node) => [text(node.children[0]!), text(node.children[1]!)]);
    expect(kpi).toEqual([[t("ckKpiAccepted"), "3"], [t("ckKpiBlocked"), "1"], [t("ckKpiRunning"), "2"], [t("ckKpiTokens"), (12345).toLocaleString()], [t("ckKpiActions"), "7"]]);
    const feed = Array.from(view.getByTestId("ck-feed").querySelectorAll("li")).map((node) => [text(node.querySelector("[class*=tabular-nums]")?.nextElementSibling ?? null), text(node.lastElementChild)]);
    expect(feed).toEqual([[t("ckKind_accepted"), "Task A"], [t("ckKind_blocked"), "Task B"], [t("ckKind_running"), "Task C"]]);
    fireEvent.click(view.container.querySelector("button[aria-expanded]")!);
    await waitFor(() => expect(view.container.textContent).toContain("make the cap"));
    expect(view.container.textContent).toContain("cap holds");
    observe("n954", { kpi, feed, unfolded: view.container.textContent!.includes("make the cap") && view.container.textContent!.includes("cap holds") });
  });

  it("[sma:sc_live_stream] the feed re-reads every 8 seconds and marks only the row that arrived since the last read as new for a few seconds; a hidden page does not read", async () => {
    const { TodayScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const old = feedRow("Old work", "task_accepted", 1_000), fresh = feedRow("New work", "task_running", 2_000);
    const answers = [{ kpi: { accepted: 1, blocked: 0, running: 0, tokens: 0, actions: 0 }, feed: [old] }, { kpi: { accepted: 1, blocked: 0, running: 1, tokens: 0, actions: 0 }, feed: [fresh, old] }];
    let reads = 0;
    const rpc = { call: async () => answers[Math.min(reads++, 1)] };
    vi.useFakeTimers();
    const view = render(createElement(TodayScreen, { rpc: rpc as never, projectId: "p1" }));
    await vi.waitFor(() => expect(reads).toBe(1));
    await vi.waitFor(() => expect(text(view.getByTestId("ck-feed"))).toContain("Old work"));
    const newBadges = () => Array.from(view.getByTestId("ck-feed").querySelectorAll("li")).filter((node) => text(node).includes(t("ckNew"))).map((node) => text(node.lastElementChild));
    expect(newBadges()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(newBadges()).toEqual(["New work"]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    await vi.waitFor(() => expect(newBadges()).toEqual([]));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    const before = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(24_000); });
    const readsWhileHidden = reads - before;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(readsWhileHidden).toBe(0);
    observe("n956", { firstRead: [], afterPoll: ["New work"], marked: "only the new row", fades: true, readsWhileHidden });
  });

  it("[sma:sc_memory] Memory lists the project's facts and its rules apart with their counts, a fact can be removed (the delete names the project and the record) and a rule has no remove button", async () => {
    const { MemoryRecords } = await import("../../src/rooms/memory/ui/memory-records");
    const record = (id: string, rule: boolean, content: string) => ({ id, kind: "note", audience: "subagent", content, concepts: ["deploy"], createdAt: Date.UTC(2026, 10, 12), rule, originTaskId: null, sourceFileId: null, noTrace: false, origin: "writer", scope: [], sources: 1 });
    let records = [record("fact-1111111111aa", false, "Deploy port is 9000."), record("rule-2222222222bb", true, "Never npm install.")];
    const r = recorder({ memory_records_list: () => ({ records }), memory_record_delete: () => { records = records.filter((row) => row.rule); return { deleted: true, leftovers: [] }; } });
    const slot = await mount(() => <MemoryRecords projectId="p1" />, r.table);
    await waitFor(() => expect(slot.getByTestId("memory-records").textContent).toContain("Deploy port is 9000."));
    const summaries = Array.from(slot.getByTestId("memory-records").querySelectorAll("summary")).map((node) => text(node));
    expect(summaries).toEqual([`${t("memoryRecordsFacts")} (1)`, `${t("memoryRecordsRules")} (1)`]);
    const factRow = slot.getByTestId("memory-record-fact-1111111");
    const ruleRow = slot.getByTestId("memory-record-rule-2222222");
    expect(factRow.textContent).toContain("Deploy port is 9000.");
    expect(ruleRow.textContent).toContain("Never npm install.");
    expect(ruleRow.querySelector("button")).toBeNull();
    fireEvent.click(factRow.querySelector("button")!);
    await waitFor(() => expect(r.of("memory_record_delete")).toEqual([{ projectId: "p1", id: "fact-1111111111aa" }]));
    await waitFor(() => expect(Array.from(slot.getByTestId("memory-records").querySelectorAll("summary")).map((node) => text(node))[0]).toBe(`${t("memoryRecordsFacts")} (0)`));
    observe("n955", { summaries, ruleHasRemove: false, deleted: r.of("memory_record_delete")[0], factsAfter: 0 });
  });
});

// ---- n943 the acceptance card ----
describe("region 9 · the acceptance card", () => {
  it("[sma:sc_acceptance] the card lists the acceptance lines with the blind check's verdict, and the owner's two decisions «Merge» / «Do not merge» (the second only with words), «Return to a stage…» and «Stop» each send their own call", async () => {
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui/acceptance-card");
    const item = (n: number, acceptance: string, verdict: string, severity: string) => ({ item: n, acceptance, claimed: "done", verdict, severity, why: null, evidence: [] });
    const card = { contract: { objective: "Save the form", acceptance: ["the form saves", "errors are shown"], ownsPaths: [] }, risk: null, base: null, receipts: [], gates: [], baseline: null, notRun: [], awaitsWord: true,
      planFact: { state: "failed", table: "ok", reason: null, mode: "gate", extraRows: [], wires: [], notChecked: [], items: [item(1, "the form saves", "proven", "ok"), item(2, "errors are shown", "unproven", "blocking")] },
      cost: { state: "measured", usd: 0.5, tokens: 10, note: null, attempts: 1, measured: 1 } };
    const stops: string[] = [];
    const r = recorder({ task_acceptance_card: () => card, task_word: () => ({ ok: true }), task_return_stage: () => ({ ok: true, state: "queued" }) });
    const prompt = vi.spyOn(window, "prompt").mockReturnValueOnce("   ").mockReturnValueOnce("  not yet  ");
    const slot = await mount(() => <AcceptanceCard runId="run" taskId="t1" refreshKey={0} finished={false} fallback={null} onStop={() => stops.push("t1")} />, r.table);
    await slot.findByTestId("acceptance-card");
    const lines = [1, 2].map((n) => [slot.getByTestId(`acc-item-${n}`).getAttribute("data-verdict"), text(slot.getByTestId(`acc-item-${n}`).querySelector("span.min-w-0"))]);
    expect(lines).toEqual([["proven", "the form saves"], ["unproven", "errors are shown"]]);
    const word = within(slot.getByTestId("acc-word"));
    expect(Array.from(slot.getByTestId("acc-word").querySelectorAll("button")).map((node) => text(node))).toEqual([t("accWordYes"), t("accWordNo")]);
    fireEvent.click(slot.getByTestId("acc-word-no"));
    expect(r.of("task_word")).toEqual([]);
    fireEvent.click(slot.getByTestId("acc-word-no"));
    await waitFor(() => expect(r.of("task_word")).toEqual([{ runId: "run", taskId: "t1", decision: "no", text: "not yet" }]));
    expect(prompt).toHaveBeenCalledTimes(2);
    fireEvent.click(word.getByText(t("accWordYes")));
    await waitFor(() => expect(r.of("task_word")[1]).toEqual({ runId: "run", taskId: "t1", decision: "yes", text: "да" }));
    fireEvent.click(slot.getByTestId("return-to-writer"));
    fireEvent.change(slot.getByTestId("return-note"), { target: { value: "the writer missed the header" } });
    fireEvent.click(slot.getByTestId("return-send"));
    await waitFor(() => expect(r.of("task_return_stage")).toEqual([{ ref: "t1", to: "writer", note: "the writer missed the header", by: "owner" }]));
    fireEvent.click(slot.getByTestId("acc-stop"));
    expect(stops).toEqual(["t1"]);
    observe("n943", { lines, decisions: r.of("task_word"), emptyWhyIgnored: true, returned: r.of("task_return_stage")[0], stops });
  });
});
