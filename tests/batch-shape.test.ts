import { describe, expect, it } from "vitest";
import { batchShapeAdvice } from "../src/rooms/tasks";

const open = (id: string, ownsPaths: string[], dependsOn: string[] = []) => ({ id, ownsPaths, dependsOn });

describe("batchShapeAdvice", () => {
  it("says nothing for a task that waits for nobody", () => {
    expect(batchShapeAdvice({ id: "n", ownsPaths: ["src/a.ts"], dependsOn: [] }, [open("o", ["src/b.ts"])])).toEqual([]);
  });

  it("names the holder and the shared file, narrower of the two paths", () => {
    const advice = batchShapeAdvice({ id: "n", ownsPaths: ["scripts/gamedata/rules.py"], dependsOn: [] }, [open("o", ["scripts/gamedata/"])]);
    expect(advice).toEqual(["queue: n waits for 1 open task ahead because their owns_paths overlap (o: scripts/gamedata/rules.py); it starts after them, not beside them."]);
  });

  it("adds the fix when three tasks, the new one included, own one folder; lists at most five", () => {
    const holders = Array.from({ length: 7 }, (_, i) => open(`t${i}`, ["scripts/gamedata/", `src/t${i}.luau`]));
    const advice = batchShapeAdvice({ id: "n", ownsPaths: ["scripts/gamedata/", "src/n.luau"], dependsOn: [] }, holders);
    expect(advice).toHaveLength(2);
    expect(advice[0]).toContain("waits for 7 open tasks ahead");
    expect(advice[0]).toContain("+2");
    expect(advice[1]).toContain("8 open tasks (t0, t1, t2, t3, t4, +3) own scripts/gamedata/");
    expect(advice[1]).toMatch(/Narrow owns_paths.*one task the others depend on.*merge tiny tasks of one area.*30-120 minutes/);
  });

  it("gives no shape advice for two tasks, and skips tasks ordered by depends_on", () => {
    expect(batchShapeAdvice({ id: "n", ownsPaths: ["data/"], dependsOn: [] }, [open("a", ["data/"])])).toHaveLength(1);
    expect(batchShapeAdvice({ id: "n", ownsPaths: ["data/"], dependsOn: ["a"] }, [open("a", ["data/"]), open("b", ["data/"])])[0]).toContain("waits for 1 open task ahead");
    expect(batchShapeAdvice({ id: "n", ownsPaths: ["data/"], dependsOn: [] }, [open("a", ["data/"], ["n"])])).toEqual([]);
  });
});
