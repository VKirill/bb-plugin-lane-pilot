import { describe, expect, it } from "vitest";
import fixture from "../fixtures/vampirism-fire-run.json";
import type { LoopTask } from "../../src/rooms/tasks";
import { topicLoopStop } from "../../src/rooms/writer/server/dispatch-guards";
import { createWall, type WallPorts } from "../../src/rooms/wall/service";
import { freshDb } from "./helpers";

/**
 * Replay of Vampirism Fire (74 h, 165 tasks; the fixture is the run as the dispatcher saw it) through the machine's outcome for an exhausted
 * topic. In the run the stopper (0.1.334) only refused, and the PM went on patching: nine tasks on the Studio test runner, one flaky test
 * through eight more. Here each refused topic becomes ONE wall: the hunters read it, one backlog item (a register entry and a morning-list line)
 * holds the analysis, and no further task on the topic is created while the hunt is open.
 */
const RUN = "run_real";
const tasks: LoopTask[] = (fixture as { tasks: Array<Omit<LoopTask, "createdAt" | "text"> & { at: number }> }).tasks
  .map(({ at, ...task }) => ({ ...task, createdAt: at, text: [task.title, ...task.files, ...task.commands].join(" ") }));

function replay() {
  const h = freshDb();
  const clock = { now: 0 };
  const state = { readerCalls: [] as string[], deferrals: new Map<string, string>(), told: 0 };
  const ports = {
    now: () => clock.now, version: "0.1.336", loadScope: async () => ({ isReal: () => true, scopeOf: () => "real" as const }), logLines: () => [], codeFiles: async () => [],
    reader: async (_prompt: string, who: string) => { state.readerCalls.push(who); return { text: who === "analysis" ? "# analysis\nnext step: one owner for the runner" : null, tokens: 1000 }; },
    tellPm: async () => { state.told += 1; return true; },
    deferrals: { open: (input: { id: string; what: string }) => { state.deferrals.set(input.id, input.what); }, close: () => undefined },
  } as unknown as WallPorts;
  const wall = createWall({ db: h.db, kv: { get: async () => null, set: async () => undefined } as never, ports, log: () => undefined });
  return { h, wall, clock, state };
}

