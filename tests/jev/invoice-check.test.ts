import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/database";
import type { JevClient } from "../../src/jev/client";
import { hardProblems, invoiceCheck, overlap, validAccount, validCorrAccount, validInn, type InvoiceCheckInput } from "../../src/jev/judgments/invoice-check";
import { createJev } from "../../src/jev/run";
import { setJevForTests } from "../../src/jev/runtime";
import type { JevAnswer, JevQuestion } from "../../src/jev/types";
import { invoiceInput, registerInvoiceActions } from "../../src/server/workflow-invoice";
import { engineOn, journalDb } from "../workflow/engine-helpers";
import { parseWorkflow } from "../../src/workflow/validate";

afterEach(() => setJevForTests(null));

const clean = (): InvoiceCheckInput => ({
  request: { company: "ООО «Ромашка»", amount: 50000, service: "SEO-сопровождение за октябрь", inn: "7707083893" },
  invoice: { number: "142", client_name: "Общество с ограниченной ответственностью «Ромашка»", client_inn: "7707083893", amount: 50000, service: "SEO-сопровождение, октябрь 2026",
    pay_bik: "044525225", pay_account: "40702810200000012345", pay_corr_account: "30101810400000000225", payee_inn: "500100732259" },
});
const changed = (patch: Partial<InvoiceCheckInput["invoice"]>, request: Partial<InvoiceCheckInput["request"]> = {}): InvoiceCheckInput => ({ request: { ...clean().request, ...request }, invoice: { ...clean().invoice, ...patch } });

describe("the check digits", () => {
  it("accepts real numbers and refuses a changed digit", () => {
    expect(validInn("7707083893")).toBe(true);
    expect(validInn("500100732259")).toBe(true);
    expect(validInn("7707083894")).toBe(false);
    expect(validInn("500100732258")).toBe(false);
    expect(validInn("12345")).toBe(false);
    expect(validInn("77070 83893")).toBe(true);
    expect(validCorrAccount("044525225", "30101810400000000225")).toBe(true);
    expect(validCorrAccount("044525225", "30101810400000000226")).toBe(false);
    expect(validAccount("044525225", "40702810200000012345")).toBe(true);
    expect(validAccount("044525225", "40702810200000012346")).toBe(false);
    expect(validAccount("044525225", "4070281020000001234")).toBe(false);
  });
});

describe("what code settles", () => {
  it("passes a clean invoice", () => expect(hardProblems(clean())).toEqual([]));

  // Audit 2026-10-08 round 4, item 20: `Math.abs(x - NaN) > 0.005` is false, so an amount that could not be read switched the check off.
  it("an amount in the request that cannot be read is a failed check, never a pass", () => {
    for (const amount of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(hardProblems(changed({ amount: 99999 }, { amount })).join(" "), String(amount)).toMatch(/request.*amount/);
    }
    expect(invoiceInput({ amount: "1,500.50", invoice_amount: 1500.5 }).request.amount).toBeNaN();
    expect(invoiceInput({ amount: "abc" }).request.amount).toBeNaN();
  });

  it("names every hard difference", () => {
    expect(hardProblems(changed({ amount: 55000 }))).toEqual(["the amount in the invoice is 55000, the request says 50000"]);
    expect(hardProblems(changed({ amount: 50000.004 }))).toEqual([]);
    expect(hardProblems(changed({ number: " " }))).toEqual(["the invoice has no number"]);
    expect(hardProblems(changed({ client_inn: "7707083894" }))[0]).toContain("is not a valid INN");
    expect(hardProblems(changed({ client_inn: "500100732259" }))).toEqual(["the client's INN in the invoice is 500100732259, the request says 7707083893"]);
    expect(hardProblems(changed({ client_inn: "500100732259" }, { inn: "" }))).toEqual([]);
    expect(hardProblems(changed({ pay_bik: "123456789" }))[0]).toContain("not a Russian BIK");
    expect(hardProblems(changed({ pay_account: "40702810200000012346" }))[0]).toContain("does not fit the BIK");
    expect(hardProblems(changed({ pay_corr_account: "30101810400000000226" }))[0]).toContain("correspondent account");
    expect(hardProblems(changed({ amount: Number.NaN }))).toContain("the invoice has no amount");
  });

  it("compares words without the legal form", () => {
    expect(overlap("ООО «Ромашка»", "Общество с ограниченной ответственностью «Ромашка»")).toBe(1);
    expect(overlap("Ромашка", "Василёк")).toBe(0);
  });
});

