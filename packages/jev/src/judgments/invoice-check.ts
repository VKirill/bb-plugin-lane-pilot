/**
 * The rules behind the action `invoice.check`: does the invoice made in the accounting service say what the owner asked for? Numbers and
 * bank details are checked by code (an amount is equal or it is not; an INN, a BIK and an account have check digits); the client and the
 * service line are compared by the words they share. No model reads them. Anything the words cannot settle is `unsure` and goes to the
 * owner's review; nothing is sent without the owner.
 * (Kept in the jev package only because the PII scan shares the INN check digits; nothing here asks a model.)
 */
export type InvoiceRequest = { company: string; amount: number; service: string; inn: string };
export type InvoiceFound = {
  number: string; client_name: string; client_inn: string; amount: number; service: string;
  pay_bik: string; pay_account: string; pay_corr_account: string; payee_inn: string;
};
export type InvoiceCheckInput = { request: InvoiceRequest; invoice: InvoiceFound };
export type InvoiceVerdict = "match" | "mismatch" | "unsure";
export type InvoiceCheckDecision = { verdict: InvoiceVerdict; reasons: string[] };

const digits = (text: string) => text.replace(/\s+/g, "");

/** The control sum of a 10-digit (legal entity) or 12-digit (sole trader) INN. */
export function validInn(inn: string): boolean {
  const text = digits(inn);
  if (!/^\d+$/.test(text)) return false;
  const sum = (weights: number[]) => weights.reduce((total, weight, index) => total + weight * Number(text[index]), 0) % 11 % 10;
  if (text.length === 10) return sum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(text[9]);
  if (text.length === 12) return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(text[10]) && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(text[11]);
  return false;
}

const WEIGHTS = [7, 1, 3];
const controlSum = (text: string) => text.split("").reduce((total, char, index) => total + (Number(char) * WEIGHTS[index % 3]!) % 10, 0) % 10 === 0;
/** An account of a bank client (`40702…`) is checked with the last three digits of the BIK, a correspondent account with `0` and digits 5-6 of it. */
export const validAccount = (bik: string, account: string): boolean => /^\d{9}$/.test(bik) && /^\d{20}$/.test(account) && controlSum(`${bik.slice(-3)}${account}`);
export const validCorrAccount = (bik: string, account: string): boolean => /^\d{9}$/.test(bik) && /^\d{20}$/.test(account) && controlSum(`0${bik.slice(4, 6)}${account}`);

/** What code can settle: the problems found (empty when the numbers and the bank details are in order). */
export function hardProblems(input: InvoiceCheckInput): string[] {
  const { request, invoice } = input;
  const problems: string[] = [];
  if (!invoice.number.trim()) problems.push("the invoice has no number");
  // `Math.abs(x - NaN) > 0.005` is false: an amount that could not be read used to switch the comparison off (audit r4 item 20).
  if (!Number.isFinite(request.amount) || request.amount <= 0) problems.push("the amount in the request is not a usable number, so the invoice's amount cannot be compared with it");
  if (!Number.isFinite(invoice.amount) || invoice.amount <= 0) problems.push("the invoice has no amount");
  else if (Number.isFinite(request.amount) && request.amount > 0 && Math.abs(invoice.amount - request.amount) > 0.005) problems.push(`the amount in the invoice is ${invoice.amount}, the request says ${request.amount}`);
  if (!invoice.client_name.trim()) problems.push("the invoice names no client");
  if (!validInn(invoice.client_inn)) problems.push(`the client's INN "${invoice.client_inn}" is not a valid INN`);
  else if (request.inn && digits(request.inn) !== digits(invoice.client_inn)) problems.push(`the client's INN in the invoice is ${invoice.client_inn}, the request says ${request.inn}`);
  if (invoice.payee_inn && !validInn(invoice.payee_inn)) problems.push(`the payee's INN "${invoice.payee_inn}" is not a valid INN`);
  if (!/^04\d{7}$/.test(digits(invoice.pay_bik))) problems.push(`the BIK "${invoice.pay_bik}" is not a Russian BIK (9 digits, starts with 04)`);
  else {
    if (!validAccount(digits(invoice.pay_bik), digits(invoice.pay_account))) problems.push(`the payment account "${invoice.pay_account}" does not fit the BIK (20 digits with a control digit)`);
    if (!validCorrAccount(digits(invoice.pay_bik), digits(invoice.pay_corr_account))) problems.push(`the correspondent account "${invoice.pay_corr_account}" does not fit the BIK`);
  }
  return problems;
}

const LEGAL_FORMS = new Set(["ооо", "оао", "зао", "пао", "ао", "ип", "llc", "ltd", "inc", "общество", "ограниченной", "ответственностью", "индивидуальный", "предприниматель"]);
const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2 && !LEGAL_FORMS.has(word)));
/** The share of the shorter text's words that the other has. */
export function overlap(a: string, b: string): number {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** The verdict: `match` (everything agrees), `mismatch` (a hard check failed) or `unsure` (the words alone cannot tell). */
export function invoiceVerdict(input: InvoiceCheckInput): InvoiceCheckDecision {
  const hard = hardProblems(input);
  if (hard.length) return { verdict: "mismatch", reasons: hard };
  const company = overlap(input.request.company, input.invoice.client_name), service = overlap(input.request.service, input.invoice.service);
  if (company >= 0.6 && service >= 0.5) return { verdict: "match", reasons: [`amount, INN and bank details are in order; the names share ${Math.round(company * 100)}% and the service lines ${Math.round(service * 100)}% of their words`] };
  return { verdict: "unsure", reasons: ["amount, INN and bank details are in order; the client name or the service line cannot be compared by words alone"] };
}