describe("Vampirism Fire replayed through loop_exhausted", () => {
  it("while the hunts are open, the runner chain and the batch-suite chain each stand in one wall, not in new tasks", async () => {
    const { h, wall, clock, state } = replay();
    const created: LoopTask[] = [];
    const refused: Array<{ id: string; hint: string }> = [];
    for (const task of tasks) {
      clock.now = task.createdAt;
      const hint = await topicLoopStop(wall, RUN, task, created, { projectId: "proj_real", pmThreadId: "thr_pm" });
      if (hint) refused.push({ id: task.id, hint }); else created.push(task);
    }

    // The runner file: its fourth fix was refused, and so was every later try while the hunt stood; none of them became a task.
    const walls = h.db.prepare("SELECT wall_key, subject, state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%' ORDER BY created_at").all() as Array<{ wall_key: string; subject: string; state: string }>;
    const runnerWalls = walls.filter((row) => row.subject.includes("game/scripts/studio_test.py"));
    expect(runnerWalls).toHaveLength(1);
    const runnerRefused = refused.filter((row) => /vf-runner-/.test(row.id)).map((row) => row.id);
    expect(runnerRefused.length).toBeGreaterThanOrEqual(4);
    expect(created.map((row) => row.id)).not.toEqual(expect.arrayContaining(runnerRefused));
    // The batch-suite test chain (Par028 and the last7 family) is its own topic with its own single hunt.
    const par028 = walls.filter((row) => /par028/i.test(row.subject));
    expect(par028).toHaveLength(1);
    expect(refused.some((row) => /last7/.test(row.id))).toBe(true);
    // Every refusal says the machine took the big picture and names its hunt; none hands the topic to the PM.
    for (const row of refused) {
      expect(row.hint).toMatch(/(Lane Pilot took the big picture itself.*hunt loop:topic:|incident loop:topic:[0-9a-f]+\) is being read by the hunters)/s);
      expect(row.hint).not.toMatch(/dispatch ONE research task|waits for a person|PM's/);
    }
    // No two walls for one topic (a round is a wall; the replay never reaches a second round before a hunt ends).
    expect(new Set(walls.map((row) => row.subject)).size).toBe(walls.length);
    expect(state.told).toBe(0);

    // The hunters read each topic once and the analysis lands: one backlog item and one morning line per topic.
    clock.now += 3_600_000;
    await wall.advance(clock.now);
    expect(state.readerCalls.filter((who) => who === "hunter")).toHaveLength(3 * walls.length);
    expect(state.readerCalls.filter((who) => who === "analysis")).toHaveLength(walls.length);
    expect(h.db.prepare("SELECT state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").all()).toEqual(walls.map(() => ({ state: "backlog" })));
    expect(state.deferrals.size).toBe(0);
    const items = h.db.prepare("SELECT key, source, kind, wake FROM lane_pilot_owner_item").all() as Array<{ key: string; source: string; kind: string; wake: number }>;
    expect(items).toHaveLength(walls.length);
    for (const item of items) expect(item).toMatchObject({ source: "wall", kind: "loop_exhausted", wake: 0 });
    // Idempotent: another pass reads nothing again.
    await wall.advance(clock.now + 1000);
    expect(state.readerCalls).toHaveLength(4 * walls.length);
    expect(state.deferrals.size).toBe(0);
  });

  /** The two topics the stopper walled in the run: the runner file and the Par028 test. */
  const TOPICS = [
    { subject: "game/scripts/studio_test.py", on: (task: LoopTask) => task.kind === "fix" && task.files.includes("game/scripts/studio_test.py") },
    { subject: "par028", on: (task: LoopTask) => task.commands.some((command) => /par028/i.test(command)) },
  ];

  it("with the hunts finishing between the dispatches, no task on a walled topic goes out after its backlog item exists", async () => {
    const { h, wall, clock, state } = replay();
    const created: LoopTask[] = [];
    const refused: Array<{ id: string; hint: string }> = [];
    const backlogAt = new Map<string, number>();
    for (const task of tasks) {
      clock.now = task.createdAt;
      // The hunters read the walls that stand, as the 15-minute pass does.
      await wall.advance(clock.now);
      for (const row of h.db.prepare("SELECT subject, state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").all() as Array<{ subject: string; state: string }>) {
        if (row.state === "backlog" && !backlogAt.has(row.subject)) backlogAt.set(row.subject, task.createdAt);
      }
      const hint = await topicLoopStop(wall, RUN, task, created, { projectId: "proj_real", pmThreadId: "thr_pm" });
      if (hint) refused.push({ id: task.id, hint }); else created.push(task);
    }
    // The hunts did finish in time (the hunters said nothing that holds), and the backlog is where each topic stands.
    const wallRows = h.db.prepare("SELECT subject, state, hunt_state FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").all() as Array<{ subject: string; state: string; hunt_state: string }>;
    expect(wallRows).toHaveLength(TOPICS.length);
    for (const row of wallRows) expect(row).toMatchObject({ state: "backlog", hunt_state: "unknown" });
    expect(state.readerCalls.filter((who) => who === "hunter")).toHaveLength(3 * TOPICS.length);
    // After a topic's backlog item exists, not one task on that topic was created, and every later try was refused with the incident named.
    for (const topic of TOPICS) {
      const at = [...backlogAt].find(([subject]) => subject.includes(topic.subject))?.[1];
      expect(at, topic.subject).toBeDefined();
      expect(created.filter((task) => topic.on(task) && task.createdAt > at!), topic.subject).toEqual([]);
      const later = tasks.filter((task) => topic.on(task) && task.createdAt > at!);
      expect(later.length, topic.subject).toBeGreaterThan(0);
      for (const task of later) expect(refused.find((row) => row.id === task.id)?.hint, task.id).toMatch(/incident loop:topic:[0-9a-f]+\).*No new try is allowed/s);
    }
  });

  it("the backlog item is closed by the accepted attempt of the one new try that cites it, and by nothing else", async () => {
    const { h, wall, clock } = replay();
    const created: LoopTask[] = [];
    for (const task of tasks) {
      clock.now = task.createdAt;
      if (!await topicLoopStop(wall, RUN, task, created, { projectId: "proj_real", pmThreadId: "thr_pm" })) created.push(task);
      if (h.db.prepare("SELECT 1 FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").get()) break;
    }
    clock.now += 3_600_000;
    await wall.advance(clock.now);
    const [{ wall_key: key }] = h.db.prepare("SELECT wall_key FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").all() as Array<{ wall_key: string }>;
    const seedTry = (id: string, objective: string, attemptState: string) => {
      h.db.prepare("INSERT INTO lane_pilot_task (id,run_id,kind,contract_json,created_at) VALUES (?,?,?,?,?)").run(id, RUN, "bb", JSON.stringify({ id, objective }), clock.now);
      h.db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(`att-${id}`, RUN, id, attemptState, clock.now + 1, clock.now + 2);
    };
    seedTry("other-accepted", "an unrelated fix that touched the same file", "accepted");
    seedTry("try-failed", `incident: ${key}\nhypothesis: a new cause`, "validation_failed");
    await wall.advance(clock.now + 60_000);
    expect(h.db.prepare("SELECT state FROM lane_pilot_wall WHERE wall_key=?").get(key)).toEqual({ state: "backlog" });
    seedTry("try-ok", `incident: ${key}\nhypothesis: another new cause`, "accepted");
    await wall.advance(clock.now + 120_000);
    expect(h.db.prepare("SELECT state, closed_by FROM lane_pilot_wall WHERE wall_key=?").get(key)).toMatchObject({ state: "closed", closed_by: expect.stringContaining("att-try-ok") });
  });
});
