import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { saveVerdict, setBenchProject } from "../../src/rooms/bench/store";
import { createCore } from "../../src/rooms/core/server/core";
import { HARNESS_DEFAULTS, createHarness } from "../../src/rooms/harness/server/harness";
import { activeHarness, getHarness, insertHarness, teachingKeys } from "../../src/rooms/harness/server/store";
import { decideTrial, TRIAL_DEFAULTS } from "../../src/rooms/harness/server/trial";
import type { ArmAttempt } from "../../src/rooms/harness/server/store";
import { createRun, createTask, openDatabase } from "../../src/rooms/storage/database";

const DAY = 86_400_000;
const WRITER = "codex/gpt-6-luna";
const TREE = { "always-on.md": "Run the spec next to the file." };
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

function setup() {
  const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  dispose = () => fake.lifecycle.dispose();
  createRun(db, "run1", "proj");
  createRun(db, "run_bench", "proj_bench");
  return { db, harness: createHarness(createCore(bb, db), {} as never) };
}
type Db = ReturnType<typeof setup>["db"];

let n = 0;
function attempt(db: Db, input: { run?: string; area?: string; state?: string; tree?: string; arm?: "new" | "old"; at?: number; no?: number }): string {
  const id = `att${++n}`, run = input.run ?? "run1", at = input.at ?? 1000 * DAY;
  createTask(db, { id: `task${n}`, runId: run, kind: "bb", contract: { area: input.area ?? "billing" } });
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at,harness_tree_id,harness_arm) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, run, `task${n}`, null, input.state ?? "running", input.no ?? 1, at, at, input.tree ?? null, input.arm ?? null);
  return id;
}

describe("harness.adopt_by = bench", () => {
  const row = (arm: "new" | "old", state: string, i: number): ArmAttempt => ({ attemptId: `x${i}`, taskId: `t${i}`, state, attemptNo: 1, arm, blockingFindings: 0, createdAt: 0 });
  const live = [...Array.from({ length: 6 }, (_, i) => row("new", "accepted", i)), ...Array.from({ length: 6 }, (_, i) => row("old", i < 3 ? "accepted" : "blocked", 10 + i))];

  it("decideTrial: the live alternation alone would adopt; with adopt_by=bench it waits for a passed comparison", () => {
    expect(decideTrial(live, 0, DAY, TRIAL_DEFAULTS).action).toBe("adopt");
    expect(decideTrial(live, 0, DAY, TRIAL_DEFAULTS, { adoptBy: "live", verdict: null }).action).toBe("adopt");
    const waiting = decideTrial(live, 0, DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: null });
    expect(waiting.action).toBe("wait");
    expect(waiting.reason).toMatch(/waits for a passed bench comparison/);
    expect(decideTrial(live, 0, DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: { passed: true, summary: "B vs A" } }).action).toBe("adopt");
    // A failed comparison retires the tree whatever the live arms say; a passed one adopts it before the live arms have enough attempts.
    expect(decideTrial(live, 0, DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: { passed: false, summary: "B vs A" } }).action).toBe("retire");
    expect(decideTrial([], 0, DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: { passed: true, summary: "B vs A" } }).action).toBe("adopt");
  });

  it("a tree that is worse or unused in the live alternation is still retired without a bench comparison", () => {
    const worse = [...Array.from({ length: 6 }, (_, i) => row("new", "blocked", i)), ...Array.from({ length: 6 }, (_, i) => row("old", "accepted", 10 + i))];
    expect(decideTrial(worse, 0, DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: null }).action).toBe("retire");
    expect(decideTrial([], 0, 15 * DAY, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: null }).action).toBe("retire");
  });

  it("evaluateTrials adopts a tree only after the bench passed it, retires it when the bench failed it, and live mode keeps the old rule", async () => {
    const { db, harness } = setup();
    expect((await harness.config("proj")).adoptBy).toBe("bench");
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE, now: 1000 * DAY });
    for (let i = 0; i < 6; i++) { attempt(db, { state: "accepted", tree: trial.id, arm: "new", at: 1000 * DAY + i }); attempt(db, { state: i < 3 ? "accepted" : "blocked", tree: base.id, arm: "old", at: 1000 * DAY + i }); }
    const now = 1000 * DAY + DAY;

    const first = await harness.evaluateTrials("proj", { now });
    expect(first[0]!.decision.action).toBe("wait");
    expect(getHarness(db, trial.id)!.state).toBe("trial");

    const set = "benchset_v1";
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES(?,?,?,?,?,?)").run(set, "v1", "h", 0, 0, 1);
    saveVerdict(db as never, { setId: set, armA: "base", armB: "cand", harnessId: trial.id, passed: true, report: { armA: "base", armB: "cand" } });
    const second = await harness.evaluateTrials("proj", { now });
    expect(second[0]!.decision.action).toBe("adopt");
    expect(getHarness(db, trial.id)!.state).toBe("adopted");
  });

  it("evaluateTrials retires a tree the bench failed", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE, now: 1000 * DAY });
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES(?,?,?,?,?,?)").run("benchset_v1", "v1", "h", 0, 0, 1);
    saveVerdict(db as never, { setId: "benchset_v1", armA: "base", armB: "cand", harnessId: trial.id, passed: false, report: {} });
    const out = await harness.evaluateTrials("proj", { now: 1000 * DAY + DAY });
    expect(out[0]!.decision.action).toBe("retire");
    expect(getHarness(db, trial.id)!.state).toBe("retired");
    expect(getHarness(db, trial.id)!.reason).toMatch(/^bench failed/);
  });

  it("adopt_by=live is the old rule", async () => {
    const { db, harness } = setup();
    await harness.setConfig("proj", { adoptBy: "live" });
    const base = activeHarness(db, "proj", "billing", WRITER);
    const trial = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: TREE, now: 1000 * DAY });
    for (let i = 0; i < 6; i++) { attempt(db, { state: "accepted", tree: trial.id, arm: "new", at: 1000 * DAY + i }); attempt(db, { state: i < 3 ? "accepted" : "blocked", tree: base.id, arm: "old", at: 1000 * DAY + i }); }
    expect((await harness.evaluateTrials("proj", { now: 1000 * DAY + DAY }))[0]!.decision.action).toBe("adopt");
    expect(getHarness(db, trial.id)!.state).toBe("adopted");
  });
});

