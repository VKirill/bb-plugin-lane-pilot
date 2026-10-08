import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database";
import { forgetSecrets, registerSecrets } from "@lane-pilot/kit";
import { choice, defineJudgment, noul, noulOf } from "../../src/jev/registry";
import { summarizeReceipts } from "../../src/jev/receipts";
import { createJev } from "../../src/jev/run";
import type { JevClient } from "../../src/jev/client";
import type { JevAnswer, JevCallResult, JevQuestion } from "../../src/jev/types";

type Input = { text: string; topic?: string };
/** Urgent when p(yes) clears the threshold; escalates in the grey band; the fallback is the old keyword rule. */
const urgency = defineJudgment<Input, "urgent" | "calm">({
  id: "test.urgency", version: 3, defaultMode: "active", timeoutMs: 1000,
  stateBuilder: (input) => ({ text: input.text }),
  questions: (input) => ({ urgent: noul(`Is this urgent${input.topic ? ` for ${input.topic}` : ""}?`), kind: choice("What is it?", { bug: "a defect", ask: "a question" }) }),
  thresholds: { min_p: { default: 0.8, min: 0.5, max: 0.99, about: "yes needed" } },
  decide: (answers, t) => {
    const p = noulOf(answers, "urgent") ?? 0;
    return p >= t.min_p! ? { decision: "urgent" } : p <= 1 - t.min_p! ? { decision: "calm" } : { escalate: "human" };
  },
  fallback: (input) => (/urgent|asap/i.test(input.text) ? "urgent" : "calm"),
  describe: (decision) => decision,
});

