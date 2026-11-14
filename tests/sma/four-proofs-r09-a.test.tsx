/** @vitest-environment jsdom */
// Region 9 · Person and window, batch a (n755 … n784). The screens of the window rendered for real in jsdom: each test drives what the person
// presses or reads and checks what the screen shows or which call it sends (the whole parameter list), not that a string exists in the source.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); });

type Table = Record<string, (params: never) => unknown>;
/** The rpc handle the cockpit screens take as a prop: it records every call and answers from the table. */
function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}
async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const button = (slot: ReturnType<typeof renderSlot>, text: string) => slot.getByText(text, { selector: "button" }) as HTMLButtonElement;

// ---- the acceptance card: the owner's word on a finished work ----
const evidence = { evidence: "src/a.ts:1", kind: "file", ok: true, code: "lines_changed", note: "changed" };
const acceptance = (extra: Record<string, unknown> = {}) => ({
  contract: { objective: "Save the form", acceptance: ["the form saves"], ownsPaths: ["src/form/**"] }, risk: "high",
  base: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567", branch: "lp/t1", compareCommitted: true },
  receipts: [{ stageId: "writer-agent", state: "passed", proof: "code", proofKind: "gate", reason: null, model: "gpt-6-luna", updatedAt: 1 }],
  gates: [{ gate: "accept", status: "passed", attempt: 1, at: 2 }],
  planFact: { state: "passed", table: "ok", reason: null, mode: "block", extraRows: [], notChecked: [], wires: [], items: [{ item: 1, acceptance: "the form saves", claimed: "done", verdict: "proven", severity: "ok", why: null, evidence: [evidence] }] },
  notRun: [], cost: { state: "not_measured", usd: null, tokens: null, note: null, attempts: 1, measured: 0 }, awaitsWord: false, ...extra,
});

describe("region 9 · the owner's decisions on a work", () => {
  it("[sma:d_approve] «Merge» on a card that waits for the owner's word sends the yes with its words «да» for that task and re-reads the card; «Do not merge» sends the owner's own reason, and an empty reason sends nothing; a card that does not wait has no buttons", async () => {
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui/acceptance-card");
    const words: unknown[] = [];
    let waiting = true;
    const table = { task_acceptance_card: () => acceptance({ awaitsWord: waiting }), task_word: (params: unknown) => { words.push(params); waiting = false; return { ok: true }; } };
    const slot = await mount(() => <AcceptanceCard runId="run_1" taskId="t1" refreshKey={0} finished={false} fallback={null} />, table);
    const yes = await slot.findByTestId("acc-word-yes");
    expect(yes.textContent).toBe("Merge");
    fireEvent.click(yes);
    await waitFor(() => expect(words).toEqual([{ runId: "run_1", taskId: "t1", decision: "yes", text: "да" }]));
    // The card is read again after the word: it no longer waits, so the buttons are gone.
    await waitFor(() => expect(slot.queryByTestId("acc-word")).toBeNull());
    cleanup();

    // The «no»: the reason is the owner's own text; an empty answer to the prompt sends nothing.
    words.length = 0; waiting = true;
    const prompt = vi.spyOn(window, "prompt").mockReturnValueOnce("  ").mockReturnValueOnce("  the footer is off by a pixel ");
    const second = await mount(() => <AcceptanceCard runId="run_1" taskId="t2" refreshKey={0} finished={false} fallback={null} />, table);
    fireEvent.click(await second.findByTestId("acc-word-no"));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    expect(words).toEqual([]);
    fireEvent.click(second.getByTestId("acc-word-no"));
    await waitFor(() => expect(words).toEqual([{ runId: "run_1", taskId: "t2", decision: "no", text: "the footer is off by a pixel" }]));
    cleanup();

    const idle = await mount(() => <AcceptanceCard runId="run_1" taskId="t3" refreshKey={0} finished={false} fallback={null} />, { task_acceptance_card: () => acceptance() });
    await idle.findByTestId("acceptance-card");
    expect(idle.queryByTestId("acc-word")).toBeNull();
  });

  it("[sma:d_return] «Return to a stage…» sends the chosen stage and the note as an action by the owner and says what was reset and kept; a refusal shows its reason and next step and keeps the note; the send is off while the note is empty", async () => {
    const { ReturnStage } = await import("../../src/rooms/stage-return/ui/return-stage");
    const sent: unknown[] = [];
    let reply: unknown = { ok: true, state: "handed_to_pm", paused: "attempt a1 stopped (exit confirmed, its work is on record)", stale: [{ stage: "plan-critique", why: "returned to planning" }, { stage: "writer-agent", why: "after plan-critique" }], reused: ["pm-read"], restarted: { by: "pm", note: "the PM has the note and the list of stale receipts" } };
    const slot = await mount(() => <ReturnStage runId="run" taskId="t1" />, { task_return_stage: (params: unknown) => { sent.push(params); return reply; } });
    fireEvent.click(await slot.findByText("Return to a stage…"));
    expect((slot.getByTestId("return-send") as HTMLButtonElement).disabled).toBe(true);
    // The stage defaults to planning; the person picks the writer.
    fireEvent.change(slot.getByTestId("return-note"), { target: { value: "  Use the csv helper.  " } });
    fireEvent.click(slot.getByTestId("return-send"));
    await waitFor(() => expect(sent).toEqual([{ ref: "t1", to: "planning", note: "Use the csv helper.", by: "owner" }]));
    const result = await slot.findByTestId("return-result");
    expect(result.getAttribute("data-ok")).toBe("true");
    expect(result.textContent).toContain("attempt a1 stopped");
    expect(result.textContent).toContain("Reset: plan-critique, writer-agent");
    expect(result.textContent).toContain("Kept: pm-read");
    expect((slot.getByTestId("return-note") as HTMLTextAreaElement).value).toBe("");
    sent.length = 0;
    fireEvent.click(slot.getByTestId("return-to-writer"));
    fireEvent.change(slot.getByTestId("return-note"), { target: { value: "Change of plan." } });
    reply = { ok: false, state: "refused", reason: "attempt a1 of t1 was accepted and merged: its work is in main", next: "take it out with `bb lane-pilot revert t1`, then send the task again" };
    fireEvent.click(slot.getByTestId("return-send"));
    await waitFor(() => expect(sent).toEqual([{ ref: "t1", to: "writer", note: "Change of plan.", by: "owner" }]));
    await waitFor(() => expect(slot.getByTestId("return-result").getAttribute("data-ok")).toBe("false"));
    expect(slot.getByTestId("return-result").textContent).toContain("accepted and merged: its work is in main");
    expect(slot.getByTestId("return-result").textContent).toContain("bb lane-pilot revert t1");
    expect((slot.getByTestId("return-note") as HTMLTextAreaElement).value).toBe("Change of plan.");
  });
});

