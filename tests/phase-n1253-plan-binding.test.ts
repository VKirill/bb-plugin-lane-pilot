import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { createPhaseDriver } from "./phase-driver";
import { registerPhaseTool } from "../src/rooms/phase/server/tool";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { getPhase, listParts, savePhase } from "../src/rooms/phase/store";
import { createRun, openDatabase } from "../src/rooms/plugin-db";
import { saveProjectSetting } from "../src/rooms/storage";
import { phaseRpc } from "../src/rooms/phase/server/rpc";
import type { PlanItem } from "../src/rooms/phase/logic";

// n1253 (/sma-ultraplan-phase): an externally drafted plan enters an existing phase through lane_pilot_phase plan, is signed as plan.sha and is
// checked by a machine-started lp.plan run handed that sha. Two reported gaps are reproduced on the real PhaseApi, SQLite journal and driver
// tick; only the model boundary is stubbed (the workflow engine start/get: what lp.plan returned). No owner word is ever recorded by this file.

const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
afterEach(() => { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; });

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Piece ${id}`, objective: `do ${id}`, kind: "code", owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: [`${id} works`],
  project_cwd: "/repo", ...extra,
});
const piece = (id: string, covers?: string[]): PlanItem => ({ id, title: id, wave: 1, promise: { given: "the repository", when: "the piece lands", then: `${id} is done` }, task: task(id) as never, ...(covers ? { covers } : {}) });
const shape = { objective: "the goal", premortem: ["r1", "r2", "r3"] };

function world(opts: { train?: "off"; ownerWords?: "on" | "off" } = {}) {
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
  if (opts.train === "off") saveProjectSetting(db, "projA", "phase.train", "off");
  // The external plan bounce (a second tool) is its own hold with its own tests; it is off here so that the gates under test are the only ones that can hold admission.
  saveProjectSetting(db, "projA", "phase.plan_bounce", "off");
  if (opts.ownerWords) saveProjectSetting(db, "projA", "owner.words", opts.ownerWords);
  // The model boundary: lp.plan's answer. The run row is written to the SQLite journal the way the engine would: the inputs it was really
  // started with (inputs_json), two sessions of its own (planner and critic), its output.
  const started: Array<{ inputs: Record<string, unknown>; mode?: string }> = [];
  let answer: Record<string, unknown> = {};
  const engine = {
    started,
    // The engine writes a run's output when the run finishes: the journal row is brought to the answer the way it would be.
    answer: (value: Record<string, unknown>) => { answer = value; db.prepare("UPDATE lane_pilot_wf_run SET output_json=? WHERE workflow_id='lp.plan'").run(JSON.stringify(value)); },
    resolveWorkflow: (id: string) => builtinWorkflow(id),
    snapshot: () => null,
    start: (input: { inputs: Record<string, unknown>; mode?: string; link?: { projectId?: string; runId?: string } }) => {
      started.push({ inputs: input.inputs, mode: input.mode });
      const runId = `wf_check_${started.length}`;
      const at = Date.now() + 60_000;
      db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(runId, "lp.plan", 1, "sha", JSON.stringify({ id: "lp.plan", nodes: [{ id: "plan", type: "agent", role: "planner" }, { id: "plan_critic", type: "agent", role: "plan-critic" }] }),
          input.link?.projectId ?? "projA", input.link?.runId ?? null, "succeeded", JSON.stringify(input.inputs), JSON.stringify(answer), at, at);
      for (const [index, [node, thread, from, to]] of ([["plan", "thr_planner", 10, 20], ["plan_critic", "thr_critic", 30, 40]] as const).entries()) {
        db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(runId, `${node}#1`, `${node}#1`, node, index + 1, "succeeded", JSON.stringify({ threadId: thread }), from, to, to);
      }
      return { runId, created: true, done: Promise.resolve() };
    },
    get: (runId: string) => ({ runId, status: "succeeded", output: answer, reason: null, error: null, failedNode: null, waiting: [], stopped: false }),
  };
  const services = { runBudgets: { get: () => undefined }, workflowEngine: engine } as never;
  const ctx = createCore(bb, db);
  const { phases } = createPhaseDriver(ctx, services);
  // The PM's tool, captured from the registration the plugin does for real.
  let phaseTool: { execute: (input: unknown, context: unknown) => Promise<unknown> } | undefined;
  (bb.agents as { registerTool: unknown }).registerTool = (tool: { name: string; execute: NonNullable<typeof phaseTool>["execute"] }) => { if (tool.name === "lane_pilot_phase") phaseTool = tool; };
  registerPhaseTool(ctx, { phases } as never);
  const pm = (input: Record<string, unknown>) => phaseTool!.execute(input, { threadId: "thr_pm", projectId: "projA" });
  return { db, phases, engine, pm, harness };
}

