import { describe, expect, it } from "vitest";
import { logIncidents } from "../../src/rooms/self-repair/server/episodes";
import { wallLogLines } from "../../src/rooms/wall/logs";
import { logSignature } from "../../src/rooms/wall/signature";
import rows from "../fixtures/writer-fallback-log.json";

const since = rows[0]!.ts - 1;
const until = rows.at(-1)!.ts + 1;
const text = rows.map((row) => JSON.stringify(row)).join("\n");
const sample = rows.find((row) => row.ts === 1794007286167)!;

it("replays the two original hub messages of log:a10ac833ef2c", () => {
  expect(rows.filter((row) => logSignature(row.message).classKey === "log:a10ac833ef2c")
    .map((row) => row.ts)).toEqual([1794003834923, 1794007286167]);
});

describe.each([
  { name: "wall", read: (log: string) => wallLogLines(log, since, until) },
  { name: "self-repair", read: (log: string) => logIncidents(log, since) },
])("$name writer fallback status", ({ read }) => {
  it("does not report real same-attempt routing messages as failures", () => {
    expect(read(text)).toEqual([]);
  });

  it("retains a separate spawn failure after the routing message", () => {
    const message = "writer drill-20261107-021815-a: fallback spawn failed: HTTP 500";
    expect(read(`${text}\n${JSON.stringify({ ...sample, message })}`)).toHaveLength(1);
  });
});

it.each(["spawn failed: HTTP 500", "cannot provision workspace", "provider_error: writer thread status error"])(
  "wall retains an actual failure appended to routing status: %s", (failure) => {
    const message = `${sample.message}; ${failure}`;
    expect(wallLogLines(JSON.stringify({ ...sample, message }), since, until))
      .toMatchObject([{ message, at: sample.ts }]);
  },
);

it("wall retains error-level routing messages", () => {
  expect(wallLogLines(JSON.stringify({ ...sample, level: "error" }), since, until))
    .toMatchObject([{ message: sample.message, level: "error" }]);
});

it("wall retains a held writer when no same-attempt fallback is selected", () => {
  const message = sample.message.split("; spawning")[0]!;
  expect(wallLogLines(JSON.stringify({ ...sample, message }), since, until))
    .toMatchObject([{ message }]);
});
