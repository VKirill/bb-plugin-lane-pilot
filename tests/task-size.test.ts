import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { batchShapeAdvice } from "../src/rooms/tasks/batch-shape";
import { medianTaskSize, taskSizeOf, taskSizeText } from "../src/rooms/tasks/task-size";
import { isLongCandidate, longStratum } from "../src/rooms/bench/stratify";

function db() {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE lane_pilot_run(id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE lane_pilot_task(id TEXT PRIMARY KEY);
    CREATE TABLE lane_pilot_attempt(id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, state TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE lane_pilot_attempt_change(attempt_id TEXT, changed_json TEXT);`);
  return d;
}

const fill = (d: Database.Database, n: number, files: number, minutes: number, attempts = 1) => {
  for (let i = 0; i < n; i++) {
    d.prepare("INSERT INTO lane_pilot_run VALUES (?,?)").run(`r${i}`, "P1");
    d.prepare("INSERT INTO lane_pilot_task VALUES (?)").run(`T${i}`);
    d.prepare("INSERT INTO lane_pilot_attempt VALUES (?,?,?,?,?,?)").run(`a${i}`, `r${i}`, `T${i}`, "accepted", 0, minutes * 60_000);
    d.prepare("INSERT INTO lane_pilot_attempt_change VALUES (?,?)").run(`a${i}`, JSON.stringify(Array.from({ length: files }, (_, k) => ({ path: `f${k}.ts`, status: "M" }))));
    for (let k = 1; k < attempts; k++) d.prepare("INSERT INTO lane_pilot_attempt VALUES (?,?,?,?,?,?)").run(`a${i}x${k}`, `r${i}`, `T${i}`, "failed", 0, 1000);
  }
};

describe("accepted task size (#29)", () => {
  it("median over the project's accepted tasks; null under the sample floor", () => {
    const d = db();
    expect(medianTaskSize(d, "P1")).toBeNull();
    fill(d, 5, 7, 90, 2);
    const m = medianTaskSize(d, "P1")!;
    expect(m).toMatchObject({ files: 7, minutes: 90, attempts: 2, n: 5 });
    expect(taskSizeText(m)).toContain("~7 files");
    // A different project sees nothing.
    expect(medianTaskSize(d, "P2")).toBeNull();
  });

  it("per-task receipt fields", () => {
    expect(taskSizeOf({ files: 3, lines: 120, createdAt: 0, finishedAt: 3_600_000, attempts: 2 })).toEqual({ files: 3, lines: 120, minutes: 60, attempts: 2 });
  });

  it("grain warning fires only for a slice far below the median", () => {
    const median = { files: 8, lines: 0, minutes: 90, attempts: 2, n: 6 };
    const tiny = { id: "T", ownsPaths: ["a.ts"], dependsOn: [] };
    expect(batchShapeAdvice(tiny, [], median)[0]).toContain("grain:");
    expect(batchShapeAdvice({ id: "T", ownsPaths: ["a.ts", "b.ts", "c.ts"], dependsOn: [] }, [], median)).toEqual([]);
    // No median → no warning, old behaviour.
    expect(batchShapeAdvice(tiny, [])).toEqual([]);
  });
});

describe("long stratum", () => {
  const cand = (contract: Record<string, unknown>): never => ({ taskId: "t", projectId: "p", area: "feature:x", risk: "low", hard: false, contract } as never);
  it("large text or 3+ expected outputs count; small does not", () => {
    expect(isLongCandidate(cand({ title: "t", objective: "o".repeat(400) }))).toBe(false); // long but not classed large, <3 outputs
    expect(isLongCandidate(cand({ title: "t", objective: "o".repeat(400), expected_outputs: ["a", "b", "c"] }))).toBe(true);
    expect(isLongCandidate(cand({ title: "tiny" }))).toBe(false);
    expect(longStratum().key).toBe("long");
  });
});