/** The imported plan is handed over: the legacy phase of plan-import's hand-over text, then the PM's plan through the real PhaseApi. */
async function submitted(w: ReturnType<typeof world>, ids = ["a", "b"], items: PlanItem[] = ids.map((id) => piece(id))) {
  const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
  const planned = w.phases.plan({ phaseId: phase.id, items, ...shape, by: "pm" });
  return { id: phase.id, sha: planned.record.plan!.sha };
}

/** lp.plan's own answer for a check: a pass of its critic with these tasks. */
const passWith = (tasks: unknown[]) => ({ status: "ok", plan_verdict: "pass", tasks, waves: [["a"]], task_count: tasks.length, objective: "the goal", has_ui: false });

describe("n1253: an externally drafted plan is bound to what its critic checked", () => {
  it("control: the machine's check run is handed the plan's sha, and a pass over the same pieces admits it", async () => {
    const w = world();
    const { id, sha } = await submitted(w);
    await w.phases.tick();
    expect(w.engine.started).toHaveLength(1);
    expect(w.engine.started[0]!.inputs.plan_sha).toBe(sha);
    expect(w.engine.started[0]!.mode).toBe("full");
    w.engine.answer(passWith([task("a"), task("b")]));
    await w.phases.tick();
    const phase = getPhase(w.db, id)!;
    expect(phase.record.plan!.critique, JSON.stringify(phase.record.plan!.critique)).toMatchObject({ decision: "approve", independence: { ok: true } });
    expect(phase.record.plan!.admittedSha, JSON.stringify([phase.stage, listParts(w.db, id).slice(-3).map((part) => `${part.kind}: ${part.text}`)])).toBe(sha);
    expect(phase.stage).not.toBe("planning");
  });

  // RED on 54be866d (auto-stages "check" forwarded only status and plan_verdict; output.tasks was never compared with plan.items): kept as the regression.
  it("a pass over pieces that are not the submitted ones does not admit the PM's plan, though the run was handed the right plan_sha", async () => {
    const w = world();
    const { id, sha } = await submitted(w);
    await w.phases.tick();
    expect(w.engine.started[0]!.inputs.plan_sha).toBe(sha);
    // The planner rewrote piece b (a wider owned path, another objective) and its critic passed that.
    w.engine.answer(passWith([task("a"), task("b", { objective: "do something else", owns_paths: ["**"] })]));
    await w.phases.tick();
    const phase = getPhase(w.db, id)!;
    // The PM's plan is not replaced by what the run returned, and its sha is the one it was submitted with…
    expect(phase.record.plan!.items.map((item) => item.task.owns_paths)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(phase.record.plan!.sha).toBe(sha);
    // …the pass is not recorded as an approval of it, and the reason says what happened…
    expect(phase.record.plan!.critique, JSON.stringify(phase.record.plan!.critique)).toMatchObject({ decision: "changes_requested", summary: expect.stringContaining("did not check the submitted plan") });
    // …and nothing is admitted.
    expect(phase.record.plan!.admittedSha).toBeUndefined();
    expect(phase.stage).toBe("planning");
  });

  it.each([
    ["no tasks field", { status: "ok", plan_verdict: "pass" }],
    ["an empty task list", passWith([])],
    ["a task list that is not a list", { ...passWith([]), tasks: "a, b" }],
    ["a missing piece", passWith([task("a")])],
    ["a piece added", passWith([task("a"), task("b"), task("c")])],
    ["a piece under another id", passWith([task("a"), task("z")])],
    ["a piece without an id", passWith([task("a"), { ...task("b"), id: undefined }])],
    ["an extra task without an id (the planner's reader drops it)", passWith([task("a"), task("b"), { title: "stray", owns_paths: ["**"] }])],
    ["an extra task with a numeric id", passWith([task("a"), task("b"), { ...task("c"), id: 5 }])],
    ["a duplicated id on top of the pieces", passWith([task("a"), task("b"), task("b", { owns_paths: ["**"] })])],
    ["a duplicated id in place of a piece", passWith([task("a"), task("a")])],
    ["a changed check command", passWith([task("a"), task("b", { verification: [{ command: "true" }] })])],
  ])("a pass whose output is %s cannot approve or admit the submitted plan", async (_name, answer) => {
    const w = world();
    const { id } = await submitted(w);
    await w.phases.tick();
    w.engine.answer(answer as Record<string, unknown>);
    await w.phases.tick();
    const phase = getPhase(w.db, id)!;
    expect(phase.record.plan!.critique).toMatchObject({ decision: "changes_requested" });
    expect(phase.record.plan!.admittedSha).toBeUndefined();
    expect(phase.record.plan!.items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("an owner-asked plan with a mismatched pass records no word and nothing is admitted", async () => {
    const w = world({ ownerWords: "on" });
    const { id } = await submitted(w);
    await w.phases.tick();
    w.engine.answer(passWith([task("a"), task("b", { owns_paths: ["**"] })]));
    await w.phases.tick();
    const phase = getPhase(w.db, id)!;
    expect(phase.record.plan!.admittedSha).toBeUndefined();
    expect(phase.record.words ?? []).toEqual([]);
  });

  it("with the owner's word asked, a bound independent pass still waits for it: nothing here records a word", async () => {
    const w = world({ ownerWords: "on" });
    const { id } = await submitted(w);
    await w.phases.tick();
    w.engine.answer(passWith([task("a"), task("b")]));
    await w.phases.tick();
    const phase = getPhase(w.db, id)!;
    expect(phase.record.plan!.critique, JSON.stringify(phase.record.plan!.critique)).toMatchObject({ decision: "approve", independence: { ok: true } });
    expect(phase.record.plan!.admittedSha).toBeUndefined();
    expect(phase.stage).toBe("planning");
    expect(phase.record.words ?? []).toEqual([]);
  });
});

describe("n1253: the PM's entry for an external plan under phase.train", () => {
  const taskV2 = { schema_version: 2 as const, id: "a", title: "A", risk: "low" as const, lane: "core", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["f"], owns_paths: ["src/a.ts"], never_touch: [], depends_on: [], objective: "do a", acceptance: ["a works"], verify: "none" as const,
    verification: [{ command: "npm test -- a", cwd: "." }] };
  const items = [{ id: "a", title: "a", wave: 1, promise: { given: "the repository", when: "the piece lands", then: "a is done" }, task: taskV2 }];

  it("control: with phase.train off the same call stores the plan and the machine then checks it", async () => {
    const w = world({ train: "off" });
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    const answer = String(await w.pm({ action: "plan", phaseId: phase.id, items, ...shape }));
    expect(getPhase(w.db, phase.id)!.record.plan?.items, answer).toHaveLength(1);
  });

  // Expected RED on 54be866d: plan-import's hand-over text is `open legacy:true` then `plan`; under the default phase.train the machine owns the plan stage.
  it("a legacy phase takes the PM's imported plan under the default phase.train instead of planning over it", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    const answer = String(await w.pm({ action: "plan", phaseId: phase.id, items, ...shape }));
    expect(answer).not.toMatch(/Lane Pilot runs this stage itself/);
    expect(getPhase(w.db, phase.id)!.record.plan?.items.map((item) => item.id), answer).toEqual(["a"]);
  });

  it("the imported plan entered under the default phase.train is then checked by the machine, handed that plan's sha", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    await w.pm({ action: "plan", phaseId: phase.id, items, ...shape });
    const sha = getPhase(w.db, phase.id)!.record.plan!.sha;
    await w.phases.tick();
    expect(w.engine.started.map((run) => run.inputs.plan_sha)).toEqual([sha]);
    expect(getPhase(w.db, phase.id)!.record.auto?.kind).toBe("check");
  });

  it("control: a paused legacy phase is not woken by the entry: the plan is stored as before and the machine starts nothing", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    w.phases.setState({ phaseId: phase.id, state: "pause", by: "pm" });
    expect(getPhase(w.db, phase.id)!.state).toBe("paused");
    await w.pm({ action: "plan", phaseId: phase.id, items, ...shape });
    await w.phases.tick();
    expect(w.engine.started).toHaveLength(0);
    expect(getPhase(w.db, phase.id)!.record.auto).toBeUndefined();
  });

  const refused = (answer: unknown) => expect(String(answer)).toMatch(/Lane Pilot runs this stage itself/);

  it("negative: a legacy phase whose own plan run is already in flight still refuses the PM's plan", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    await w.phases.tick();
    expect(getPhase(w.db, phase.id)!.record.auto?.kind).toBe("plan");
    refused(await w.pm({ action: "plan", phaseId: phase.id, items, ...shape }));
    expect(getPhase(w.db, phase.id)!.record.plan).toBeUndefined();
  });

  it("negative: a phase that is not legacy refuses the PM's plan when the machine owns the stage", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    const record = getPhase(w.db, phase.id)!.record;
    savePhase(w.db, phase.id, { record: { ...record, context: { ...record.context!, legacy: false } }, at: Date.now() });
    refused(await w.pm({ action: "plan", phaseId: phase.id, items, ...shape }));
    expect(getPhase(w.db, phase.id)!.record.plan).toBeUndefined();
  });

  it("negative: a legacy phase whose plan was sent back for changes is replanned by the machine, the PM's plan is not put over it", async () => {
    const w = world();
    const { id } = await submitted(w);
    await w.phases.tick();
    w.engine.answer(passWith([task("a"), task("b", { owns_paths: ["**"] })]));
    await w.phases.tick();
    expect(getPhase(w.db, id)!.record.plan!.critique).toMatchObject({ decision: "changes_requested" });
    refused(await w.pm({ action: "plan", phaseId: id, items, ...shape }));
  });

  it("negative: the entry opens nothing but action plan (plan_check on the same legacy phase stays refused)", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    refused(await w.pm({ action: "plan_check", phaseId: phase.id, decision: "approve", by: "pm", summary: "ok" }));
  });
});

