import { box, defineJudgment, noul, noulOf } from "../registry";
import type { JevAsset, JevBox } from "../types";

/**
 * Invoices that arrive as scans without a text layer (B4; the ocr_confidence_bounding_boxes and
 * reading_scanned_documents cookbooks). `validateInvoice` parses `pdftotext` and gives up on an empty layer; this
 * judgment asks the page image whether each expected field reads as the request says — a checkable question, not free
 * OCR. Fields are asked only for values the brief supplies.
 */
export const INVOICE_SCAN_ID = "invoice.scan";
export const SCAN_FIELDS = ["inn", "bik", "amount", "number"] as const;
export type ScanField = (typeof SCAN_FIELDS)[number];

export type InvoiceScanInput = { expected: Partial<Record<ScanField, string>>; page: { format: "png" | "jpg" | "jpeg"; data_base64: string } };
export type InvoiceScanDecision = { fields: Record<string, number>; failed: string[]; ok: boolean };

const REF = "invoice-page-9f3";
const RU: Record<ScanField, string> = { inn: "the payer or payee INN (10 or 12 digits)", bik: "the bank BIK (9 digits starting 04)", amount: "the invoice total amount", number: "the invoice number" };

export const invoiceScanJudgment = defineJudgment<InvoiceScanInput, InvoiceScanDecision>({
  id: INVOICE_SCAN_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 20_000,
  stateBuilder: (input) => ({
    page: REF,
    expected: Object.fromEntries(SCAN_FIELDS.filter((f) => input.expected[f]).map((f) => [f, String(input.expected[f]).slice(0, 60)])),
  }),
  assets: (input) => ({ [REF]: { type: "image", format: input.page.format, data_base64: input.page.data_base64 } satisfies JevAsset }),
  questions: (input) => Object.fromEntries(SCAN_FIELDS.filter((f) => input.expected[f]).flatMap((f) => [
    [`${f}_ok`, noul(`On the invoice page \`page\`, does ${RU[f]} read as ${JSON.stringify(String(input.expected[f]))}?`,
      { true: "the page clearly shows this value", false: "the field is missing, illegible, or shows a different value" })],
    [`${f}_at`, box(`${RU[f]} on \`page\``)],
  ])),
  thresholds: { ok_p: { default: 0.7, min: 0.4, max: 0.95, about: "p the field must show the expected value" } },
  decide(answers, t, input) {
    const fields: Record<string, number> = {};
    const failed: string[] = [];
    for (const f of SCAN_FIELDS.filter((f) => input.expected[f])) {
      const p = Math.round((noulOf(answers, `${f}_ok`) ?? 0) * 1000) / 1000;
      fields[f] = p;
      if (p < t.ok_p!) failed.push(f);
    }
    return { decision: { fields, failed, ok: failed.length === 0 } };
  },
  fallback: () => ({ fields: {}, failed: [], ok: false }),
  describe: (d) => d.ok ? "fields match" : `fields off: ${d.failed.join(",")}`,
});
