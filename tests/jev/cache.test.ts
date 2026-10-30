import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { choice, createJev, defineJudgment, noul, noulOf, type JevAnswer, type JevClient, type JevQuestion } from "@lane-pilot/jev";

const urgent = defineJudgment<{ text: string }, "urgent" | "calm">({
  id: "test.cache_urgency", version: 1, defaultMode: "active", timeoutMs: 1000,
  stateBuilder: (input) => ({ text: input.text }),
  questions: () => ({ urgent: noul("Is this urgent?"), kind: choice("What is it?", { bug: "a defect", ask: "a question" }) }),
  thresholds: { min_p: { default: 0.8, min: 0.5, max: 0.99, about: "yes needed" } },
  decide: (answers, t) => ({ decision: (noulOf(answers, "urgent") ?? 0) >= t.min_p! ? "urgent" : "calm" }),
  fallback: () => "calm",
  describe: (decision) => decision,
});

function scripted() {
  let calls = 0;
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      calls += 1;
      return { ok: true, model: "jev-test", usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 5, attempts: 1,
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]): [string, JevAnswer] => [id,
          q.type === "noul" ? { type: "noul", noul: 0.95 } : { type: "choice", choice: "bug", probabilities: { bug: 0.9, ask: 0.1 }, confidence: 0.8 }])) };
    },
  };
  return { client, calls: () => calls };
}

function database() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("jev answer cache", () => {
  it("a repeated state does not call the API again and writes no receipt for the hit", async () => {
    const db = database();
    const { client, calls } = scripted();
    const jev = createJev({ client, db });
    const first = await jev.judge(urgent, { text: "prod is down" });
    const second = await jev.judge(urgent, { text: "prod is down" });
    expect(first).toMatchObject({ by: "jev", decision: "urgent" });
    expect(second).toMatchObject({ by: "jev", decision: "urgent" });
    expect(calls()).toBe(1);
    // One receipt: the miss. The hit was no call.
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_jev_receipt").get() as { n: number }).n).toBe(1);
  });

  it("a different state misses; an expired entry calls again", async () => {
    let now = 1_000;
    const db = database();
    const { client, calls } = scripted();
    const jev = createJev({ client, db, cache: { ttlMs: 100 }, now: () => now });
    await jev.judge(urgent, { text: "prod is down" });
    await jev.judge(urgent, { text: "staging is down" });
    expect(calls()).toBe(2);
    now += 200;
    await jev.judge(urgent, { text: "prod is down" });
    expect(calls()).toBe(3);
  });

  it("cache: false disables", async () => {
    const { client, calls } = scripted();
    const jev = createJev({ client, cache: false });
    await jev.judge(urgent, { text: "prod is down" });
    await jev.judge(urgent, { text: "prod is down" });
    expect(calls()).toBe(2);
  });

  it("a failed call is not cached", async () => {
    let ok = false;
    let calls = 0;
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call() {
        calls += 1;
        return ok
          ? { ok: true, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1, answers: {} }
          : { ok: false, status: "timeout" as const, error: "t", latencyMs: 1, attempts: 1 };
      },
    };
    const jev = createJev({ client });
    await jev.judge(urgent, { text: "x" });
    ok = true;
    await jev.judge(urgent, { text: "x" });
    expect(calls).toBe(2);
  });

  it("the budget is spent only on real calls", async () => {
    const { client, calls } = scripted();
    const jev = createJev({ client });
    const budget = { remaining: 1 };
    const first = await jev.judge(urgent, { text: "prod is down" }, { budget });
    const second = await jev.judge(urgent, { text: "prod is down" }, { budget });
    expect(first.by).toBe("jev");
    expect(second.by).toBe("jev");
    expect(calls()).toBe(1);
  });
});
