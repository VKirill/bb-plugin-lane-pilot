import { describe, expect, it } from "vitest";
import { parseRevisionProbe } from "../src/rooms/writer/server/verify";

describe("the verification receipt names the revision it checked", () => {
  it("reads the HEAD sha and the count of loose files, and says null when git could not", () => {
    expect(parseRevisionProbe("0123456789abcdef0123456789abcdef01234567\n3\n")).toEqual({ head: "0123456789abcdef0123456789abcdef01234567", dirty: 3 });
    expect(parseRevisionProbe("-\n0\n")).toEqual({ head: null, dirty: 0 });
    expect(parseRevisionProbe("")).toEqual({ head: null, dirty: null });
  });
});

describe("the accepted receipt keeps it", () => {
  it("survives the compaction of an accepted result", async () => {
    const { compactAcceptedResult } = await import("../src/rooms/tasks/server/accepted-compact");
    const revision = { head: "0123456789abcdef0123456789abcdef01234567", dirty: 2 };
    const out = compactAcceptedResult({ status: "done", verification: [{ command: "npm test", exitCode: 0, stdout: "Tests 1 passed", stderr: "", revision }] }) as { verification: Array<{ revision?: unknown }> };
    expect(out.verification[0]!.revision).toEqual(revision);
  });
});
