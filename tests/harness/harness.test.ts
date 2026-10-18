import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, createTask, openDatabase } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import { HARNESS_DEFAULTS, briefParts, checkCommands, createHarness, inferForm } from "../../src/rooms/harness/server/harness";
import { activeHarness, getHarness, insertHarness, listHarnesses } from "../../src/rooms/harness/server/store";
import { TRIAL_DEFAULTS } from "../../src/rooms/harness/server/trial";

const DAY = 86_400_000;
const WRITER = "codex/gpt-6-luna";
const TREE = { "always-on.md": "Run the spec next to the file.", "memory.md": "- note one\n- note two" };

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

function setup() {
  const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  dispose = () => fake.lifecycle.dispose();
  // Only editors need the services (the writer host); none of these tests runs one.
  const harness = createHarness(ctx, {} as never);
  createRun(db, "run1", "proj");
  return { bb, db, harness };
}
type Db = ReturnType<typeof setup>["db"];

let n = 0;
function attempt(db: Db, task: string, extra: { id?: string; threadId?: string | null; run?: string; at?: number } = {}): string {
  const id = extra.id ?? `att${++n}`;
  createTask(db, { id: `${task}-${id}`, runId: extra.run ?? "run1", kind: "bb", contract: {} });
  const at = extra.at ?? Date.now();
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, extra.run ?? "run1", `${task}-${id}`, extra.threadId ?? null, "running", 1, at, at);
  return id;
}
const armOf = (db: Db, id: string) => db.prepare("SELECT harness_tree_id AS tree, harness_arm AS arm FROM lane_pilot_attempt WHERE id=?").get(id) as { tree: string | null; arm: string | null };

describe("pure helpers", () => {
  it("briefParts splits memory notes and exposes always-on, skills and checks", () => {
    const tree = { ...TREE, "memory.md": "# Notes\n- note one\n  * nested two\nplain text\n* note three", "checks/a.sh": "exit 0", "skills/s1/SKILL.md": "---\nname: s1\n---" };
    const parts = briefParts({ id: "hrn_1", tree }, "new");
    expect(parts).toMatchObject({ harnessId: "hrn_1", arm: "new", alwaysOn: "Run the spec next to the file.", skillNames: ["s1"], checkNames: ["checks/a.sh"] });
    expect(parts.memory.split("\n")).toEqual(["- note one", "* nested two", "* note three"]);
    expect(briefParts({ id: "hrn_2", tree: {} }, null)).toMatchObject({ arm: null, alwaysOn: "", memory: "", skillNames: [], checkNames: [] });
  });

  it("checkCommands maps check scripts to the runner of their extension", () => {
    expect(checkCommands({ "checks/x.sh": "", "checks/y.py": "", "checks/z.mjs": "", "always-on.md": "x" })).toEqual([
      { command: "bash .lane-pilot/harness/checks/x.sh", timeout_sec: 60 },
      { command: "python3 .lane-pilot/harness/checks/y.py", timeout_sec: 60 },
      { command: "node .lane-pilot/harness/checks/z.mjs", timeout_sec: 60 },
    ]);
    expect(checkCommands({})).toEqual([]);
  });

  it("inferForm routes a lesson by the component it names", () => {
    expect(inferForm("Add a check that the spec passes")).toBe("check");
    expect(inferForm("run the verification before finishing")).toBe("check");
    expect(inferForm("write checks/x.sh for it")).toBe("check");
    expect(inferForm("Create a skill for migrations")).toBe("skill");
    expect(inferForm("Add a PreToolUse hook")).toBe("hook");
    expect(inferForm("Keep it in memory")).toBe("memory");
    expect(inferForm("Add a note about the schema")).toBe("memory");
    expect(inferForm("Always run the spec next to the file")).toBe("always");
  });
});

