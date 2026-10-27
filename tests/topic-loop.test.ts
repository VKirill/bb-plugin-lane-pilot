import { describe, expect, it } from "vitest";
import fixture from "./fixtures/vampirism-fire-run.json";
import { TOPIC_LOOP, testNames, topicHold, topicLoop, topicLoopMessage } from "../src/rooms/tasks";
import type { LoopTask, TopicWall } from "../src/rooms/tasks";

const HOUR = 3_600_000;
/** Vampirism Fire (run lprun_18aa9a163f6d4824aa8c5572b9dec21f, 165 tasks, 74 h) as the dispatcher saw it, trimmed: see the fixture's note. */
const run: LoopTask[] = (fixture as { tasks: Array<Omit<LoopTask, "createdAt" | "text"> & { at: number }> }).tasks
  .map(({ at, ...task }) => ({ ...task, createdAt: at, text: [task.title, ...task.files, ...task.commands].join(" ") }));
const replay = (tasks: readonly LoopTask[]) => tasks.flatMap((task, index) => {
  const found = topicLoop(task, tasks.slice(0, index));
  return found ? [{ id: task.id, ...found }] : [];
});

const task = (id: string, hours: number, extra: Partial<LoopTask> = {}): LoopTask => ({
  id, createdAt: hours * HOUR, kind: "fix", title: `fix ${id}`, files: ["src/runner.py"], commands: [], text: `fix ${id}`, attempts: [{ state: "accepted", reason: null }], ...extra,
});
const chain = (n: number, extra: Partial<LoopTask> = {}) => Array.from({ length: n }, (_, i) => task(`t${i + 1}`, i + 1, extra));

describe("run-level loop stopper, replayed over Vampirism Fire", () => {
  const fired = replay(run);

  it("fires on the Studio test runner chain at its fourth fix, and again while the chain goes on", () => {
    const runner = fired.filter((row) => row.topic === "file");
    expect(runner.map((row) => row.id)).toEqual(["vf-runner-game-errors", "vf-runner-open-throttle", "vf-runner-mcp-drop", "vf-runner-no-blind-open"]);
    expect(runner[0]).toMatchObject({ key: "game/scripts/studio_test.py", families: ["vf-runner-dedupe", "vf-runner-one-window", "vf-runner-retry"] });
    // Nine tasks patched the runner by the end; the feature (pool) and the chore (one-slot) among them are not counted as fixes.
    expect(runner.at(-1)!.families.length).toBeGreaterThanOrEqual(6);
  });

  it("fires on the chase of the failing batch suite tests (Par028, Par030, T09_Defense) before the fourth try of it", () => {
    const tests = fired.filter((row) => row.topic === "test");
    expect(tests.map((row) => row.id)).toEqual(["vf-fix-b3-last7b", "vf-tests-hygiene", "vf-tests-map-oracles"]);
    expect(tests[0]).toMatchObject({ key: "par028", families: ["vf-s5-shops", "vf-s7-restock", "vf-fix-b3-last7"] });
    // Par030 itself: the research task that audited it at 63.3 h (vf-audit-tests-a) is the step back, so it counts from there.
    expect(fired.some((row) => row.key === "par030")).toBe(false);
  });

  it("never fires on the mechanic stream: feature, refactor and workflow tasks, and the redos and mainfixes of any family", () => {
    const mechanic = run.filter((row) => /^(vf-s\d|vf-rf-|vf-wc3|wc)/.test(row.id) && row.kind !== "fix");
    expect(mechanic.length).toBeGreaterThan(40);
    for (const row of mechanic) expect(fired.map((hit) => hit.id)).not.toContain(row.id);
    for (const row of fired) expect(row.id).toMatch(/^vf-(runner-|fix-b3-|tests-)/);
    // A shared data folder is not a topic: 21 of 99 families own scripts/gamedata/.
    expect(fired.some((row) => /gamedata/i.test(row.key))).toBe(false);
  });

  it("fires on fix-like work only, and reports who tried and for how long", () => {
    for (const row of fired) expect(row.hours).toBeGreaterThan(0);
    const first = fired[0]!;
    expect(first.hours).toBeCloseTo(24.7, 0);
    expect(topicLoopMessage(first)).toMatch(/^topic_loop: 3 earlier tasks of this run \(vf-runner-dedupe, vf-runner-one-window, vf-runner-retry\) already worked on the file game\/scripts\/studio_test\.py/);
    expect(topicLoopMessage(first)).toMatch(/dispatch ONE research task \(kind research, or check\)/);
  });
});