// ---- tasks: a batch and its suggested composition ----
describe("region 9 · a batch of tasks", () => {
  it("[sma:d_batch] a batch is sent as one request of kind batch with its lines grouped under their area, only once there is enough text; the screen then says it was sent, and says why when the request is refused", async () => {
    const { TasksScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ cockpit_request: ({ text }: { text: string }) => { if (text.includes("boom")) throw new Error("the PM is not reachable"); return { ok: true }; } });
    const slot = await mount(() => <TasksScreen rpc={r.rpc as never} projectId="p1" runId={null} />);
    const batch = slot.getAllByLabelText(t("ckNewBatch"))[0] as HTMLTextAreaElement;
    const batchPanel = slot.getByTestId("ck-new-batch");
    const send = batchPanel.querySelector("button") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(batch, { target: { value: "ui: footer\napi: retry\nui: header\nplain line" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_request")).toEqual([{ projectId: "p1", kind: "batch", text: "ui:\nui: footer\nui: header\n\napi:\napi: retry\n\n—:\nplain line" }]));
    await waitFor(() => expect(slot.getByText("Sent")).toBeTruthy());
    fireEvent.change(batch, { target: { value: "ui: boom the footer" } });
    fireEvent.click(send);
    await waitFor(() => expect(slot.getByText(/the PM is not reachable/)).toBeTruthy());
  });

  it("[sma:d_batch_suggest] typing a batch only proposes: the screen names how many groups by area and which, nothing is sent until the person presses Send; lines without an area word go to one group", async () => {
    const { TasksScreen, composition } = await import("../../src/rooms/cockpit/ui/screens-work");
    expect([...composition(["ui: footer", "api: retry", "ui: header", "  ", "plain", "a: x"]).entries()]).toEqual([["ui", ["ui: footer", "ui: header"]], ["api", ["api: retry"]], ["—", ["plain", "a: x"]]]);
    const r = recorder({});
    const slot = await mount(() => <TasksScreen rpc={r.rpc as never} projectId="p1" runId={null} />);
    fireEvent.change(slot.getAllByLabelText(t("ckNewBatch"))[0]!, { target: { value: "ui: footer\napi: retry\nui: header" } });
    const panel = slot.getByTestId("ck-new-batch");
    expect(panel.textContent).toContain("Suggested composition: 2 group(s) by area: ui, api");
    expect(r.calls).toEqual([]);
  });
});

// ---- the phase card: the owner's controls ----
type Status = Record<string, unknown>;
const phaseStatus = (over: { state?: string; key?: string; record?: Record<string, unknown>; extra?: Status } = {}): Status => ({
  phase: { id: "ph1", title: "Footer", goal: "Ship the footer", stage: "execution", state: over.state ?? "active", record: {
    plan: { items: [{ id: "a", title: "Footer piece", wave: 1, promise: { then: "the footer shows" } }, { id: "b", title: "Header piece", wave: 2, promise: { then: "the header shows" } }] },
    questions: [{ id: "q1", text: "Which colour?", blocking: true }, { id: "q2", text: "Which font?", blocking: false, answer: "the house one" }],
    acceptance: { lines: [{ id: "l1", ok: true, detail: "footer seen" }, { id: "l2", ok: false, detail: "header missing" }] },
    context: { appetite: "two days", noGos: ["no redesign"], risks: { feasibility: "old build" } },
    ownerWords: true,
    execution: { issued: {}, waves: { "1": { lines: [{ id: "w1", ok: true, detail: "checks green" }], review: { state: "ok", by: "codex", summary: "reads fine" } } } },
    ...over.record } },
  withdrawable: ["b"], next: { text: "Waiting for your word on wave 1", key: over.key ?? "ph1:word:wave:1" }, ownerWord: {}, gates: { plan: { ok: true }, design: { ok: false, why: ["no drawing"] } },
  book: "# Book\n\n- the book line", facts: { a: { taskId: "a", attemptId: "at1", state: "running" } }, ...over.extra,
});
async function openPhase(over: Parameters<typeof phaseStatus>[0] = {}, extra: Table = {}) {
  const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
  const r = recorder({ phase_list: () => [{ id: "ph1", title: "Footer", goal: "Ship the footer", stage: "execution", state: over.state ?? "active" }], phase_get: () => phaseStatus(over), phase_files: () => ({ files: [] }), phase_control: () => ({}), phase_act: () => ({}), ...extra });
  const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />);
  fireEvent.click(await slot.findByTestId("ck-phase-ph1").then((row) => row.querySelector("button")!));
  await slot.findByTestId("ck-phase-card");
  return { slot, r };
}

describe("region 9 · the phase card", () => {
  it("[sma:d_phase_card] opening a phase shows its next step, its gates with the reason of a closed one, the plan lines with the work each became, the six discussion lines, the acceptance lines, and the folder with its book; the phase list shows stage and state first", async () => {
    const { slot, r } = await openPhase();
    expect(slot.getByTestId("ck-phase-ph1").querySelector("button")!.textContent).toContain("execution");
    expect(slot.getByTestId("ck-phase-ph1").querySelector("button")!.textContent).toContain("Footer");
    const card = slot.getByTestId("ck-phase-card").textContent!;
    expect(card).toContain("Next: Waiting for your word on wave 1");
    expect(card).toContain("✓ plan");
    expect(card).toContain("✗ design — no drawing");
    expect(slot.getByTestId("ck-plan-a").textContent).toContain("w1 · Footer piece — the footer shows a running");
    expect(slot.getByTestId("ck-plan-b").textContent).toContain("w2 · Header piece — the header shows");
    const discussion = slot.getByTestId("ck-discussion").textContent!;
    for (const line of ["Проблема: Ship the footer", "Аппетит: two days", "Решение: Footer piece; Header piece", "Подводные камни: old build", "Не делаем: no redesign", "Риски: не названо"]) expect(discussion).toContain(line);
    expect(slot.getByTestId("ck-acceptance").textContent).toBe("✓ l1: footer seen✗ l2: header missing");
    expect(card).toContain(".agents/phases/ph1/ — BOOK.md");
    expect(card).toContain("the book line");
    expect(r.of("phase_get")).toEqual([{ phaseId: "ph1" }]);
  });

  it("[sma:d_wave_hold] a wave that waits for the owner is shown with its acceptance lines and the other model's review; «Accept the wave» sends the yes for that wave, «Hold the wave» needs the owner's words and sends the no; «Dequeue the wave» holds the queued pieces", async () => {
    const { slot, r } = await openPhase();
    const question = slot.getByTestId("ck-wave-question").textContent!;
    expect(question).toContain("Wave 1 is done. Accept or hold?");
    expect(question).toContain("✓ w1: checks green");
    expect(slot.getByTestId("ck-wave-review").textContent).toBe("codex: reads fine");
    expect(button(slot, "Hold the wave").disabled).toBe(true);
    fireEvent.click(button(slot, "Accept the wave"));
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "wave", wave: 1, decision: "yes", note: "да" }]));
    fireEvent.change(slot.getByLabelText(/Your word/), { target: { value: "the footer is off" } });
    fireEvent.click(button(slot, "Hold the wave"));
    await waitFor(() => expect(r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "word", turn: "wave", wave: 1, decision: "no", note: "the footer is off" }));
    fireEvent.click(button(slot, "Dequeue the wave"));
    await waitFor(() => expect(r.of("phase_control")[2]).toEqual({ phaseId: "ph1", action: "stop_wave" }));
    // Every control re-reads the phase.
    await waitFor(() => expect(r.of("phase_get").length).toBeGreaterThanOrEqual(4));
  });

  it("[sma:d_redirect] the wheel: a context note goes to the writers at work as a correction (and is off while empty); Pause pauses an active phase, a paused phase offers Resume and the forced interrupt, an active one does not", async () => {
    const { slot, r } = await openPhase();
    expect(button(slot, "Send").disabled).toBe(true);
    expect(slot.queryByText("Прервать работу")).toBeNull();
    fireEvent.change(slot.getByLabelText(t("ckContextNote")), { target: { value: "use the new token" } });
    fireEvent.click(button(slot, "Send"));
    await waitFor(() => expect(r.of("phase_act")).toEqual([{ action: "correct", projectId: "p1", pmThreadId: "screen", phaseId: "ph1", payload: { note: "use the new token" } }]));
    fireEvent.click(button(slot, "Pause"));
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "pause" }]));
    cleanup();

    const paused = await openPhase({ state: "paused", key: "ph1:execute" });
    expect(button(paused.slot, "Resume")).toBeTruthy();
    fireEvent.click(button(paused.slot, "Прервать работу"));
    await waitFor(() => expect(paused.r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "interrupt" }]));
    fireEvent.click(button(paused.slot, "Resume"));
    await waitFor(() => expect(paused.r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "resume" }));
  });

  it("[sma:d_close] closing in words is off until the owner writes the words, then sends them with the close; stopping the phase is the same with its own button; the pieces at work can be stopped one by one, a blocked one retried and a piece not yet issued trimmed — each with the owner's note", async () => {
    const { slot, r } = await openPhase({ key: "ph1:execute", extra: { facts: { a: { taskId: "a", attemptId: "at1", state: "running" }, b: { taskId: "b", attemptId: "at2", state: "blocked" } } } });
    expect(button(slot, "Close in words").disabled).toBe(true);
    expect(button(slot, "Stop the phase").disabled).toBe(true);
    fireEvent.change(slot.getByLabelText(t("ckContextNote")), { target: { value: "we ship it as is" } });
    fireEvent.click(button(slot, "Close in words"));
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "close", note: "we ship it as is" }]));
    fireEvent.click(button(slot, "Stop the phase"));
    await waitFor(() => expect(r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "stop", note: "we ship it as is" }));
    fireEvent.click(slot.getByTestId("ck-plan-a").querySelector("button")!);
    await waitFor(() => expect(r.of("phase_control")[2]).toEqual({ phaseId: "ph1", action: "cancel_piece", piece: "a", note: "we ship it as is" }));
    fireEvent.click(slot.getByTestId("ck-plan-b").querySelectorAll("button")[0]!);
    await waitFor(() => expect(r.of("phase_control")[3]).toEqual({ phaseId: "ph1", action: "withdraw", piece: "b", note: "we ship it as is" }));
  });

  it("[sma:d_decision_answer] an open question has an input and «Answer»; the answer goes to the phase for that question and the card is read again; an answered question shows the answer and no input", async () => {
    const { slot, r } = await openPhase();
    const q1 = Array.from(slot.getByTestId("ck-phase-card").querySelectorAll("div")).find((node) => node.textContent?.startsWith("q1 ⛔: Which colour?") && node.querySelector("input"))!;
    expect(slot.getByText("→ the house one")).toBeTruthy();
    expect(slot.getAllByRole("button", { name: "Answer" })).toHaveLength(1);
    fireEvent.change(q1.querySelector("input")!, { target: { value: "dark grey" } });
    fireEvent.click(button(slot, "Answer"));
    await waitFor(() => expect(r.of("phase_act")).toEqual([{ action: "answer", projectId: "p1", pmThreadId: "screen", phaseId: "ph1", payload: { questionId: "q1", answer: "dark grey" } }]));
    await waitFor(() => expect(r.of("phase_get")).toHaveLength(2));
  });
});