describe("createHarness", () => {
  it("round-trips the config through kv and merges nested defaults", async () => {
    const { harness } = setup();
    expect(await harness.config("proj")).toEqual(HARNESS_DEFAULTS);
    const next = await harness.setConfig("proj", { minAttempts: 9, editor: { model: "other" } as never, trial: { minPerArm: 2 } as never });
    expect(next.minAttempts).toBe(9);
    expect(next.editor).toEqual({ ...HARNESS_DEFAULTS.editor, model: "other" });
    expect(next.trial).toEqual({ ...TRIAL_DEFAULTS, minPerArm: 2 });
    expect(await harness.config("proj")).toEqual(next);
    expect(await harness.config("another")).toEqual(HARNESS_DEFAULTS);
  });

  it("forAttempt without a trial assigns the base tree with arm null and empty alwaysOn and memory", async () => {
    const { db, harness } = setup();
    const id = attempt(db, "t");
    const parts = await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId: id });
    expect(parts).not.toBeNull();
    expect(parts).toMatchObject({ arm: null, alwaysOn: "", memory: "", skillNames: [], checkNames: [] });
    const base = activeHarness(db, "proj", "billing", WRITER);
    expect(base.state).toBe("base");
    expect(parts!.harnessId).toBe(base.id);
    expect(armOf(db, id)).toEqual({ tree: base.id, arm: null });
  });

  it("forAttempt serves the adopted tree without an arm", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const adopted = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, tree: TREE, state: "adopted", createdBy: "editor", parentId: base.id });
    const id = attempt(db, "t");
    const parts = await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId: id });
    expect(parts).toMatchObject({ harnessId: adopted.id, arm: null, alwaysOn: TREE["always-on.md"] });
    expect(armOf(db, id)).toEqual({ tree: adopted.id, arm: null });
  });

  it("forAttempt returns null when harness editing is off for the project", async () => {
    const { db, harness } = setup();
    await harness.setConfig("proj", { enabled: false });
    const id = attempt(db, "t");
    expect(await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId: id })).toBeNull();
    expect(armOf(db, id)).toEqual({ tree: null, arm: null });
  });

  it("forAttempt alternates new, old, new under a trial and records the tree and arm", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE });
    const ids = [attempt(db, "t"), attempt(db, "t"), attempt(db, "t")];
    const results = [];
    for (const attemptId of ids) results.push(await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId }));
    expect(results.map((r) => r?.arm)).toEqual(["new", "old", "new"]);
    expect(results[0]).toMatchObject({ harnessId: trial.id, alwaysOn: TREE["always-on.md"] });
    expect(results[0]!.memory.split("\n")).toEqual(["- note one", "- note two"]);
    expect(results[1]).toMatchObject({ harnessId: base.id, alwaysOn: "", memory: "" });
    expect(ids.map((id) => armOf(db, id))).toEqual([
      { tree: trial.id, arm: "new" }, { tree: base.id, arm: "old" }, { tree: trial.id, arm: "new" },
    ]);
  });

  it("forAttempt under a trial for any writer (*) applies to every writer of the area", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", "*");
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: "*", state: "trial", createdBy: "editor", parentId: base.id, tree: TREE });
    const parts = await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId: attempt(db, "t") });
    expect(parts).toMatchObject({ harnessId: trial.id, arm: "new" });
  });

  it("checksForWriterThread finds the attempt by (runId, taskId, threadId) and returns its tree's checks", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const adopted = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "adopted", createdBy: "editor", parentId: base.id, tree: { "checks/x.sh": "exit 0", "checks/y.py": "pass" } });
    const id = attempt(db, "t", { threadId: "thr-1" });
    const taskId = (db.prepare("SELECT task_id AS t FROM lane_pilot_attempt WHERE id=?").get(id) as { t: string }).t;
    await harness.forAttempt({ projectId: "proj", area: "billing", writerKey: WRITER, attemptId: id });
    expect(getHarness(db, adopted.id)).not.toBeNull();
    expect(harness.checksForWriterThread("run1", taskId, "thr-1")).toEqual([
      { command: "bash .lane-pilot/harness/checks/x.sh", timeout_sec: 60 },
      { command: "python3 .lane-pilot/harness/checks/y.py", timeout_sec: 60 },
    ]);
    expect(harness.checksForWriterThread("run1", taskId, "other-thread")).toEqual([]);
    expect(harness.checksForWriterThread("run1", "no-such-task", "thr-1")).toEqual([]);
    expect(harness.checksForAttempt(id)).toHaveLength(2);
    expect(harness.checksForAttempt("missing")).toEqual([]);
  });

  it("evaluateTrials with dryRun returns a wait decision for a fresh trial and changes no state", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE, now: 1000 * DAY });
    const out = await harness.evaluateTrials("proj", { dryRun: true, now: 1000 * DAY + DAY });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: trial.id, area: "billing", writerKey: WRITER });
    expect(out[0].decision.action).toBe("wait");
    expect(getHarness(db, trial.id)!.state).toBe("trial");
    // Without dryRun a waiting trial is left alone as well.
    expect((await harness.evaluateTrials("proj", { now: 1000 * DAY + DAY }))[0].decision.action).toBe("wait");
    expect(getHarness(db, trial.id)!.state).toBe("trial");
  });

  it("evaluateTrials retires an unused trial after maxDays", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE, now: 1000 * DAY });
    const out = await harness.evaluateTrials("proj", { now: 1000 * DAY + TRIAL_DEFAULTS.maxDays * DAY });
    expect(out[0].decision.action).toBe("retire");
    const row = getHarness(db, trial.id)!;
    expect(row.state).toBe("retired");
    expect(row.reason).toMatch(/^unused/);
    expect(activeHarness(db, "proj", "billing", WRITER).id).toBe(base.id);
  });

  it("status returns active trees and trials", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE });
    const status = await harness.status("proj");
    expect(status.config).toEqual(HARNESS_DEFAULTS);
    expect(status.active.map((row) => ({ id: row.id, state: row.state }))).toEqual([{ id: base.id, state: "base" }]);
    expect(status.trials).toHaveLength(1);
    expect(status.trials[0]).toMatchObject({ id: trial.id, area: "billing", writerKey: WRITER });
    expect(status.trials[0].decision.action).toBe("wait");
    expect(status.retired).toEqual([]);
    expect(status.running).toEqual([]);
    expect(listHarnesses(db, "proj")).toHaveLength(2);
  });
});