describe("topicLoop", () => {
  it("lets the third try through and stops the fourth", () => {
    const earlier = chain(3);
    expect(topicLoop(task("t3", 3), earlier.slice(0, 2))).toBeNull();
    expect(topicLoop(task("t4", 4), earlier)).toMatchObject({ topic: "file", key: "src/runner.py", families: ["t1", "t2", "t3"] });
  });

  it("does not stop a redo of a family, a mainfix, or a research or check task", () => {
    const earlier = chain(3);
    expect(topicLoop(task("t2.2", 4), earlier)).toBeNull();
    expect(topicLoop(task("t9-mainfix", 4), earlier)).toBeNull();
    expect(topicLoop(task("analysis", 4, { kind: "research" }), earlier)).toBeNull();
    expect(topicLoop(task("analysis", 4, { kind: "check" }), earlier)).toBeNull();
  });

  it("counts a family once however many redos and mainfixes it has", () => {
    const earlier = [task("t1", 1), task("t1.2", 2), task("t1.3", 3), task("t1-mainfix", 3), task("t2", 4)];
    expect(topicLoop(task("t3", 5), earlier)).toBeNull();
  });

  it("counts only tried families inside the window", () => {
    expect(topicLoop(task("t4", 4), chain(3, { attempts: [{ state: "canceled", reason: null }] }))).toBeNull();
    expect(topicLoop(task("t4", 4 + TOPIC_LOOP.windowMs / HOUR), chain(3))).toBeNull();
  });

  it("ignores wide tasks, folders, docs, feature work and the run's shared ground", () => {
    expect(topicLoop(task("t4", 4), chain(3, { files: ["src/runner.py", "a.py", "b.py", "c.py"] }))).toBeNull();
    expect(topicLoop(task("t4", 4, { files: ["src/"] }), chain(3, { files: ["src/"] }))).toBeNull();
    expect(topicLoop(task("t4", 4, { files: ["docs/log.md"] }), chain(3, { files: ["docs/log.md"] }))).toBeNull();
    expect(topicLoop(task("t4", 4, { kind: "feature", title: "add x" }), chain(3, { kind: "feature", title: "add x" }))).toBeNull();
    // 12+ families, a quarter of them own registry.ts: it is shared ground, not a chase.
    const others = Array.from({ length: 9 }, (_, i) => task(`other${i}`, 0.1 * i, { files: [`src/f${i}.ts`], kind: "feature", title: "add" }));
    const sharing = chain(3, { files: ["src/registry.ts"] });
    expect(topicLoop(task("t4", 4, { files: ["src/registry.ts"] }), [...others, ...sharing])).toBeNull();
  });

  it("stops a test that three other families could not get green, from their red reasons or their checks", () => {
    const red = (id: string, hours: number, extra: Partial<LoopTask>) => task(id, hours, { files: [`src/${id}.ts`], attempts: [{ state: "validation_failed", reason: null }], ...extra });
    const earlier = [
      red("a", 1, { attempts: [{ state: "validation_failed", reason: "verification failed (npx runner --filter Flaky1 && npx runner --filter Other): exit 1" }] }),
      red("b", 2, { commands: ["npx runner --filter flaky1"] }),
      red("c", 3, { commands: ["for m in One Flaky1; do npx runner --filter $m || exit 1; done"] }),
    ];
    const next = task("d", 4, { kind: "feature", title: "add d", files: ["src/d.ts"], commands: ["npx runner --filter Flaky1"] });
    expect(topicLoop(next, earlier)).toMatchObject({ topic: "test", key: "flaky1", families: ["a", "b", "c"] });
    // A family whose checks all passed first time says nothing about the test.
    expect(topicLoop(next, [...earlier.slice(0, 2), task("c", 3, { commands: ["npx runner --filter Flaky1"], files: ["src/c.ts"] })])).toBeNull();
  });

  it("is released by an accepted research task on the topic, and held while one is open", () => {
    const earlier = chain(3);
    const research = (state: string, hours: number): LoopTask => task("why-runner", hours, { kind: "research", title: "Why src/runner.py keeps breaking", text: "Why src/runner.py keeps breaking", files: ["docs/runner.md"], attempts: [{ state, reason: null }] });
    expect(topicLoop(task("t4", 5), [...earlier, research("accepted", 4)])).toBeNull();
    // Three more tries after the analysis stop again.
    const after = [task("u1", 5), task("u2", 6), task("u3", 7)];
    expect(topicLoop(task("u4", 8), [...earlier, research("accepted", 4), ...after])).toMatchObject({ families: ["u1", "u2", "u3"] });
    const held = topicLoop(task("t4", 5), [...earlier, research("running", 4)]);
    expect(held?.openAnalysis).toBe("why-runner");
    expect(topicLoopMessage(held!)).toMatch(/why-runner is still open: wait for its receipt/);
    // A check whose commands merely run the file is no analysis of it.
    expect(topicLoop(task("t4", 5), [...earlier, task("gate", 4, { kind: "check", title: "Stage exit", text: "src/runner.py", attempts: [{ state: "accepted", reason: null }] })])).not.toBeNull();
  });
});

describe("testNames", () => {
  it("reads filters, loops, name patterns and test files, lower case, once", () => {
    expect(testNames("cd game && python3 -I scripts/studio_test.py --filter Par030 && python3 scripts/studio_test.py --filter=T07_Coins")).toEqual(["par030", "t07_coins"]);
    expect(testNames("cd game && for m in Par028 Par030 Par030 $x; do run --filter $m || exit 1; done")).toEqual(["par028", "par030"]);
    expect(testNames("npx vitest run tests/foo.test.ts -t 'does the thing'")).toEqual(["does the thing", "tests/foo.test.ts"]);
    expect(testNames("pytest tests/test_api.py")).toEqual(["tests/test_api.py"]);
    expect(testNames("cd game && scripts/check.sh")).toEqual([]);
  });
});

