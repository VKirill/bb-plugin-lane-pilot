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
  it("the runner chain and the batch-suite chain each end in one backlog item, not in new tasks", async () => {
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
      expect(row.hint).toMatch(/Lane Pilot took the big picture itself.*hunt loop:topic:/s);
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
});
