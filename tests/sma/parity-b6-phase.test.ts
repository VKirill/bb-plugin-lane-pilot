import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceKey, blindVerdict, designGate, issuable, nextAction, pieceLines, pieceSha, planGate, planSignature, staleAfterReturn,
  waveLines, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import { getPhase, insertPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";

const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning", over: Partial<Phase> = {}): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "skipped", ...over });
const SHA = "a".repeat(64);

/** A plan record whose gate would pass without the pre-mortem rule: signed context, valid pieces, approved independent check. */
const readyPlan = (over: Partial<NonNullable<PhaseRecord["plan"]>> = {}): PhaseRecord => {
  const items = over.items ?? [item("p1")];
  return {
    context: { docs: [], sha: "ctx", signedAt: 1, legacy: true },
    plan: { items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "critic", independence: { ok: true, why: "" } },
      objective: "the goals", premortem: ["risk one", "risk two", "risk three"], ...over },
  };
};

function driver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const writes: Array<{ path: string; content: string }> = [];
  const hostCalls: string[] = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    hostCalls.push(method);
    if (method === "writePhaseBook") return { status: "applied", writes: (input.edits as Array<{ path: string; content: string }>).map((edit) => { writes.push(edit); return { path: edit.path, status: "applied", afterSha256: "x" }; }) };
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h' WHERE id='run1'").run();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async () => { throw new Error("no file"); },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services).phases;
  return { phases, db, writes, hostCalls };
}

async function opened(d: ReturnType<typeof driver>, record: PhaseRecord, stage: Phase["stage"], state: Phase["state"] = "active") {
  const phase = await d.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(d.db, phase.id, { stage, state, runId: "run1", record: { ...phase.record, ...record }, at: 2 });
  return phase.id;
}