describe("a bench project runs under the tree its arm names", () => {
  it("none gives no tree, an id gives that tree, tree gives the source project's adopted tree for the original area; live alternation never touches it", async () => {
    const { db, harness } = setup();
    const base = activeHarness(db, "proj", "billing", WRITER);
    const adopted = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "adopted", createdBy: "editor", parentId: base.id, tree: TREE });
    const candidate = insertHarness(db, { projectId: "proj", area: "billing", writerKey: WRITER, state: "trial", createdBy: "editor", parentId: base.id, tree: { "always-on.md": "Other." } });
    const input = (id: string) => ({ projectId: "proj_bench", area: "billing~b3lunar1", writerKey: WRITER, attemptId: id });
    const forRun = (area = "billing~b3lunar1") => attempt(db, { run: "run_bench", area });

    setBenchProject(db as never, { projectId: "proj_bench", harness: "none", sourceProjectId: "proj" });
    expect(await harness.forAttempt(input(forRun()))).toBeNull();

    setBenchProject(db as never, { projectId: "proj_bench", harness: candidate.id, sourceProjectId: "proj" });
    const named = forRun();
    expect(await harness.forAttempt(input(named))).toMatchObject({ harnessId: candidate.id, arm: null, alwaysOn: "Other." });
    expect(db.prepare("SELECT harness_tree_id AS tree, harness_arm AS arm FROM lane_pilot_attempt WHERE id=?").get(named)).toEqual({ tree: candidate.id, arm: null });

    setBenchProject(db as never, { projectId: "proj_bench", harness: "tree", sourceProjectId: "proj" });
    expect(await harness.forAttempt(input(forRun()))).toMatchObject({ harnessId: adopted.id, arm: null, alwaysOn: TREE["always-on.md"] });
    // The source project's open trial did not hand out an arm to the bench attempts.
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE harness_arm IN ('new','old')").get()).toEqual({ n: 0 });
  });
});

describe("areas without repeatability get no editor", () => {
  it("teachingKeys needs the attempts of an area to span the given time", () => {
    const { db } = setup();
    for (let i = 0; i < 5; i++) attempt(db, { area: "afternoon", state: "accepted", at: 1000 * DAY + i * 3_600_000 });
    for (let i = 0; i < 5; i++) attempt(db, { area: "weeks", state: "accepted", at: 1000 * DAY + i * DAY });
    const keys = (span: number) => teachingKeys(db, "proj", 0, 5, span).map((row) => row.area).sort();
    expect(keys(0)).toEqual(["afternoon", "weeks"]);
    expect(keys(3 * DAY)).toEqual(["weeks"]);
    expect(HARNESS_DEFAULTS).toMatchObject({ minAttempts: 5, minSpanDays: 3, adoptBy: "bench" });
  });
});