function scripted(answerFor: (id: string, question: JevQuestion) => JevAnswer, failure?: JevCallResult) {
  const requests: Array<{ state: unknown; ids: string[]; model: string | undefined }> = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      requests.push({ state: request.state, ids: Object.keys(request.questions), model: request.model });
      if (failure) return failure;
      return { ok: true, model: "jev-1.13.0", usage: { input_tokens: 400, output_tokens: 40 }, latencyMs: 120, attempts: 1,
        answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerFor(id, question)])) };
    },
  };
  return { client, requests };
}
const yes = (p: number) => (id: string, question: JevQuestion): JevAnswer => question.type === "noul" ? { type: "noul", noul: p } : { type: "choice", choice: "bug", probabilities: { bug: 0.9, ask: 0.1 }, confidence: 0.8 };
function database() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("jev run", () => {
  it("decides from probabilities and writes a receipt without the state", async () => {
    const db = database();
    const { client } = scripted(yes(0.95));
    const jev = createJev({ client, db });
    const verdict = await jev.judge(urgency, { text: "The payout page is down, my token is sk-live-123" }, { projectId: "p1", runId: "r1", subject: "t1" });
    expect(verdict).toMatchObject({ by: "jev", decision: "urgent" });
    const row = db.prepare("SELECT * FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(row).toMatchObject({ judgment: "test.urgency", version: 3, model: "jev-1.13.0", mode: "active", project_id: "p1", run_id: "r1", subject: "t1", status: "ok", decision: "urgent", decided_by: "jev", questions: 2, batch_size: 1, latency_ms: 120, tokens_in: 400, tokens_out: 40 });
    expect(String(row.input_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("payout page");
    expect(JSON.parse(String(row.answers_json))).toMatchObject({ urgent: { kind: "noul", value: 0.95 }, kind: { kind: "choice", value: "bug", top: [["bug", 0.9], ["ask", 0.1]], confidence: 0.8 } });
    expect(JSON.parse(String(row.thresholds_json))).toEqual({ min_p: 0.8 });
  });

  it("escalates a grey case and lets the caller label the receipt", async () => {
    const db = database();
    const jev = createJev({ client: scripted(yes(0.55)).client, db });
    const verdict = await jev.judge(urgency, { text: "maybe soon" });
    expect(verdict).toMatchObject({ by: "escalate", to: "human" });
    expect(db.prepare("SELECT decided_by, escalated_to, decision FROM lane_pilot_jev_receipt").get()).toEqual({ decided_by: "escalated", escalated_to: "human", decision: "escalate:human" });
    jev.outcome(verdict.receiptId, "agree");
    expect(db.prepare("SELECT outcome FROM lane_pilot_jev_receipt").get()).toEqual({ outcome: "agree" });
  });

  it("reads the thresholds and the mode from the project settings", async () => {
    const jev = createJev({ client: scripted(yes(0.7)).client, db: database() });
    expect(await jev.judge(urgency, { text: "x" })).toMatchObject({ by: "escalate" });
    expect(await jev.judge(urgency, { text: "x" }, { settings: { "jev.thresholds": "test.urgency.min_p=0.6" } })).toMatchObject({ by: "jev", decision: "urgent" });
    expect(await jev.judge(urgency, { text: "x" }, { settings: { "jev.thresholds": "test.urgency.min_p=0.1" } })).toMatchObject({ by: "jev", decision: "urgent" });
    expect(await jev.judge(urgency, { text: "x" }, { settings: { "jev.modes": "test.urgency=off" } })).toMatchObject({ by: "fallback", status: "off" });
    expect(await jev.judge(urgency, { text: "x" }, { settings: { "jev.enabled": false } })).toMatchObject({ by: "fallback", status: "off" });
  });

  it("asks nothing and stores nothing when the judgment is off", async () => {
    const db = database();
    const { client, requests } = scripted(yes(0.95));
    const verdict = await createJev({ client, db }).judge(urgency, { text: "asap" }, { settings: { "jev.modes": "test.urgency=off" } });
    expect(verdict).toMatchObject({ by: "fallback", decision: "urgent", status: "off", receiptId: null });
    expect(requests).toHaveLength(0);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_jev_receipt").get()).toEqual({ n: 0 });
  });

  it("shadow mode asks and records, but the caller keeps the old decision", async () => {
    const db = database();
    const verdict = await createJev({ client: scripted(yes(0.95)).client, db }).judge(urgency, { text: "calm text" }, { settings: { "jev.modes": "test.urgency=shadow" } });
    expect(verdict).toMatchObject({ by: "fallback", decision: "calm", status: "shadow", shadow: { decision: "urgent" } });
    expect(db.prepare("SELECT mode, decided_by, decision, status FROM lane_pilot_jev_receipt").get()).toEqual({ mode: "shadow", decided_by: "fallback", decision: "urgent", status: "ok" });
  });

  it("falls back to the deterministic rule when there is no key or the request fails", async () => {
    for (const status of ["disabled", "timeout", "error", "breaker_open", "budget", "invalid"] as const) {
      const db = database();
      const failure: JevCallResult = { ok: false, status, error: status, latencyMs: 5, attempts: 1 };
      const verdict = await createJev({ client: scripted(yes(0), failure).client, db }).judge(urgency, { text: "ASAP please" });
      expect(verdict).toMatchObject({ by: "fallback", decision: "urgent", status });
      expect(db.prepare("SELECT status, decided_by, answers_json, tokens_in FROM lane_pilot_jev_receipt").get()).toEqual({ status, decided_by: "fallback", answers_json: null, tokens_in: null });
    }
  });

  it("falls back when a decision rule throws", async () => {
    const broken = defineJudgment<Input, string>({ ...urgency, id: "test.broken", decide: () => { throw new Error("bad rule"); }, describe: (d) => d });
    const verdict = await createJev({ client: scripted(yes(1)).client, db: database() }).judge(broken, { text: "asap" });
    expect(verdict).toMatchObject({ by: "fallback", decision: "urgent", status: "invalid" });
  });

  it("puts the questions of many inputs over the same state in one request, and splits at 48 questions", async () => {
    const { client, requests } = scripted(yes(0.95));
    const jev = createJev({ client, db: database() });
    const verdicts = await jev.judgeMany(urgency, Array.from({ length: 5 }, (_, i) => ({ text: "same state", topic: `topic ${i}` })));
    expect(verdicts.map((v) => v.by)).toEqual(Array(5).fill("jev"));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.ids).toHaveLength(10);
    expect(requests[0]!.ids.slice(0, 4)).toEqual(["0::urgent", "0::kind", "1::urgent", "1::kind"]);
    const many = await jev.judgeMany(urgency, Array.from({ length: 30 }, (_, i) => ({ text: "same state", topic: `t${i}` })));
    expect(many).toHaveLength(30);
    expect(requests.slice(1).map((r) => r.ids.length)).toEqual([48, 12]);
  });

  it("sends inputs with different states as separate requests", async () => {
    const { client, requests } = scripted(yes(0.95));
    await createJev({ client, db: database() }).judgeMany(urgency, [{ text: "one" }, { text: "two" }]);
    expect(requests.map((r) => r.state)).toEqual([{ text: "one" }, { text: "two" }]);
  });

  it("bundles different judgments over the same state into one request and gives each its own answers", async () => {
    const db = database();
    const length = defineJudgment<Input, number>({ ...urgency, id: "test.length", questions: () => ({ long: noul("Is it long?") }), decide: (a) => ({ decision: Math.round(noulOf(a, "long")! * 10) }), fallback: () => 0, describe: String });
    const { client, requests } = scripted((id) => ({ type: "noul", noul: id.endsWith("long") ? 0.3 : 0.9 }));
    const verdicts = await createJev({ client, db }).judgeBundle([{ judgment: urgency, input: { text: "same" } }, { judgment: length, input: { text: "same" } }]);
    expect(requests).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ by: "jev", decision: "urgent" });
    expect(verdicts[1]).toMatchObject({ by: "jev", decision: 3 });
    const rows = db.prepare("SELECT judgment, batch_size, tokens_in FROM lane_pilot_jev_receipt ORDER BY id").all();
    expect(rows).toEqual([{ judgment: "test.urgency", batch_size: 2, tokens_in: 200 }, { judgment: "test.length", batch_size: 2, tokens_in: 200 }]);
  });

  it("masks known secrets in the state before it leaves", async () => {
    registerSecrets(["sk-live-verysecret-1234"]);
    try {
      const { client, requests } = scripted(yes(0.95));
      await createJev({ client, db: database() }).judge(urgency, { text: "key is sk-live-verysecret-1234" });
      expect(JSON.stringify(requests[0]!.state)).not.toContain("verysecret");
    } finally { forgetSecrets(); }
  });

  it("summarizes receipts by judgment, mode, status and decider", async () => {
    const db = database();
    const jev = createJev({ client: scripted(yes(0.95)).client, db });
    await jev.judge(urgency, { text: "a" });
    await jev.judge(urgency, { text: "b" });
    expect(summarizeReceipts(db)).toEqual([{ judgment: "test.urgency", mode: "active", status: "ok", decided_by: "jev", n: 2, avg_latency_ms: 120, avg_tokens_in: 400 }]);
  });
});