describe("the judgment", () => {
  const at = (company: number, service: number) => ({ company: { type: "noul", noul: company }, service: { type: "noul", noul: service } }) as Record<string, JevAnswer>;
  const t = { min_same: 0.8, max_different: 0.25 };

  it("match only when both answers are sure and the numbers are in order", () => {
    expect(invoiceCheck.decide(at(0.95, 0.9), t, clean())).toMatchObject({ decision: { verdict: "match" } });
    expect(invoiceCheck.decide(at(0.95, 0.5), t, clean())).toMatchObject({ decision: { verdict: "unsure" } });
    expect(invoiceCheck.decide(at(0.1, 0.9), t, clean())).toMatchObject({ decision: { verdict: "mismatch", reasons: [expect.stringContaining("different company")] } });
    expect(invoiceCheck.decide(at(0.9, 0.1), t, clean())).toMatchObject({ decision: { verdict: "mismatch", reasons: [expect.stringContaining("different work")] } });
    expect(invoiceCheck.decide({}, t, clean())).toEqual({ escalate: "owner" });
  });

  it("a hard problem is a mismatch whatever Jev says", () => {
    expect(invoiceCheck.decide(at(0.99, 0.99), t, changed({ amount: 55000 }))).toMatchObject({ decision: { verdict: "mismatch" } });
  });

  it("the fallback is deterministic: a match needs the words to agree, a doubt is unsure, a hard problem is a mismatch", () => {
    expect(invoiceCheck.fallback(clean())).toMatchObject({ verdict: "match" });
    expect(invoiceCheck.fallback(changed({ client_name: "Василёк" }))).toMatchObject({ verdict: "unsure" });
    expect(invoiceCheck.fallback(changed({ amount: 1 }))).toMatchObject({ verdict: "mismatch" });
  });

  it("sends Jev the names and the service lines only, never the amount or the bank details", () => {
    const state = JSON.stringify(invoiceCheck.stateBuilder(clean()));
    expect(state).toContain("Ромашка");
    for (const secret of ["40702810200000012345", "30101810400000000225", "044525225", "7707083893", "500100732259", "50000"]) expect(state).not.toContain(secret);
  });
});

