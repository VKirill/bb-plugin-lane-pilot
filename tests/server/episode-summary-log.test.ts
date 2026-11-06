import { describe, expect, it } from "vitest";
import { logIncidents } from "../../src/rooms/self-repair/server/self-repair";
import { wallLogLines } from "../../src/rooms/wall/logs";
import rows from "../fixtures/episode-summary-log.json";

const since = rows[0]!.ts - 1;
const until = rows.at(-1)!.ts + 1;
const text = rows.map((row) => JSON.stringify(row)).join("\n");
const readers = [
  { name: "self-repair", read: (log: string) => logIncidents(log, since) },
  { name: "wall", read: (log: string) => wallLogLines(log, since, until) },
];

describe.each(readers)("$name episode summary classification", ({ read }) => {
  it("does not turn the six successful hub sweeps of 2026-11-06 into failures", () => {
    expect(read(text)).toEqual([]);
  });

  it.each([1, 10, 100])("still reports a summary with %i failures", (count) => {
    const message = rows[0]!.message.replace("0 failed", `${count} failed`);
    expect(read(JSON.stringify({ ...rows[0], message }))).toMatchObject([{ at: rows[0]!.ts }]);
  });

  it("retains other failures beside a zero counter and preserves the original message", () => {
    const message = `${rows[0]!.message}; checkpoint failed`;
    const result = read(JSON.stringify({ ...rows[0], message }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject("reason" in result[0]! ? { reason: message } : { message });
  });

  it("does not confuse a failed step numbered zero with a zero failure counter", () => {
    expect(read(JSON.stringify({ ...rows[0], message: "step 0 failed" }))).toHaveLength(1);
  });

  it("keeps sweeps that held episodes after a masking failure", () => {
    const message = rows[0]!.message.replace("0 held", "1 held");
    expect(read(JSON.stringify({ ...rows[0], message }))).toHaveLength(1);
  });
});

it("wall still reports error-level lines even with a zero failure counter", () => {
  const row = { ...rows[0]!, level: "error" };
  expect(wallLogLines(JSON.stringify(row), since, until)).toMatchObject([{ message: row.message, level: "error" }]);
});
