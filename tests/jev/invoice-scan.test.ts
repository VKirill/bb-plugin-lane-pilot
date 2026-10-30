import { describe, expect, it } from "vitest";
import { invoiceScanJudgment } from "@lane-pilot/jev/judgments/invoice-scan";
import { validateDeliverable } from "../../src/rooms/validators/deliverable";
import { createJev, setJevForTests, type JevAnswer, type JevClient } from "@lane-pilot/jev";

const input = { expected: { inn: "7707083893", amount: "1500.00" }, page: { format: "png" as const, data_base64: "AA==" } };
const n = (v: number) => ({ type: "noul" as const, noul: v });
const b = () => ({ type: "box" as const, box: { top: 0, bottom: 0.1, left: 0, right: 0.3 }, confidence: 0.9 });

describe("invoice.scan", () => {
  it("asks only for fields the brief supplies; ok only when all match", () => {
    expect(Object.keys(invoiceScanJudgment.questions(input))).toEqual(["inn_ok", "inn_at", "amount_ok", "amount_at"]);
    const ok = invoiceScanJudgment.decide({ inn_ok: n(0.9), amount_ok: n(0.85) }, { ok_p: 0.7 }, input);
    expect(ok.decision?.ok).toBe(true);
    const bad = invoiceScanJudgment.decide({ inn_ok: n(0.9), amount_ok: n(0.4) }, { ok_p: 0.7 }, input);
    expect(bad.decision?.failed).toEqual(["amount"]);
  });
  it("a scanned invoice passes through the validator when fields match", async () => {
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request) {
        const answers: Record<string, JevAnswer> = {};
        for (const [id, q] of Object.entries(request.questions)) answers[id] = q.type === "noul" ? n(0.95) : b();
        return { ok: true, answers, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
      },
    };
    setJevForTests(createJev({ client, db: null }));
    const verdict = await validateDeliverable("invoice", "/tmp/i.pdf", {
      host: { run: async (_i, _c, cmd) => cmd.includes("pdftoppm") || cmd.includes("base64") ? { exitCode: 0, stdout: "AA==", stderr: "" } : cmd.includes("pdftotext") ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" } },
      hostId: "h1",
      brief: { inn: "7707083893", amount: 1500 },
      jevCtx: { settings: { "jev.modes": "invoice.scan=active" } },
    });
    setJevForTests(null);
    expect(verdict.ok).toBe(true);
  });
  it("whitelist state: only page ref and expected fields", () => {
    const state = invoiceScanJudgment.stateBuilder({ ...input, leak: "sk-secret" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["expected", "page"]);
    expect(JSON.stringify(state)).not.toContain("sk-secret");
  });
});