describe("topicHold: a topic whose wall is open stays closed", () => {
  const KEY = "loop:topic:abc123def456";
  const wall = (extra: Partial<TopicWall> = {}): TopicWall => ({ key: KEY, topic: "src/runner.py", state: "backlog", hunt: "usable", ...extra });
  const earlier = chain(3, { commands: ["pytest tests/test_runner.py"] });
  const fresh = (id: string, objective: string, commands = ["python3 tools/new_probe.py"], extra: Partial<LoopTask> = {}) => task(id, 5, { objective, commands, ...extra });
  const tryText = `Fix the runner.\nincident: ${KEY}\nhypothesis: the runner leaks its window handle when the pool is recycled`;

  it("refuses the same contract in every state of the wall but closed (Astra's table)", () => {
    const same = task("t4", 5);
    for (const state of ["stopped", "hunting", "hunted", "backlog"] as const) expect(topicHold(same, [wall({ state })], earlier), state).toMatchObject({ allowed: false, why: expect.stringContaining(KEY) });
    expect(topicHold(same, [wall({ state: "closed" })], earlier)).toBeNull();
    expect(topicHold(same, [], earlier)).toBeNull();
    // Another topic, and the analysis kinds, are not held.
    expect(topicHold(task("o", 5, { files: ["src/other.py"] }), [wall()], earlier)).toBeNull();
    expect(topicHold(task("r", 5, { kind: "research" }), [wall()], earlier)).toBeNull();
  });

  it("holds a redo of an old family, a mainfix and a task that names the test, whatever the id", () => {
    expect(topicHold(task("t2.2", 5), [wall()], earlier)).toMatchObject({ allowed: false });
    expect(topicHold(task("t2-mainfix", 5), [wall()], earlier)).toMatchObject({ allowed: false });
    expect(topicHold(task("x", 5, { kind: "feature", title: "add x", files: ["src/x.py"], commands: ["pytest tests/test_runner.py"] }), [wall({ topic: "tests/test_runner.py" })], earlier)).toMatchObject({ allowed: false });
  });

  it("lets one try through that cites the incident, states a new hypothesis and carries a check no earlier task used", () => {
    expect(topicHold(fresh("n1", tryText), [wall()], earlier)).toMatchObject({ allowed: true });
    // The try's own redo and mainfix are the same try; once it exists no other id gets through, however new its hypothesis.
    const spent = [...earlier, fresh("n1", tryText)];
    expect(topicHold(fresh("n1.2", "redo"), [wall()], spent)).toMatchObject({ allowed: true });
    expect(topicHold(fresh("n1-mainfix", "repair main"), [wall()], spent)).toMatchObject({ allowed: true });
    const second = topicHold(fresh("n2", `${tryText}\nhypothesis: the pool recycles windows in the wrong order`, ["python3 tools/other_probe.py"]), [wall()], spent);
    expect(second).toMatchObject({ allowed: false, why: expect.stringMatching(/one new try was already made \(n1\)/) });
    // The old families stay shut during and after the try.
    expect(topicHold(task("t2.2", 5), [wall()], spent)).toMatchObject({ allowed: false });
  });

  it("names what a new try lacks: the incident, a hypothesis that differs, a check that differs", () => {
    expect(topicHold(fresh("n1", "Fix the runner."), [wall()], earlier)!.why).toMatch(new RegExp(`line .incident: ${KEY}.*cites no incident`, "s"));
    expect(topicHold(fresh("n1", "incident: loop:topic:other0000000"), [wall()], earlier)!.why).toMatch(/says loop:topic:other0000000, not/);
    expect(topicHold(fresh("n1", `incident: ${KEY}`), [wall()], earlier)!.why).toMatch(/states no hypothesis/);
    expect(topicHold(fresh("n1", `incident: ${KEY}\nhypothesis: fix t1`), [wall()], earlier)!.why).toMatch(/states no hypothesis/);
    const repeated = [...earlier.slice(0, 2), task("t3", 3, { objective: "hypothesis: the runner leaks its window handle when the pool is recycled", commands: ["pytest tests/test_runner.py"] })];
    expect(topicHold(fresh("n1", tryText), [wall()], repeated)!.why).toMatch(/hypothesis repeats an earlier one/);
    expect(topicHold(fresh("n1", tryText, ["pytest   tests/test_runner.py"]), [wall()], earlier)!.why).toMatch(/Every check of this task was already used/);
  });

  it("gives no permission when the hunters ended unknown or no hunt ran, even for a perfect try", () => {
    for (const hunt of ["unknown", "none"]) expect(topicHold(fresh("n1", tryText), [wall({ hunt })], earlier), hunt).toMatchObject({ allowed: false, why: expect.stringMatching(/No new try is allowed/) });
    expect(topicHold(fresh("n1", tryText), [wall({ state: "hunted" })], earlier)).toMatchObject({ allowed: false });
  });
});