describe("n1253: the coverage of a piece is part of what the critic must have checked", () => {
  // An empty `covers` list can really be stored, by every door: the registered tool keeps it (an item-level list passes through `...row`, a task-level one is lifted
  // to the item), phase_act over RPC hands payload.items to api.plan with no schema, and records of older versions keep what they were given. The echo of such a plan
  // carries no covers (planItems omits an empty list).
  const admitted = async (w: ReturnType<typeof world>, id: string, sha: string, tasks: unknown[]) => {
    await w.phases.tick();
    expect(w.engine.started[0]!.inputs.plan_sha).toBe(sha);
    w.engine.answer(passWith(tasks));
    await w.phases.tick();
    return getPhase(w.db, id)!;
  };

  it("the registered tool keeps an empty covers list as sent (item level) or lifts it (task level), and the checked plan is admitted either way", async () => {
    const seen: Record<string, string> = {};
    for (const where of ["item", "task"] as const) {
      const w = world();
      const taskV2 = { schema_version: 2, id: "a", title: "A", risk: "low", lane: "core", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["f"],
        owns_paths: ["src/a.ts"], never_touch: [], depends_on: [], objective: "do a", acceptance: ["a works"], verify: "none", verification: [{ command: "npm test -- a", cwd: "." }] };
      const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
      const row = { id: "a", title: "a", wave: 1, promise: { given: "the repository", when: "the piece lands", then: "a is done" }, ...(where === "item" ? { task: taskV2, covers: [] } : { task: { ...taskV2, covers: [] } }) };
      await w.pm({ action: "plan", phaseId: phase.id, items: [row], ...shape });
      const stored = getPhase(w.db, phase.id)!.record.plan!;
      expect(stored.items.map((item) => item.id), where).toEqual(["a"]);
      seen[where] = JSON.stringify(stored.items[0]!.covers ?? "absent");
      const done = await admitted(w, phase.id, stored.sha, [{ ...stored.items[0]!.task }]);
      expect(done.record.plan!.admittedSha, where).toBe(stored.sha);
    }
    expect(seen).toEqual({ item: "[]", task: "[]" });
  });

  it("phase_act over RPC stores covers: [] as it was sent, and the critic's pass over an exact echo of that plan is its approval, not a drift", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    await phaseRpc(w.phases).phase_act({ action: "plan", projectId: "projA", pmThreadId: "thr_pm", phaseId: phase.id, payload: { items: [piece("a", []), piece("b")] } } as never);
    const stored = getPhase(w.db, phase.id)!.record.plan!;
    expect(stored.items.map((item) => item.covers)).toEqual([[], undefined]);
    const done = await admitted(w, phase.id, stored.sha, [task("a"), task("b")]);
    // The RPC door carries no objective or pre-mortem, so the plan gate holds admission there on its own account; what is under test is that the check approves.
    expect(done.record.plan!.critique, JSON.stringify(done.record.plan!.critique)).toMatchObject({ decision: "approve", independence: { ok: true } });
  });

  it("an already persisted plan with covers: [] is admitted whether the run echoes no covers or an empty list", async () => {
    for (const echo of [{}, { covers: [] }]) {
      const w = world();
      const { id, sha } = await submitted(w, ["a", "b"], [piece("a", []), piece("b")]);
      const done = await admitted(w, id, sha, [task("a", echo), task("b")]);
      expect(done.record.plan!.admittedSha, JSON.stringify(echo)).toBe(sha);
    }
  });

  it.each([
    ["a changed list", [piece("a", ["R1", "R2"]), piece("b")], { covers: ["R1", "R9"] }],
    ["a removed item", [piece("a", ["R1", "R2"]), piece("b")], { covers: ["R1"] }],
    ["a removed list", [piece("a", ["R1"]), piece("b")], {}],
    ["an empty list echoed for a covered piece", [piece("a", ["R1"]), piece("b")], { covers: [] }],
    ["a list added to a piece with none", [piece("a"), piece("b")], { covers: ["R1"] }],
    ["a list added to a piece with an empty one", [piece("a", []), piece("b")], { covers: ["R1"] }],
  ])("a pass over %s of covers only does not admit the plan", async (_name, items, echo) => {
    const w = world();
    const { id, sha } = await submitted(w, ["a", "b"], items as PlanItem[]);
    const done = await admitted(w, id, sha, [task("a", echo), task("b")]);
    expect(done.record.plan!.critique).toMatchObject({ decision: "changes_requested", summary: expect.stringContaining("did not check the submitted plan") });
    expect(done.record.plan!.admittedSha).toBeUndefined();
  });

  it("the same non-empty covers are admitted (control for the covers-only refusals)", async () => {
    const w = world();
    const { id, sha } = await submitted(w, ["a", "b"], [piece("a", ["R1", "R2"]), piece("b")]);
    const done = await admitted(w, id, sha, [task("a", { covers: ["R1", "R2"] }), task("b")]);
    expect(done.record.plan!.admittedSha).toBe(sha);
  });

  it("the tool's schema stays strict: empty elements and more than 40 covers are rejected, a valid list is stored", async () => {
    const taskV2 = { schema_version: 2, id: "a", title: "A", risk: "low", lane: "core", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["f"],
      owns_paths: ["src/a.ts"], never_touch: [], depends_on: [], objective: "do a", acceptance: ["a works"], verify: "none", verification: [{ command: "npm test -- a", cwd: "." }] };
    const row = (covers: string[]) => ({ id: "a", title: "a", wave: 1, promise: { given: "the repository", when: "the piece lands", then: "a is done" }, task: taskV2, covers });
    for (const [name, covers, ok] of [["an empty element", [""], false], ["41 covers", Array.from({ length: 41 }, (_, i) => `R${i}`), false], ["40 covers", Array.from({ length: 40 }, (_, i) => `R${i}`), true], ["a valid list", ["R1"], true]] as const) {
      const w = world();
      const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
      await w.pm({ action: "plan", phaseId: phase.id, items: [row([...covers])], ...shape });
      expect(!!getPhase(w.db, phase.id)!.record.plan, name).toBe(ok);
    }
  });
});

