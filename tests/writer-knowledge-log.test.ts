import { describe, expect, it } from "vitest";
import { relevantWriterRules } from "../src/rooms/writer/server/writer-knowledge";

describe("writer knowledge logging", () => {
  it("a councilJudge failure is logged, not silent", async () => {
    const logs: string[] = [];
    const host = { call: async () => { throw new Error("council timeout"); } };
    const rules = await relevantWriterRules(host as never, [{ rule: "r", audience: "writer", always: false }], {}, "h", (line: string) => logs.push(line));
    expect(rules).toHaveLength(1);
    expect(logs.some((line) => line.includes("council timeout"))).toBe(true);
  });
});