describe("phase parity b6", () => {
  it("[sma:p2_record] refuses a plan without its goals or three to five pre-mortem risks", () => {
    expect(planGate(readyPlan()).ok).toBe(true);
    const why = (over: Partial<NonNullable<PhaseRecord["plan"]>>) => { const gate = planGate(readyPlan(over)); return gate.ok ? [] : gate.why.join("; "); };
    expect(why({ objective: "" })).toContain("objective");
    expect(why({ premortem: ["a", "b"] })).toContain("pre-mortem");
    expect(why({ premortem: ["a", "b", "c", "d", "e", "f"] })).toContain("pre-mortem");
    expect(why({ premortem: [] })).toContain("pre-mortem");
    // An already-met plan names no risks: the goal audit checks the claim itself.
    expect(planGate(readyPlan({ items: [], alreadyMet: { evidence: "the repo does it" }, premortem: undefined, objective: undefined })).ok).toBe(true);
  });

  it("[sma:p5_design] the verdict and the package key are bound to the confirmed drawing", () => {
    const items = [item("p1")];
    const facts = new Map([["p1", fact("t1")]]);
    const goal = { state: "passed", headSha: "h" };
    const confirmed = blindVerdict(items, facts, goal, 1, { sha256: "aaa", contract: "d/UI-SPEC.md" });
    expect(confirmed.state).toBe("passed");
    const changed = blindVerdict(items, facts, goal, 1, { sha256: "bbb", contract: "d/UI-SPEC.md", changed: "confirmed aaa, now bbb" });
    expect(changed.state).toBe("failed");
    expect(changed.detail).toContain("the drawing changed since it was confirmed");
    expect(changed.inputSha).not.toBe(confirmed.inputSha);
    const a = phase({ ...readyPlan(), design: { decision: "needed", why: "x", drawing: { paths: ["d/UI-SPEC.md"], sha256: "aaa", designer: "d" } }, verification: { verdict: confirmed as never } });
    const b = phase({ ...a.record, design: { decision: "needed", why: "x", drawing: { paths: ["d/UI-SPEC.md"], sha256: "bbb", designer: "d" } } });
    expect(acceptanceKey(a.record)).not.toBe(acceptanceKey(b.record));
  });

  it("[sma:p5_uat_line] answers a UAT line by its number; the uat yes waits for every line passed", async () => {
    const d = driver();
    const items = [item("p1"), item("p2"), item("p3")];
    const sha = planSignature(items, "ctx");
    const id = await opened(d, {
      plan: { items, contextSha: "ctx", sha, admittedSha: sha }, ownerWords: true,
      uat: { path: ".agents/phases/x/UAT.md", sha256: "s", at: 1, lines: items.map((row, n) => ({ n: n + 1, pieceId: row.id, state: "open" as const })) },
    }, "acceptance");
    // A number that is not a line is refused; a failing line is recorded alone.
    await expect(async () => d.phases.uatLine({ phaseId: id, line: 4, result: "pass" })).rejects.toThrow("no UAT line 4");
    d.phases.uatLine({ phaseId: id, line: 2, result: "fail", note: "the bar is missing" });
    const lines = getPhase(d.db, id)!.record.uat!.lines!;
    expect(lines[1]).toMatchObject({ n: 2, pieceId: "p2", state: "failed", note: "the bar is missing" });
    expect(lines[0]!.state).toBe("open");
    // The session word is refused until every line passed.
    await expect(async () => d.phases.word({ phaseId: id, turn: "uat", decision: "yes", text: "да", by: "owner via screen" })).rejects.toThrow("UAT is not complete");
    d.phases.uatLine({ phaseId: id, line: 2, result: "pass" });
    d.phases.uatLine({ phaseId: id, line: 1, result: "pass" });
    d.phases.uatLine({ phaseId: id, line: 3, result: "pass" });
    const after = await d.phases.word({ phaseId: id, turn: "uat", decision: "yes", text: "да", by: "owner via screen" });
    expect(after.record.words?.at(-1)).toMatchObject({ turn: "uat", decision: "yes" });
  });

  it("[sma:p5_record_after] UAT.md lands on main only after the phase landed", async () => {
    const d = driver();
    const items = [item("p1")];
    const sha = planSignature(items, "ctx");
    const id = await opened(d, {
      plan: { items, contextSha: "ctx", sha, admittedSha: sha }, ownerWords: true,
      candidate: { branch: "phase/x", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, verified: { "/repo": "v" } },
    }, "acceptance");
    // Candidate on, verified but not landed: the lines open in the record, nothing is written to main.
    await d.phases.drive(getPhase(d.db, id)!);
    const record = getPhase(d.db, id)!.record;
    expect(record.uat?.lines?.length).toBe(1);
    expect(record.uat?.sha256).toBe("");
    expect(d.writes.filter((file) => file.path.endsWith("UAT.md"))).toHaveLength(0);
    // After the landing the document is written once, with the answers.
    savePhase(d.db, id, { record: { ...record, uat: { ...record.uat!, lines: [{ n: 1, pieceId: "p1", state: "passed", by: "owner", at: 3 }] }, candidate: { ...record.candidate!, landedAt: 4 } }, at: 5 });
    await d.phases.drive(getPhase(d.db, id)!);
    const written = d.writes.filter((file) => file.path.endsWith("UAT.md"));
    expect(written).toHaveLength(1);
    expect(written[0]!.content).toContain("- [x] 1. p1");
  });

  it("[sma:pc_contract] a resubmitted plan or drawing voids the owner's earlier yes", async () => {
    const d = driver();
    const items = [item("p1")];
    const sha = planSignature(items, "ctx");
    const id = await opened(d, {
      context: { docs: [], sha: "ctx", signedAt: 1, legacy: true },
      plan: { items, contextSha: "ctx", sha }, ownerWords: true,
      words: [{ turn: "planning", decision: "yes", by: "owner", text: "да", at: 1, sha }],
    }, "planning");
    // The same plan keeps the word; a changed plan drops it.
    d.phases.plan({ phaseId: id, items });
    expect(getPhase(d.db, id)!.record.words).toHaveLength(1);
    d.phases.plan({ phaseId: id, items: [item("p1"), item("p2")] });
    expect(getPhase(d.db, id)!.record.words ?? []).toHaveLength(0);
    const gate = planGate(getPhase(d.db, id)!.record);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(" ")).toContain("owner's word");
    // The design turn: a yes signed on drawing A does not pass designGate once the record holds drawing B — the drawing
    // step drops the word on a new sha, and a stale sha answers for nothing either way.
    const drawingA = { paths: ["d/UI-SPEC.md"], sha256: "aaa", designer: "d", feasible: true, reviewer: "r" };
    const recordA: PhaseRecord = { ownerWords: true, design: { decision: "needed", why: "x", drawing: drawingA }, words: [{ turn: "design", decision: "yes", by: "o", text: "да", at: 1, sha: "aaa" }] };
    expect(designGate(recordA).ok).toBe(true);
    const recordB: PhaseRecord = { ...recordA, design: { decision: "needed", why: "x", drawing: { ...drawingA, sha256: "bbb" } }, words: [] };
    const gateB = designGate(recordB);
    expect(gateB.ok).toBe(false);
    if (!gateB.ok) expect(gateB.why.join(" ")).toContain("owner's word");
  });

  it("[sma:px_force] interrupts only by explicit choice while the work is not proven stopped", async () => {
    const d = driver();
    const items = [item("p1")];
    const sha = planSignature(items, "ctx");
    const record: PhaseRecord = { plan: { items, contextSha: "ctx", sha, admittedSha: sha }, ownerWords: false,
      execution: { issued: { p1: "p1" }, issuedSha: { p1: pieceSha(items[0]!) } } };
    // Active and a quiet paused phase are both refused.
    const active = await opened(d, record, "execution");
    await expect(async () => d.phases.interrupt({ phaseId: active })).rejects.toThrow("pausing or paused");
    const idle = await opened(d, record, "execution", "paused");
    await expect(async () => d.phases.interrupt({ phaseId: idle })).rejects.toThrow("no running work");
    // One running attempt: interrupted by choice, the piece's contract print is withdrawn for a redo on resume.
    createTask(d.db, { id: "p1", runId: "run1", kind: "bb", contract: items[0]!.task });
    createAttempt(d.db, { id: "att1", runId: "run1", taskId: "p1" });
    d.db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_writer' WHERE id='att1'").run();
    const paused = await opened(d, record, "execution", "paused");
    const out = await d.phases.interrupt({ phaseId: paused, words: "stop the work" });
    expect(out.unconfirmed).toHaveLength(0);
    expect(getPhase(d.db, paused)!.state).toBe("paused");
    expect(getPhase(d.db, paused)!.record.interrupting).toBeUndefined();
    expect(getPhase(d.db, paused)!.record.execution?.issuedSha?.p1).toBe("interrupted");
    // Back to active, issue() sends the piece again as the next redo of its family.
    d.phases.setState({ phaseId: paused, state: "resume" });
    const driven = await d.phases.drive(getPhase(d.db, paused)!);
    expect(driven.record.execution?.issued.p1).toBe("p1.2");
  });

  it("[sma:px_return_exec] returns only a prepared phase to execution, one attempt higher", async () => {
    const d = driver();
    const items = [item("p1")];
    const sha = planSignature(items, "ctx");
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const executing: PhaseRecord = { plan: { items, contextSha: "ctx", sha, admittedSha: sha },
      execution: { issued: { p1: "p1" }, issuedSha: { p1: pieceSha(items[0]!) } } };
    // From execution there is no earlier-stage return to execution; from verification without a frozen verdict it is refused.
    const verifying = await opened(d, { ...executing, verification: {} }, "verification");
    expect(() => d.phases.returnTo({ phaseId: verifying, to: "execution", note: "back" })).toThrow("only from acceptance");
    // From acceptance: the preparation is withdrawn and the piece queues as its next redo with the note.
    const prepared = await opened(d, { ...executing, verification: { verdict }, acceptance: { lines: [], at: 1, accepted: false },
      candidate: { branch: "phase/x", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, verified: { "/repo": "v" }, goal: { state: "passed", headSha: "v", red: [], detail: null, at: 1, tasks: 1, runId: "run1", projectId: "p" } } }, "acceptance");
    const back = d.phases.returnTo({ phaseId: prepared, to: "execution", note: "the header is wrong" });
    expect(back.stage).toBe("execution");
    expect(back.record.verification).toBeUndefined();
    expect(back.record.acceptance).toBeUndefined();
    expect(back.record.candidate?.verified).toBeUndefined();
    expect(back.record.candidate?.goal).toBeUndefined();
    expect(back.record.execution?.issuedSha?.p1).toBe("returned");
    createTask(d.db, { id: "p1", runId: "run1", kind: "bb", contract: items[0]!.task });
    createAttempt(d.db, { id: "att1", runId: "run1", taskId: "p1" });
    d.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
    const driven = await d.phases.drive(getPhase(d.db, prepared)!);
    expect(driven.record.execution?.issued.p1).toBe("p1.2");
    const redo = d.db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id='p1.2'").get() as { contract_json: string } | undefined;
    expect(redo).toBeTruthy();
  });

  it("[sma:bi_decide] a broken piece leaves the stop only by skip, retry or cancel", async () => {
    const d = driver();
    const items = [item("p1"), item("p2")];
    const sha = planSignature(items, "ctx");
    const record = (): PhaseRecord => ({ plan: { items, contextSha: "ctx", sha, admittedSha: sha },
      execution: { issued: { p1: "p1", p2: "p2" }, issuedSha: { p1: pieceSha(items[0]!), p2: pieceSha(items[1]!) } } });
    // An accepted piece is refused; the stop's own message offers only the three choices.
    const accepted = await opened(d, record(), "execution");
    await expect(async () => d.phases.decide({ phaseId: accepted, piece: "p1", choice: "skip" })).rejects.toThrow("not stopped");
    const action = nextAction(phase(record(), "execution"), new Map([["p1", fact("p1", { state: "blocked" })], ["p2", fact("p2", { state: "running" })]]));
    expect(action.text).toContain("decide");
    expect(action.text).toContain('"skip"|"retry"|"cancel"');
    // skip drops the piece (issued or not); retry marks it for the next redo; cancel stops the phase.
    createTask(d.db, { id: "p1", runId: "run1", kind: "bb", contract: items[0]!.task });
    createAttempt(d.db, { id: "att1", runId: "run1", taskId: "p1" });
    d.db.prepare("UPDATE lane_pilot_attempt SET state='blocked' WHERE id='att1'").run();
    const skipped = await opened(d, record(), "execution");
    const after = await d.phases.decide({ phaseId: skipped, piece: "p1", choice: "skip", note: "not worth it" });
    expect(after.record.plan?.items.map((row) => row.id)).toEqual(["p2"]);
    expect(after.record.execution?.issued.p1).toBeUndefined();
    expect(after.record.scope?.withdrawn).toContain("p1");
    const retrying = await opened(d, record(), "execution");
    const retried = await d.phases.decide({ phaseId: retrying, piece: "p1", choice: "retry" });
    expect(retried.record.execution?.issuedSha?.p1).toBe("retry");
    const driven = await d.phases.drive(getPhase(d.db, retrying)!);
    expect(driven.record.execution?.issued.p1).toBe("p1.2");
    // A piece that failed to issue and fails the same way after a retry is said again: the retry clears the last said step.
    const failing = await opened(d, { plan: record().plan, execution: { issued: {}, issuedSha: {}, issueErrors: { p1: "contract lint: read_first source is missing" } } }, "execution");
    const said = nextAction(getPhase(d.db, failing)!, new Map());
    expect(said.text).toContain('to:"planning"');
    d.db.prepare("UPDATE lane_pilot_phase SET poked_key=? WHERE id=?").run(said.key, failing);
    await d.phases.decide({ phaseId: failing, piece: "p1", choice: "retry" });
    expect(getPhase(d.db, failing)!.pokedKey).not.toBe(said.key);
    const canceling = await opened(d, record(), "execution");
    const stopped = await d.phases.decide({ phaseId: canceling, piece: "p1", choice: "cancel", note: "give up" });
    expect(stopped.state).toBe("stopped");
  });

  it("[sma:bi_revise] a new scope revokes the earlier issue permission", async () => {
    const d = driver();
    const items = [item("p1"), item("p2")];
    const sha = planSignature(items, "ctx");
    const record: PhaseRecord = { ownerWords: true, plan: { items, contextSha: "ctx", sha, admittedSha: sha },
      words: [{ turn: "issue", decision: "yes", by: "owner", text: "да", at: 1 }, { turn: "wave", wave: 1, decision: "yes", by: "owner", text: "да", at: 1 }],
      execution: { issued: {}, issuedSha: {} } };
    // The stale-after-return fix: a return to execution (or earlier) drops the issue and wave words.
    const stale = staleAfterReturn("planning", { ...record, stage: undefined } as never);
    expect(stale.words?.some((word) => word.turn === "issue" || word.turn === "wave")).toBe(false);
    // withdraw() drops the issue word too and books the revocation.
    const id = await opened(d, { ...record, context: { docs: [], sha: "ctx", signedAt: 1, legacy: true } }, "execution");
    const after = d.phases.withdraw({ phaseId: id, pieces: ["p2"], note: "cut it" });
    expect(after.record.words?.some((word) => word.turn === "issue")).toBe(false);
    expect(listParts(d.db, id).some((part) => part.kind === "scope_withdrawn" && part.text.includes("issue permission revoked"))).toBe(true);
    const action = nextAction(getPhase(d.db, id)!, new Map());
    expect(action.key).toContain("word:issue");
  });

  it("[sma:bw_lines] the wave and its pieces share one and the same line set", () => {
    const items = [item("a"), item("b")];
    const facts = new Map<string, TaskFact>([
      ["a", fact("t1")],
      ["b", fact("t2", { browserQa: "failed", qaPlanned: true })],
    ]);
    const issuedSha = { a: pieceSha(items[0]!), b: pieceSha(items[1]!) };
    const per = items.map((row) => pieceLines(row, facts.get(row.id), issuedSha[row.id as keyof typeof issuedSha]));
    const wave = waveLines(items, facts, issuedSha);
    // One set: the wave's ids are exactly each piece's ids.
    expect(wave.map((line) => line.id)).toEqual(per[0]!.map((line) => line.id));
    expect(wave.map((line) => line.id)).toEqual(per[1]!.map((line) => line.id));
    const qa = wave.find((line) => line.id === "qa_read")!;
    expect(qa.ok).toBe(false);
    expect(qa.detail).toContain("b");
    expect(qa.detail).not.toMatch(/\ba\b(?!\.)/);
    // And the phase acceptance's piece-level lines come from the same function (same ids).
    expect(per[0]!.map((line) => line.id)).toEqual(["contract_current", "landed", "promises_proved", "checks_passed", "independent_check", "qa_read"]);
    // A piece held to a line the wave passed before cannot slip through: b fails qa_read, so the wave fails it.
    expect(wave.every((line) => line.ok)).toBe(false);
    // issuable still waits for the wave to clear.
    const record: PhaseRecord = { execution: { issued: { a: "t1", b: "t2" }, waves: { "1": { packageSha: "p", lines: wave, at: 1 } } } };
    expect(issuable([...items, item("c", { wave: 2 })], { a: "t1", b: "t2" }, facts, (w) => wave.every((line) => line.ok) ? true : false)).toEqual([]);
  });
});
