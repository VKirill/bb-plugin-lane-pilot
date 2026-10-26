import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { createPhaseDriver } from "../src/rooms/phase/server/driver";
import { planSignature, type PlanItem } from "../src/rooms/phase/logic";
import { listParts, savePhase } from "../src/rooms/phase/store";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../src/rooms/storage";
import { createWall, type WallPorts } from "../src/rooms/wall/service";

/**
 * loop_exhausted: the four places that used to end an exhausted loop in the PM chat end it in the machine. Here the two phase places
 * (a stage whose workflow failed twice, the replans after a failed verification) run through the real driver and the real wall:
 * the scope is cut, the hunters read it, a backlog item and a morning-list line appear, the PM chat is not woken (the book and the morning list carry it) and gets no stage.
 */
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const toPm: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { toPm.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  setRunThread(db, "run1", "thr_pm");
  const state = { readerCalls: [] as string[], replies: [] as string[], told: [] as Array<{ thread: string; text: string }>, deferrals: new Map<string, string>(), wf: 0 };
  const ports = {
    now: () => NOW, version: "0.1.336", loadScope: async () => ({ isReal: () => true, scopeOf: () => "real" as const }), logLines: () => [], codeFiles: async () => [],
    reader: async (_prompt: string, who: string) => { state.readerCalls.push(who); return { text: state.replies.shift() ?? null, tokens: 50_000 }; },
    tellPm: async (thread: string, text: string) => { state.told.push({ thread, text }); return true; },
    deferrals: { open: (input: { id: string; what: string }) => { state.deferrals.set(input.id, input.what); }, close: () => undefined },
  } as unknown as WallPorts;
  const kv = new Map<string, unknown>();
  const wall = createWall({ db, kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } as never, ports, log: () => undefined });
  const services = {
    wall, rollback: {},
    workflowEngine: {
      start: () => ({ runId: `wf${++state.wf}`, created: true, done: new Promise(() => undefined) }),
      get: (runId: string) => ({ runId, status: "failed", output: null, error: "the planner crashed", reason: null, failedNode: null, waiting: [], stopped: false }),
    },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  const book = (phaseId: string) => listParts(db, phaseId).map((part) => ({ kind: part.kind, text: part.text }));
  const ownerItems = () => db.prepare("SELECT key, source, kind, what, why, wake, state FROM lane_pilot_owner_item").all() as Array<{ key: string; source: string; kind: string; what: string; why: string; wake: number; state: string }>;
  return { db, phases, wall, state, toPm, book, ownerItems };
}

const piece = (id: string): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: `${id} works` }, task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: "npm test" }] } });

describe("a stage whose workflow failed twice", () => {
  it("is ended by the machine: nothing proved stops the phase, the hunters read it, the backlog and the morning list get one item, the PM chat is not woken", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Notes", goal: "a notes module" });
    savePhase(w.db, phase.id, { runId: "run1", record: phase.record, at: 1 });
    for (let pass = 0; pass < 4; pass += 1) await w.phases.tick();
    const after = w.phases.list({ limit: 5 }).find((row) => row.id === phase.id)!;
    expect(after.state).toBe("stopped");
    expect(after.record.autoFailures).toEqual({ analyze: 2 });
    const kinds = w.book(phase.id).map((part) => part.kind);
    expect(kinds).toEqual(expect.arrayContaining(["auto_failed", "scope_withdrawn", "exhausted_stop"]));
    expect(JSON.stringify(w.book(phase.id))).not.toMatch(/stage is the PM's|waits for a person/);
    // The stage is not handed to the PM, and an informational note does not wake its chat: no message, no step poked after the loop ended.
    expect(w.state.told).toHaveLength(0);
    const pokesBefore = w.toPm.length;
    await w.phases.tick();
    expect(w.toPm.length).toBe(pokesBefore);

    // One wall for the subject, waiting for its hunters; asking again creates nothing.
    const walls = w.db.prepare("SELECT wall_key, state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:stage:%'").all() as Array<{ wall_key: string; state: string }>;
    expect(walls).toEqual([expect.objectContaining({ state: "stopped" })]);
    const pack = (w.wall.show(walls[0]!.wall_key).wall!.pack as { files: Array<{ path: string; text: string }> });
    const bookFile = pack.files.find((file) => file.path === "PHASE-BOOK")!;
    const quote = /lp\.analyze did not finish \(the planner crashed\)/.exec(bookFile.text)![0];
    w.state.replies.push(
      JSON.stringify({ verdict: "env_fault", summary: "the analysis workflow crashes before it reads anything", action: "self_repair", evidence: [{ kind: "file", ref: "PHASE-BOOK", quote }] }),
      "not json", "not json", "# analysis\nthe proposed next step: fix the workflow's crash",
    );
    await w.wall.advance(NOW);
    expect(w.state.readerCalls).toEqual(["hunter", "hunter", "hunter", "analysis"]);
    const wall = w.wall.show(walls[0]!.wall_key).wall!;
    expect(wall).toMatchObject({ state: "backlog", hunt: "usable" });
    expect((wall.analysis as { text: string }).text).toMatch(/proposed next step/);
    expect(w.state.deferrals.size).toBe(1);
    const items = w.ownerItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "wall", kind: "loop_exhausted", wake: 0, state: "open" });
    expect(items[0]!.why).toMatch(/Scope cut.*phase stops/s);
    expect(items[0]!.why).toMatch(/Ничего не ждёт тебя/);
    await w.wall.advance(NOW + 1000);
    await w.wall.loopExhausted({ kind: "stage", id: `${phase.id}:analyze`, title: "again", projectId: "projA", done: "x", facts: [] });
    expect(w.state.readerCalls).toHaveLength(4);
    expect(w.ownerItems()).toHaveLength(1);
    expect(w.state.deferrals.size).toBe(1);
  });
});

