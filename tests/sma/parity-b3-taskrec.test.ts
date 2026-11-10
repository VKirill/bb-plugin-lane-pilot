import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { acceptanceLines, designGate, type Phase, type PhaseRecord } from "../../src/rooms/phase";
import { appendPart, getPhase, insertPhase, savePhase } from "../../src/rooms/phase/store";
import { autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { installMethods } from "../../src/rooms/phase/server/driver-methods";
import { installSteps } from "../../src/rooms/phase/server/driver-steps";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { decidedOwnerItem, ownerItemOutcome, postOwnerItem } from "../../src/rooms/owner-waiting";
import { decideTaskWord } from "../../src/rooms/lead/server/surfaces";
import { contractEditions, updateTaskContract } from "../../src/rooms/storage";
import { createTaskReconcile } from "../../src/rooms/runs/server/task-reconcile";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import { landingWordGap, recordTaskWord } from "../../src/rooms/tasks";
import { taskWordItemPrefix, type TaskV2 } from "../../src/rooms/contracts";

const NOW = 1_700_000_000_000;
const phase = (record: PhaseRecord, over: Partial<Phase> = {}): Phase => ({
  id: "ph_x", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", stage: "acceptance", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});

function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  const db = openDatabase(bb);
  return { bb, db, sent };
}

/** A phase row in the store plus the docs half of the driver's tools, hand-wired for one method under test. */
function methodsTools(db: ReturnType<typeof openDatabase>, record: PhaseRecord, stage: Phase["stage"]) {
  insertPhase(db, { id: "ph_x", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", at: NOW });
  savePhase(db, "ph_x", { stage, record, at: NOW });
  const mustGet = (id: string) => getPhase(db, id)!;
  const book = (p: Pick<Phase, "id">, section: never, kind: string, text: string) => appendPart(db, p.id, { section: section as never, kind, text, at: NOW });
  const move = (p: Phase, st: Phase["stage"], rec: PhaseRecord) => savePhase(db, p.id, { stage: st, record: rec, at: NOW });
  const reactions = { answerPhaseWord: () => undefined, closeOwnerItem: () => undefined, noteDesignWord: async () => undefined,
    closeOwnerItemsByPrefix: () => 0, postOwnerItem: () => undefined, askPhaseWord: () => undefined, journalDrawing: async () => undefined,
    addRoleLine: async () => undefined, roleLine: (x: unknown) => x, critiqueProblems: () => [] };
  const tools = { ctx: { log: () => undefined, isDisposed: () => false }, services: {}, db, bb: { storage: { kv: {} } }, now: () => NOW, reactions,
    mustGet, book, move, facts: () => new Map(), readFile: async () => ({ sha256: "s", sizeBytes: 1 }), readText: async () => null,
    writeDocs: async () => ({ written: [], commit: null, shas: {} }), journalSteps: () => [], checkerRunBinding: () => null,
    reviewerRead: () => ({ why: "no" }), writeLesson: () => undefined, settleLesson: () => undefined, writeBook: async () => undefined,
    pmCheckoutPath: async () => null, candidates: () => null, redoId: (id: string) => `${id}.2` };
  return installMethods(tools as never);
}

describe("task acceptance and queue rows (wave B)", () => {
  it("[sma:ta_book_close] acceptance holds until BOOK.md is written and re-read", () => {
    const record: PhaseRecord = { bookWritten: { seq: 5, sha256: "shaB", at: 1 } };
    const base = { mainSha: null, openDeferrals: 0 };
    const lines = acceptanceLines(phase(record), new Map(), { ...base, book: { lastSeq: 5, readSha: "shaB" } });
    expect(lines.find((l) => l.id === "book_closed")!.ok).toBe(true);
    const stale = acceptanceLines(phase(record), new Map(), { ...base, book: { lastSeq: 7, readSha: "shaB" } });
    expect(stale.find((l) => l.id === "book_closed")!.ok).toBe(false);
    const tampered = acceptanceLines(phase(record), new Map(), { ...base, book: { lastSeq: 5, readSha: "other" } });
    expect(tampered.find((l) => l.id === "book_closed")!.ok).toBe(false);
    expect(acceptanceLines(phase({}), new Map(), { ...base, book: { lastSeq: 3, readSha: "x" } }).find((l) => l.id === "book_closed")!.ok).toBe(false);
  });

  it("[sma:ta_closed] the phase is closed only after its closing docs read back intact", async () => {
    const { bb, db, sent } = world();
    createRun(db, "r", "p", "bb", "/ws");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1' WHERE id='r'").run();
    insertPhase(db, { id: "ph_x", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", at: NOW });
    savePhase(db, "ph_x", { stage: "closed", state: "active", record: {}, at: NOW });
    const summaryPath = ".agents/phases/ph_x/SUMMARY.md";
    const bookPath = ".agents/phases/ph_x/BOOK.md";
    const make = async (readSha: Record<string, string>) => {
      const tools = { ctx: { log: () => undefined, isDisposed: () => false }, services: {}, db, bb, now: () => NOW, reactions: {},
        mustGet: (id: string) => getPhase(db, id)!, book: (p: { id: string }, s: never, k: string, t: string) => appendPart(db, p.id, { section: s as never, kind: k, text: t, at: NOW }),
        move: () => undefined, facts: () => new Map(), readText: async () => null,
        readFile: async (_p: Phase, path: string) => ({ sha256: readSha[path] ?? "x", sizeBytes: 1 }),
        writeDocs: async () => ({ written: [summaryPath], commit: null, shas: { [summaryPath]: "shaS" } }),
        writeBook: async (p: Phase) => { savePhase(db, p.id, { record: { ...getPhase(db, p.id)!.record, bookWritten: { seq: 1, sha256: "shaB", at: NOW } }, at: NOW }); },
        pmCheckoutPath: async () => null, candidates: () => null, redoId: (i: string) => i, stop: async () => ({ phase: getPhase(db, "ph_x")! }),
        open: async () => getPhase(db, "ph_x")! };
      return installSteps(tools as never).finishClosed(getPhase(db, "ph_x")!);
    };
    // An unfaithful read-back: the docs are not confirmed, the PM is poked, the phase stays unclosed.
    const held = await make({ [summaryPath]: "tampered", [bookPath]: "shaB" });
    expect(held.state).toBe("active");
    expect(held.record.closedDocs).toBeUndefined();
    expect(sent.filter((text) => text.includes("did not read back intact"))).toHaveLength(1);
    // The pass retries every tick, but the PM and the book hear of it once a day.
    await make({ [summaryPath]: "tampered", [bookPath]: "shaB" });
    expect(sent.filter((text) => text.includes("did not read back intact"))).toHaveLength(1);
    savePhase(db, "ph_x", { record: { ...(getPhase(db, "ph_x")!.record), closedDocs: undefined }, at: NOW });
    // A faithful host: the docs read back as written and the phase closes.
    const closed = await make({ [summaryPath]: "shaS", [bookPath]: "shaB" });
    expect(closed.state).toBe("closed");
    expect(closed.record.closedDocs).toBeTruthy();
  });

  it("[sma:tb_contract] each word change mints a numbered hashed edition and keeps the old ones", () => {
    const { db } = world();
    createRun(db, "run1", "p");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: "v1" } });
    updateTaskContract(db, "t1", { title: "v2" });
    updateTaskContract(db, "t1", { title: "v3" });
    const editions = contractEditions(db, "t1");
    expect(editions.map((row) => row.edition)).toEqual([1, 2, 3]);
    expect(new Set(editions.map((row) => row.sha256)).size).toBe(3);
    const first = db.prepare("SELECT contract_json FROM lane_pilot_task_contract_edition WHERE task_id='t1' AND edition=1").get() as { contract_json: string };
    expect(first.contract_json).toContain("v1");
    expect(() => db.prepare("UPDATE lane_pilot_task_contract_edition SET sha256='x' WHERE task_id='t1'").run()).toThrow();
    expect(() => db.prepare("DELETE FROM lane_pilot_task_contract_edition WHERE task_id='t1'").run()).toThrow();
  });

  it("[sma:tb_design_gate_confirmed] a design yes counts only for the drawing hash it names", async () => {
    const drawing = { paths: ["d/one.html", "d/UI-SPEC.md"], sha256: "A", designer: "d", feasible: true, reviewer: "r" };
    const record: PhaseRecord = { ownerWords: true, design: { decision: "needed", why: "x", drawing } };
    expect(designGate({ ...record, words: [{ turn: "design", decision: "yes", by: "o", text: "да", at: 1, key: "A" }] }).ok).toBe(true);
    // Redrawn to sha B the same yes no longer confirms the gate.
    const redrawn = { ...record, design: { ...record.design!, drawing: { ...drawing, sha256: "B" } } };
    expect(designGate({ ...redrawn, words: [{ turn: "design", decision: "yes", by: "o", text: "да", at: 1, key: "A" }] }).ok).toBe(false);
    const { db } = world();
    const api = methodsTools(db, { ownerWords: true, design: { decision: "needed", why: "x", drawing } }, "design");
    await expect(api.word({ phaseId: "ph_x", turn: "design", decision: "yes", text: "да", by: "owner via screen", key: "B" })).rejects.toThrow(/hash of the drawing/);
    await api.word({ phaseId: "ph_x", turn: "design", decision: "yes", text: "да", by: "owner via screen", key: "A" });
    expect(getPhase(db, "ph_x")!.record.words!.at(-1)!.key).toBe("A");
  });

  it("[sma:ts_feedback] a returned drawing carries the owner's remarks into the redraw", async () => {
    const { db } = world();
    const drawing = { paths: ["d/one.html"], sha256: "D", designer: "d", feasible: true, reviewer: "r" };
    const api = methodsTools(db, { ownerWords: true, design: { decision: "needed", why: "x", drawing } }, "design");
    const after = await api.word({ phaseId: "ph_x", turn: "design", decision: "no", text: "bigger buttons", by: "owner" });
    expect(after.stage).toBe("design");
    expect(after.record.design!.feedback).toEqual([{ drawingSha: "D", text: "bigger buttons", by: "owner", at: NOW }]);
    expect(after.record.design!.drawing).toBeUndefined();
    expect(after.record.design!.archived!.at(-1)!.sha256).toBe("D");
    const inputs = autoInputs(after, { kind: "draw" });
    expect(JSON.stringify(inputs.owner_feedback)).toContain("bigger buttons");
  });

  it("[sma:ta_replace] a yes for one candidate is revoked when another candidate replaces it", () => {
    const words = [{ turn: "land" as const, decision: "yes" as const, text: "да", at: 1, attemptId: "att-A" }];
    expect(landingWordGap(true, words, "att-A")).toBeNull();
    expect(landingWordGap(true, words, "att-B")).toMatch(/another candidate/);
    // A word recorded before any attempt waited carries no candidate and still counts for the family.
    expect(landingWordGap(true, [{ turn: "land" as const, decision: "yes" as const, text: "да", at: 1 }], "att-B")).toBeNull();
  });

  it("[sma:tr_approval_row] a task-word row ends as approved, returned, closed or stopped", () => {
    const { db } = world();
    createRun(db, "run1", "p");
    const prefix = taskWordItemPrefix("run1", "P1");
    for (const [i, kind] of ["a", "b", "c", "d"].entries()) {
      postOwnerItem(db as never, { key: `${prefix}${kind}`, source: "writer", kind: "task_word", projectId: "p", what: "w", why: "y" }, NOW + i);
    }
    db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by='approved:pm' WHERE key=?").run(NOW, `${prefix}a`);
    db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by='returned:pm' WHERE key=?").run(NOW, `${prefix}b`);
    db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by='closed:wait over' WHERE key=?").run(NOW, `${prefix}c`);
    db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by='stopped:attempt' WHERE key=?").run(NOW, `${prefix}d`);
    const outcome = (key: string) => ownerItemOutcome(db.prepare("SELECT state, closed_by FROM lane_pilot_owner_item WHERE key=?").get(key) as never);
    expect(outcome(`${prefix}a`)).toBe("approved");
    expect(outcome(`${prefix}b`)).toBe("returned");
    expect(outcome(`${prefix}c`)).toBe("closed");
    expect(outcome(`${prefix}d`)).toBe("stopped");
    postOwnerItem(db as never, { key: `${prefix}e`, source: "writer", kind: "task_word", projectId: "p", what: "w", why: "y" }, NOW);
    expect(outcome(`${prefix}e`)).toBe("awaiting");
    expect(decidedOwnerItem(db as never, prefix)!.by).toContain("approved");
  });

  it("[sma:tr_approving] the second presser loses: the first word claims the decision", async () => {
    const { bb, db } = world();
    createRun(db, "run1", "p");
    const prefix = taskWordItemPrefix("run1", "P1");
    postOwnerItem(db as never, { key: `${prefix}att1`, source: "writer", kind: "task_word", projectId: "p", what: "w", why: "y" }, NOW);
    const first = decideTaskWord(db as never, "run1", "P1", "yes", "screen");
    expect(first.ok).toBe(true);
    if (first.ok) await recordTaskWord(bb.storage.kv as never, "run1", "P1", "yes", "да");
    const second = decideTaskWord(db as never, "run1", "P1", "no", "screen", NOW, "att1");
    expect(second.ok).toBe(false);
    // The decided candidate ended (another one waits, or none): a later word is a new word, not a second press.
    expect(decideTaskWord(db as never, "run1", "P1", "yes", "pm", NOW, null).ok).toBe(true);
    expect(decideTaskWord(db as never, "run1", "P1", "yes", "pm", NOW, "att2").ok).toBe(true);
    if (!second.ok) expect(second.reason).toMatch(/already decided/);
    const all = (await bb.storage.kv.get("lp.task.words")) as Record<string, Array<{ decision: string }>>;
    expect(all["run1:P1"]!.map((word) => word.decision)).toEqual(["yes"]);
  });

  it("[sma:cg_claim_refusal] a family the owner said no to is decided before any work is paid for", async () => {
    const { bb } = world();
    await recordTaskWord(bb.storage.kv as never, "run1", "P1", "no", "не сливать");
    const { ownerSaidNo } = await import("../../src/rooms/tasks");
    expect(await ownerSaidNo(bb.storage.kv as never, "run1", "P1")).toBe("не сливать");
    expect(await ownerSaidNo(bb.storage.kv as never, "run1", "P2")).toBeNull();
  });

  it("[sma:tr_claimed] a running attempt with no live loop is taken back by the periodic pass", async () => {
    const { bb, db } = world();
    createRun(db, "run1", "p");
    createTask(db, { id: "tA", runId: "run1", kind: "bb", contract: {} as never });
    createTask(db, { id: "tB", runId: "run1", kind: "bb", contract: {} as never });
    createAttempt(db, { id: "attA", runId: "run1", taskId: "tA" });
    createAttempt(db, { id: "attB", runId: "run1", taskId: "tB" });
    for (const id of ["attA", "attB"] as const) { transitionAttempt(db, id, "spawn_requested"); transitionAttempt(db, id, "running", { threadId: `thr_${id}` }); }
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id IN ('attA','attB')").run(NOW - 10 * 60_000);
    const resumed: string[] = [];
    const services = {
      activeWriterTasks: new Set(["run1:tB"]),
      docsPlaces: () => [],
      resumeOrphans: async (_p?: string, ids?: readonly string[]) => { resumed.push(...(ids ?? [])); return { resumed: ids ?? [], skipped: [], finished: [] }; },
      stability: { reconcileScanOpen: () => false, adoptBlockedByFaults: async () => [], sweep: async () => [] },
      recoverMergeIntents: async () => [],
      startAfterAcceptance: async () => undefined,
      workflowEngine: undefined,
    };
    const reconcile = createTaskReconcile({ bb, db, log: () => undefined, isDisposed: () => false } as never, services as never);
    await reconcile.reconcileTasks({ phase: "periodic", now: NOW });
    expect(resumed).toEqual(["attA"]);
  });

  it("[sma:tb_words] finished work is never rewritten; a running task is steered, not refused", async () => {
    const { bb, db, sent } = world();
    const runId = "run1";
    createRun(db, runId, "p", "bb", "/ws");
    setRunThread(db, runId, "pm");
    const task: TaskV2 = { schema_version: 2, id: "t1", display_title: "t", kind: "feature", area: "a", title: "t", risk: "low",
      lane: "core", project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["o.txt"],
      owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "obj", acceptance: ["a1"], verify: "tests",
      verification: [{ command: "npm test", cwd: "/ws" }] } as TaskV2;
    createTask(db, { id: "t1", runId, kind: "bb", contract: task });
    createAttempt(db, { id: "att1", runId, taskId: "t1" });
    transitionAttempt(db, "att1", "spawn_requested");
    transitionAttempt(db, "att1", "running", { threadId: "thr_w" });
    const steered = sent;
    const ctx = { bb, db, host: bb.hosts.experimental_client({ contract: {} as never }), log: () => undefined,
      configForRun: async () => ({ hostId: "h1", writerWorkspacePath: "/ws" }), isDisposed: () => false };
    const services = { stageHelperSettings: {}, activeWriterTasks: new Set(), baseline: {}, isLiveFolder: async () => false,
      isTaskSatisfied: async () => false, stability: {}, resolveIntegrationGate: async () => null, startWriterTask: () => undefined, workflowEngine: undefined };
    const update = createWriterUpdateTask(ctx as never, services as never);
    const reply = await update.updateTask({ projectId: "p", runId, pmThreadId: "pm", taskId: "t1",
      task: { ...task, acceptance: ["a1", "a2"] } });
    expect(reply.ok).toBe(true);
    expect(reply.state).toBe("running");
    expect(steered.length).toBe(1);
    expect(contractEditions(db, "t1").length).toBe(2);
    // Finished work: the same update is refused and nothing changes.
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
    const done = await update.updateTask({ projectId: "p", runId, pmThreadId: "pm", taskId: "t1", task: { ...task, acceptance: ["a3"] } });
    expect(done.ok).toBe(false);
    expect((done.error as { code: string }).code).toBe("task_finished");
  });
});
