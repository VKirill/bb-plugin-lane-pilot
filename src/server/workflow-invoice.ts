import { invoiceCheck, type InvoiceCheckDecision, type InvoiceCheckInput } from "../jev/judgments/invoice-check";
import { jev } from "../jev/runtime";
import type { NodeExecutor, WorkflowEngine } from "../workflow/engine";
import type { ServerCore } from "./core";
import type { ChainRuntime } from "./workflow-runtime";

/**
 * The action `invoice.check` of the chain `invoice-send`: the invoice that was made is compared with the request. The amount, the INN
 * and the bank details are checked by code; whether the client and the service line are the ones asked for is a Jev judgment
 * (`invoice.check`, src/jev/judgments/invoice-check.ts), answered by the deterministic rule when Jev is off or cannot be asked.
 * It decides only where the chain goes next: a match goes to the owner's approval, anything else to a review first.
 */
type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const number = (value: unknown): number => (typeof value === "number" ? value : Number(String(value ?? "").replace(/\s+/g, "").replace(",", ".")));

/** The judgment's input from the node's params (the request as the owner gave it, the invoice as the Elba step read it). */
export function invoiceInput(params: Row): InvoiceCheckInput {
  return {
    request: { company: text(params.company), amount: number(params.amount), service: text(params.service), inn: text(params.inn) },
    invoice: {
      number: text(params.number), client_name: text(params.client_name), client_inn: text(params.client_inn), amount: number(params.invoice_amount), service: text(params.invoice_service),
      pay_bik: text(params.pay_bik), pay_account: text(params.pay_account), pay_corr_account: text(params.pay_corr_account), payee_inn: text(params.payee_inn),
    },
  };
}

export function registerInvoiceActions(engine: WorkflowEngine, ctx: ServerCore): void {
  engine.register<ChainRuntime>("invoice.check", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const input = invoiceInput(c.template(node.params) as Row);
      const instance = jev();
      const project = c.runtime?.projectId;
      const settings = project ? (await ctx.effectiveProjectSettings(project).catch(() => null))?.values : undefined;
      const verdict = instance
        ? await instance.judge(invoiceCheck, input, { projectId: project ?? null, runId: c.runId, subject: "invoice", settings, signal: c.signal })
        : { by: "fallback" as const, decision: invoiceCheck.fallback(input), status: "off" as const, receiptId: null };
      // «escalate» means Jev's answers were missing or unclear: the owner looks (unsure), as for any doubt.
      const decision: InvoiceCheckDecision = verdict.by === "escalate" ? { verdict: "unsure", reasons: ["the check could not be completed automatically"] } : verdict.decision;
      return { output: { verdict: decision.verdict, reasons: decision.reasons, by: verdict.by === "jev" ? "jev" : "rules" } };
    },
  } as NodeExecutor<ChainRuntime>);
}