describe("a verification that failed after the machine's replans", () => {
  function failedPhase(w: ReturnType<typeof world>, phaseId: string) {
    const items = [piece("a"), piece("b")];
    const sha = planSignature(items, "ctx");
    for (const [id, state] of [["a", "accepted"], ["b", "blocked"]] as const) {
      createTask(w.db, { id, runId: "run1", kind: "bb", contract: piece(id).task });
      createAttempt(w.db, { id: `att_${id}`, runId: "run1", taskId: id });
      w.db.prepare("UPDATE lane_pilot_attempt SET state=?, reason=? WHERE id=?").run(state, state === "blocked" ? "verification failed (npm test): 1 failed in b.test.ts" : null, `att_${id}`);
    }
    savePhase(w.db, phaseId, { stage: "verification", runId: "run1", at: 2, record: {
      plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } },
      execution: { issued: { a: "a", b: "b" }, startedAt: 1 },
      verification: { verdict: { state: "failed", detail: "b not accepted", inputSha: "x", at: 1, mainSha: null } },
      replan: { count: 2 },
    } as never });
  }

  it("withdraws the unproved piece, closes the phase on the proved one, and ends in one backlog item and one morning line", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Notes", goal: "a notes module" });
    failedPhase(w, phase.id);
    await w.phases.tick();
    const after = w.phases.list({ limit: 5 }).find((row) => row.id === phase.id)!;
    expect(after).toMatchObject({ stage: "closed", state: "closed" });
    expect(after.record.plan!.items.map((item) => item.id)).toEqual(["a"]);
    expect(after.record.scope!.withdrawn).toEqual(["b"]);
    expect(after.record.closing).toMatchObject({ by: "Lane Pilot (loop exhausted)" });
    const book = w.book(phase.id);
    expect(book.map((part) => part.kind)).toEqual(expect.arrayContaining(["replans_spent", "scope_withdrawn", "exhausted_close"]));
    expect(book.find((part) => part.kind === "scope_withdrawn")!.text).toMatch(/^b withdrawn by Lane Pilot \(loop exhausted at replan\).*b not accepted/);
    expect(JSON.stringify(book)).not.toMatch(/stage is the PM's|waits for a person/);
    expect(w.state.told).toHaveLength(0);
    expect(after.record.closing!.words).toMatch(/closes on its 1 proved piece\(s\) \(a\)/);
    // The hunters' evidence is the attempts of the pieces that tried, with their red reasons.
    await w.wall.advance(NOW);
    expect(w.state.readerCalls.filter((who) => who === "hunter")).toHaveLength(3);
    const wallRow = w.db.prepare("SELECT pack_json, state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:replan:%'").get() as { pack_json: string; state: string };
    expect(wallRow.state).toBe("backlog");
    expect(JSON.parse(wallRow.pack_json).attempts.map((attempt: { state: string }) => attempt.state).sort()).toEqual(["accepted", "blocked"]);
    expect(w.ownerItems()).toHaveLength(1);
    expect(w.state.deferrals.size).toBe(1);
    // The closed phase is not driven again into the same outcome.
    await w.phases.tick();
    expect(w.state.told).toHaveLength(0);
  });
});
