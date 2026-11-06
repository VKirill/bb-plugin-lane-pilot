import { afterEach, describe, expect, it } from "vitest";
import { setJevForTests, type Jev } from "@lane-pilot/jev";
import { rerankRecords } from "../src/rooms/memory/server/rerank";

const records = [{ id: "a", content: "deploy goes through port 4000" }, { id: "b", content: "the cat likes fish" }, { id: "c", content: "staging host is ovh" }];
const fake = (verdict: unknown, enabled = true): Jev => ({ enabled: () => enabled, judge: async () => verdict } as unknown as Jev);
const ctx = { projectId: "p1", settings: {} };

describe("M4 rerank on the query paths", () => {
  afterEach(() => setJevForTests(null));
  it("active: only the passages Jev kept are delivered, in its order", async () => {
    setJevForTests(fake({ by: "jev", decision: { scores: [0.9, 0.1, 0.7], keep: [0, 2] } }));
    expect((await rerankRecords(records, "how does deploy work", ctx)).map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("active and nothing kept: an honest empty answer", async () => {
    setJevForTests(fake({ by: "jev", decision: { scores: [0.1, 0.0, 0.2], keep: [] } }));
    expect(await rerankRecords(records, "what shoe size", ctx)).toEqual([]);
  });
  it("shadow, off, no Jev or a failed call: the word order stands", async () => {
    setJevForTests(fake({ by: "fallback", status: "shadow", decision: { scores: [1, 1, 1], keep: [0, 1, 2] }, shadow: { decision: { keep: [] } } }));
    expect(await rerankRecords(records, "q", ctx)).toEqual(records);
    setJevForTests(fake({ by: "jev", decision: { keep: [] } }, false));
    expect(await rerankRecords(records, "q", ctx)).toEqual(records);
    setJevForTests(null);
    expect(await rerankRecords(records, "q", ctx)).toEqual(records);
    setJevForTests({ enabled: () => true, judge: async () => { throw new Error("down"); } } as unknown as Jev);
    expect(await rerankRecords(records, "q", ctx)).toEqual(records);
  });
});