describe("n1253: the machine may start its own plan run while the entry reads the checkout", () => {
  it("a run started in that window refuses the PM's plan before api.plan stores it", async () => {
    const w = world();
    const phase = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Imported", goal: "ship the imported plan", legacy: true });
    let racing = false;
    // The await inside the tool's `plan` action is the PM thread lookup: the machine's tick lands in it, as a concurrent pass would.
    w.harness.sdk.stub("threads.get" as never, async () => { if (!racing) { racing = true; await w.phases.tick(); } return { status: "idle" }; });
    const answer = String(await w.pm({ action: "plan", phaseId: phase.id, items: [{ id: "a", title: "a", wave: 1, promise: { given: "the repository", when: "the piece lands", then: "a is done" }, task: { schema_version: 2, id: "a", title: "A", risk: "low", lane: "core", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["f"], owns_paths: ["src/a.ts"], never_touch: [], depends_on: [], objective: "do a", acceptance: ["a works"], verify: "none", verification: [{ command: "npm test -- a", cwd: "." }] } }], ...shape }));
    expect(racing).toBe(true);
    expect(getPhase(w.db, phase.id)!.record.auto?.kind).toBe("plan");
    expect(answer).toMatch(/Lane Pilot runs this stage itself \(run /);
    expect(getPhase(w.db, phase.id)!.record.plan).toBeUndefined();
  });
});
