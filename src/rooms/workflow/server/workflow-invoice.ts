import { hardProblems, invoiceVerdict, type InvoiceCheckInput } from "@lane-pilot/kit";
import type { NodeExecutor, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { checkInvoicePdf } from "./invoice-pdf";
import type { ChainRuntime } from "../../contracts/server";

/**
 * The action `invoice.check` of the chain `invoice-send`: the invoice that was made is compared with the request. The amount, the INN
 * and the bank details are checked by code; whether the client and the service line are the ones asked for is the share of words they have in common
 * (packages/jev/src/judgments/invoice-check.ts); what the words cannot settle goes to the owner's review. No model is asked.
 * When the node names the PDF (`pdf_path`, on the machine `pdf_host`), code opens it first (src/server/invoice-pdf.ts): a missing, empty,
 * cut or not-a-PDF file is a failed check, and so is a machine that cannot be asked.
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
      const params = c.template(node.params) as Row;
      const input = invoiceInput(params);
      if ("pdf_path" in params) {
        const pdf = await checkInvoicePdf(ctx.host, text(params.pdf_host), text(params.pdf_path));
        if (!pdf.ok) {
          const hard = hardProblems(input);
          // A file that is wrong is a mismatch; a machine that could not be asked leaves it to the owner's review (unsure) unless the numbers already differ.
          return { output: { verdict: pdf.unreachable && !hard.length ? "unsure" : "mismatch", reasons: [...pdf.problems, ...hard], by: "rules" } };
        }
      }
      const decision = invoiceVerdict(input);
      return { output: { verdict: decision.verdict, reasons: decision.reasons, by: "rules" } };
    },
  } as NodeExecutor<ChainRuntime>);
}
