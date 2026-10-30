import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevClient } from "@lane-pilot/jev";
import { DIGEST_KEEP_TAIL, judgeSessionDigest, sessionDigestJudgment, sessionDigestText, toolPairsOf, type ToolPair } from "../../src/rooms/writer/session-digest";

const pair = (tool: string, n: number): ToolPair => ({ tool, call: `${tool} ${n}`, result: `out-${n}` });
const events = (n: number) => Array.from({ length: n }, (_, index) => ({ data: { item: { type: "toolCall", tool: "read", input: { path: `f${index}.ts` }, output: `out-${index}` } } }));

function jevWith(noul: number) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      return { ok: true, model: "jev-test", usage: { input_tokens: 900, output_tokens: 40 }, latencyMs: 90, attempts: 1,
        answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul" as const, noul }])) };
    },
  };
  return { db, jev: createJev({ client, db }) };
}

describe("session.tool_pair: compaction without a summary", () => {
  it("folds tool events into call+result pairs", () => {
    const pairs = toolPairsOf(events(3));
    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toMatchObject({ tool: "read", result: "out-0" });
    expect(toolPairsOf([{ data: { item: { type: "fileChange", path: "x" } } }])).toEqual([]);
  });

  it("keeps kept pairs verbatim and the newest ones always, drops the rest", () => {
    const pairs = Array.from({ length: DIGEST_KEEP_TAIL + 3 }, (_, index) => pair("read", index));
    const keep = [true, false, false]; // only the asked head is judged
    const text = sessionDigestText(pairs, keep)!;
    expect(text).toContain("[read] read 0\nout-0");
    expect(text).not.toContain("out-1");
    expect(text).toContain("out-" + (pairs.length - 1)); // the tail survives unasked
    expect(text).toContain("stale");
    expect(sessionDigestText(pairs, keep.map(() => true))).toBeNull();
  });

  it("active: stale pairs drop, kept text stays verbatim", async () => {
    const { jev } = jevWith(0.05);
    const digest = await judgeSessionDigest(jev, { goal: "fix the writer", events: events(DIGEST_KEEP_TAIL + 4) },
      { settings: { "jev.modes": "session.tool_pair=active" } });
    expect(digest).not.toBeNull();
    expect(digest).toContain("out-" + (DIGEST_KEEP_TAIL + 3));
    expect(digest).not.toContain("out-0\n");
  });

  it("shadow (the default): asks, records, changes nothing", async () => {
    const { db, jev } = jevWith(0.05);
    expect(await judgeSessionDigest(jev, { goal: "g", events: events(DIGEST_KEEP_TAIL + 4) }, { settings: {} })).toBeNull();
    const row = db.prepare("SELECT judgment, mode, decided_by FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(row).toMatchObject({ judgment: "session.tool_pair", mode: "shadow", decided_by: "fallback" });
  });

  it("tiny sessions are never asked; decide keeps at min_p", () => {
    const input = { goal: "g", pairs: [pair("a", 1), pair("b", 2)] };
    const answers = { p1: { type: "noul" as const, noul: 0.8 }, p2: { type: "noul" as const, noul: 0.1 } };
    expect(sessionDigestJudgment.decide(answers, { min_p: 0.5 }, input)).toEqual({ decision: [true, false] });
    expect(sessionDigestJudgment.fallback(input)).toEqual([true, true]);
  });
});