describe("the chain action invoice.check", () => {
  const definition = (withPdf: boolean) => ({
    id: "t-invoice", name: { en: "Invoice check", ru: "Проверка счёта" }, description: { en: "Checks an invoice", ru: "Проверяет счёт" }, examples: { en: ["check the invoice"], ru: ["проверь счёт"] },
    nodes: [{ id: "check", type: "action", action: "invoice.check", company: "{{$inputs.company}}", amount: "{{$inputs.amount}}", service: "{{$inputs.service}}", inn: "{{$inputs.inn}}",
      number: "{{$inputs.number}}", client_name: "{{$inputs.client_name}}", client_inn: "{{$inputs.client_inn}}", invoice_amount: "{{$inputs.invoice_amount}}", invoice_service: "{{$inputs.invoice_service}}",
      pay_bik: "{{$inputs.pay_bik}}", pay_account: "{{$inputs.pay_account}}", pay_corr_account: "{{$inputs.pay_corr_account}}", payee_inn: "{{$inputs.payee_inn}}",
      ...(withPdf ? { pdf_path: "{{$inputs.pdf_path}}", pdf_host: "{{$inputs.pdf_host}}" } : {}),
      out: { verdict: "match|mismatch|unsure", reasons: "string[]", by: "jev|rules" } }],
    inputs: Object.fromEntries(["company", "amount", "service", "inn", "number", "client_name", "client_inn", "invoice_amount", "invoice_service", "pay_bik", "pay_account", "pay_corr_account", "payee_inn", ...(withPdf ? ["pdf_path", "pdf_host"] : [])].map((name) => [name, { type: name.includes("amount") ? "number" : "string", default: name.includes("amount") ? 0 : "" }])),
    outputs: { verdict: "string", reasons: "string[]", by: "string" },
    edges: [{ from: "start", to: "check" }, { from: "check", to: "end", with: { verdict: "check.verdict", reasons: "check.reasons", by: "check.by" } }],
  });
  const workflow = parseWorkflow(definition(false));
  const pdfWorkflow = parseWorkflow(definition(true));
  const inputs = (value: InvoiceCheckInput) => ({ ...value.request, number: value.invoice.number, client_name: value.invoice.client_name, client_inn: value.invoice.client_inn, invoice_amount: value.invoice.amount,
    invoice_service: value.invoice.service, pay_bik: value.invoice.pay_bik, pay_account: value.invoice.pay_account, pay_corr_account: value.invoice.pay_corr_account, payee_inn: value.invoice.payee_inn });
  const runCheck = async (value: InvoiceCheckInput) => {
    const engine = engineOn(journalDb(), {}, { resolveWorkflow: () => workflow });
    registerInvoiceActions(engine, { effectiveProjectSettings: async () => ({ values: {} }) } as never);
    const started = engine.start({ workflow, inputs: inputs(value) });
    return (await started.done);
  };
  const jevWith = (answerFor: (id: string, question: JevQuestion) => JevAnswer) => {
    const requests: unknown[] = [];
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request) {
        requests.push(request.state);
        return { ok: true, model: "jev-1", usage: { input_tokens: 10, output_tokens: 1 }, latencyMs: 5, attempts: 1,
          answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, answerFor(id, question)])) };
      },
    };
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    setJevForTests(createJev({ client, db: openDatabase(bb) }));
    return requests;
  };

  // Audit 2026-10-08 round 4, item 20: the PDF is opened by code, on the named machine, before anything is compared.
  it("a node that names the PDF opens it first: a wrong file is a mismatch, a machine that does not answer is a review, a good file goes on to the comparison", async () => {
    const run = async (call: (method: string, input: Record<string, unknown>) => Promise<unknown>, value: InvoiceCheckInput = clean()) => {
      const engine = engineOn(journalDb(), {}, { resolveWorkflow: () => pdfWorkflow });
      registerInvoiceActions(engine, { effectiveProjectSettings: async () => ({ values: {} }), host: { call } } as never);
      return (await engine.start({ workflow: pdfWorkflow, inputs: { ...inputs(value), pdf_path: "/deals/invoice-142.pdf", pdf_host: "mini" } }).done).output as { verdict: string; reasons: string[]; by: string };
    };
    const answer = (stdout: string) => async () => ({ hostId: "mini", exitCode: 0, stdout, stderr: "" });
    expect(await run(answer("exists=1\nsize=900\nmagic=255044462d\neof=1\npages=1\npacked=0\n"))).toMatchObject({ verdict: "match", by: "rules" });
    expect(await run(answer("exists=0\n"))).toMatchObject({ verdict: "mismatch", reasons: [expect.stringMatching(/does not exist/)] });
    expect(await run(answer("exists=1\nsize=0\n"))).toMatchObject({ verdict: "mismatch", reasons: [expect.stringMatching(/empty/)] });
    expect(await run(answer("exists=1\nsize=70\nmagic=3c68746d6c\n"))).toMatchObject({ verdict: "mismatch", reasons: [expect.stringMatching(/not a PDF/)] });
    const down = await run(async () => { throw new Error("host unreachable"); });
    expect(down).toMatchObject({ verdict: "unsure", reasons: [expect.stringMatching(/could not be checked/)] });
    // The numbers already differ: a machine that does not answer does not soften it.
    expect(await run(async () => { throw new Error("host unreachable"); }, changed({ amount: 55000 }))).toMatchObject({ verdict: "mismatch" });
  });

  it("reads the params from the node, with the amount as a number", () => {
    expect(invoiceInput({ amount: "50 000,50", invoice_amount: 50000, company: "A" })).toMatchObject({ request: { amount: 50000.5, company: "A" }, invoice: { amount: 50000 } });
  });

  it("an amount written as \"1,500.50\" reaches the check unread and fails it, even when Jev would say yes", () => {
    const params = { company: "ООО «Ромашка»", amount: "1,500.50", service: "SEO", inn: "7707083893", number: "142", client_name: "Ромашка", client_inn: "7707083893", invoice_amount: 99999,
      pay_bik: "044525225", pay_account: "40702810200000012345", pay_corr_account: "30101810400000000225", payee_inn: "500100732259" };
    expect(hardProblems(invoiceInput(params))).toEqual([expect.stringMatching(/request.*amount/)]);
    expect(invoiceCheck.fallback(invoiceInput(params)).verdict).toBe("mismatch");
  });

  it("without Jev it answers by the rule", async () => {
    const summary = await runCheck(clean());
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({ verdict: "match", by: "rules" });
    expect(await runCheck(changed({ amount: 55000 }))).toMatchObject({ output: { verdict: "mismatch", by: "rules" } });
  });

  it("with Jev the two answered questions decide, and the request carries no number", async () => {
    const requests = jevWith(() => ({ type: "noul", noul: 0.95 }));
    expect(await runCheck(clean())).toMatchObject({ output: { verdict: "match", by: "jev" } });
    expect(JSON.stringify(requests)).not.toContain("40702810200000012345");
    jevWith((id) => ({ type: "noul", noul: id.endsWith("company") ? 0.05 : 0.95 }));
    expect(await runCheck(clean())).toMatchObject({ output: { verdict: "mismatch", by: "jev" } });
  });
});
