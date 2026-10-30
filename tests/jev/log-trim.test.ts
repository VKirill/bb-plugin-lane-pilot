import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev } from "@lane-pilot/jev";
import type { JevClient } from "@lane-pilot/jev";
import { joinTrimmedChunks, logTrimJudgment, pinnedChunks, splitLogChunks, trimCheckLogsIn, trimFailedCheckLog, PINNED_LINE } from "../../src/rooms/writer/log-trim";
import { noulOf } from "@lane-pilot/jev";

// A vitest failure followed by a tsc failure, padded with install and progress noise the way a real check leaves it.
const vitestTscLog = [
  ...Array.from({ length: 30 }, (_, index) => `npm notice chore ${index}: resolving workspace deps`),
  " RUN  v3.2.4 /repo",
  ...Array.from({ length: 90 }, (_, index) => ` ✓ tests/green-${index}.test.ts (${index + 2} tests) ${index + 4}ms`),
  " ❯ tests/writer-task.test.ts (12 tests | 1 failed) 88ms",
  "   ✓ brief lists owns_paths",
  "   × brief names the failing check",
  "FAIL  tests/writer-task.test.ts > brief names the failing check",
  "AssertionError: expected 'the check `npm test` failed' to contain 'exit 127'",
  "Expected: exit 127",
  "Received: the check `npm test` failed",
  " ❯ tests/writer-task.test.ts:285:15",
  "     at runTest (node_modules/vitest/dist/run.js:120:5)",
  ...Array.from({ length: 35 }, (_, index) => `  ▲ progress chunk ${index}: still collecting`),
  "src/rooms/writer/log-trim.ts:42:11 - error TS2554: Expected 1 arguments, but got 2.",
  "src/rooms/writer/server/start.ts:733:31 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  " Test Files  1 failed | 41 passed (42)",
  "      Tests  1 failed | 512 passed (513)",
].join("\n");

const everyErrorLine = (text: string) => text.split("\n").filter((line) => PINNED_LINE.test(line) || /^\s*(?:Test Files|Tests|Suites|Errors?)\b/.test(line));

function jevWith(kept: Record<string, number>) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      return { ok: true, model: "jev-test", usage: { input_tokens: 900, output_tokens: 30 }, latencyMs: 90, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul: kept[id] ?? 0.1 }])) };
    },
  };
  return { db, jev: createJev({ client, db }) };
}

describe("writer.log_trim: the failing check's log cut to the error, error lines never lost", () => {
  it("pins every error, file:line and summary line in code", () => {
    const chunks = splitLogChunks(vitestTscLog).map((chunk) => chunk.join("\n"));
    const pinned = pinnedChunks(splitLogChunks(vitestTscLog));
    const keptText = joinTrimmedChunks(splitLogChunks(vitestTscLog), pinned.map(() => false)).text;
    for (const line of everyErrorLine(vitestTscLog)) expect(keptText).toContain(line);
    // A chunk is pinned only by its own lines: the noise chunks are free for Jev.
    expect(pinned.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(pinned.filter(Boolean).length).toBeLessThan(chunks.length);
  });

  it("active: the log got shorter and no error line was lost on a real vitest+tsc log", async () => {
    const { jev } = jevWith({});
    const trimmed = await trimFailedCheckLog(jev, { command: "npx vitest run && npx tsc --noEmit", output: vitestTscLog, task: "fix the writer's retry brief", maxChars: 3_000 },
      { settings: { "jev.modes": "writer.log_trim=active" } });
    expect(trimmed).not.toBeNull();
    expect(trimmed!.text.length).toBeLessThan(vitestTscLog.length);
    for (const line of everyErrorLine(vitestTscLog)) expect(trimmed!.text).toContain(line);
    expect(trimmed!.text).toContain("check output omitted");
    expect(trimmed!.text).not.toContain("npm notice chore 3");
  });

  it("shadow (the default): Jev is asked and recorded, the log is returned untrimmed", async () => {
    const { db, jev } = jevWith({});
    const trimmed = await trimFailedCheckLog(jev, { command: "npm test", output: vitestTscLog, task: "t", maxChars: 3_000 }, { settings: {} });
    expect(trimmed).toBeNull();
    const row = db.prepare("SELECT judgment, mode, decided_by FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(row).toMatchObject({ judgment: "writer.log_trim", mode: "shadow", decided_by: "fallback" });
  });

  it("short logs are never asked about", async () => {
    const { db, jev } = jevWith({});
    expect(await trimFailedCheckLog(jev, { command: "npm test", output: "FAIL x\nsrc/a.ts:1:1 error TS1", task: "t" }, { settings: { "jev.modes": "writer.log_trim=active" } })).toBeNull();
    expect((db.prepare("SELECT count(*) n FROM lane_pilot_jev_receipt").get() as { n: number }).n).toBe(0);
  });

  it("decide keeps chunks at or above min_p and drops the rest", () => {
    const input = { command: "c", task: "t", chunks: ["a", "b", "c"] };
    const answers = { c1: { type: "noul" as const, noul: 0.2 }, c2: { type: "noul" as const, noul: 0.9 }, c3: { type: "noul" as const, noul: 0.5 } };
    expect(logTrimJudgment.decide(answers, { min_p: 0.6 }, input)).toEqual({ decision: [false, true, false] });
    expect(logTrimJudgment.fallback(input)).toEqual([true, true, true]);
  });

  it("the failure record the writer reads carries the trimmed output", async () => {
    const { jev } = jevWith({});
    const last = { status: "validation_failed", reason: "verification failed (npm test)", verification: [{ command: "npm test", exitCode: 1, stdout: vitestTscLog, stderr: "" }] };
    const trimmed = await trimCheckLogsIn(jev, last, "fix the brief", { settings: { "jev.modes": "writer.log_trim=active" } });
    expect(trimmed).not.toBe(last);
    const check = (trimmed!.verification as Array<{ stdout: string }>)[0]!;
    expect(check.stdout.length).toBeLessThan(vitestTscLog.length);
    for (const line of everyErrorLine(vitestTscLog)) expect(check.stdout).toContain(line);
    // Untouched when nothing can be asked.
    expect(await trimCheckLogsIn(null, last, "t")).toBe(last);
  });

  it("noul answers arrive under their own ids", () => {
    const input = { command: "c", task: "t", chunks: ["x"] };
    const answers = logTrimJudgment.questions(input);
    expect(Object.keys(answers)).toEqual(["c1"]);
    expect(noulOf({ c1: { type: "noul", noul: 0.7 } }, "c1")).toBe(0.7);
  });
});
