import { validInn } from "@lane-pilot/jev/judgments/invoice-check";

/**
 * Personal data masked in a message before any of it is sent to Jev (audit 2026-10-08 round 4, item 19, F-5). The word filter
 * (`sensitiveReason`) holds back messages about health, money or family; it never saw an e-mail, a phone, a card or an address.
 * Here the numbers and addresses themselves are replaced by a tag (`[email]`, `[phone]`, `[card]`, `[iban]`, `[account]`,
 * `[inn]`, `[snils]`, `[passport]`, `[address]`), so the model reads the sentence and never the value.
 *
 * It errs towards masking: a tag in a sentence costs a little of the model's reading, a leaked number costs the owner. A number is
 * masked as a card only when it passes the Luhn check, as an IBAN only when the IBAN check sum holds, as an INN without its keyword
 * only when the INN check digits hold, so the dates, versions, amounts and ticket numbers of ordinary text are left as they are.
 */
export type PiiKind = "email" | "iban" | "card" | "account" | "snils" | "passport" | "inn" | "phone" | "address";
export type Masked = { text: string; count: number; kinds: PiiKind[] };

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
};

const ibanValid = (raw: string): boolean => {
  const iban = raw.replace(/\s+/g, "");
  if (iban.length < 15 || iban.length > 34) return false;
  let rest = 0;
  for (const char of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const value = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
};

const STREET_WORD = "(?:ул(?:ица)?|пр(?:-т|-кт|оспект)?|пер(?:еулок)?|б-р|бульвар|ш(?:оссе)?|наб(?:ережная)?|пл(?:ощадь)?)";
const UNIT_WORD = "(?:кв(?:артира)?|оф(?:ис)?|эт(?:аж)?|корп(?:ус)?|стр(?:оение)?)";
const EN_STREET = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)";

export function maskPii(input: string): Masked {
  let text = input;
  const found: PiiKind[] = [];
  const apply = (kind: PiiKind, pattern: RegExp, replace: string | ((match: string, ...groups: string[]) => string)) => {
    text = text.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const next = typeof replace === "string" ? replace.replace(/\$(\d)/g, (_, index: string) => groups[Number(index) - 1] ?? "") : replace(match, ...groups);
      if (next !== match) found.push(kind);
      return next;
    });
  };

  apply("email", /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu, "[email]");
  apply("iban", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b/g, (match) => (ibanValid(match) ? "[iban]" : match));
  apply("card", /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g, (match) => (luhn(match.replace(/\D/g, "")) ? "[card]" : match));
  apply("account", /(?<!\d)\d{20}(?!\d)/g, "[account]");
  apply("snils", /(?<!\d)\d{3}-\d{3}-\d{3}[ -]\d{2}(?!\d)/g, "[snils]");
  apply("snils", /((?:снилс|snils)[\s:№#-]*)\d{3}[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{2}(?!\d)/giu, "$1[snils]");
  apply("passport", /((?:паспорт\p{L}*|passport)[^\d\n]{0,25})\d{2}\s?\d{2}\s?\d{6}(?!\d)/giu, "$1[passport]");
  apply("passport", /(?<!\d)\d{2} \d{2} \d{6}(?!\d)/g, "[passport]");
  apply("inn", /((?:инн|inn)[\s:№#-]*)(?:\d{12}|\d{10})(?!\d)/giu, "$1[inn]");
  apply("inn", /(?<![\d.])(?:\d{12}|\d{10})(?![\d.])/g, (match) => (validInn(match) ? "[inn]" : match));
  apply("phone", /(?<![\w+])(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}(?!\d)/g, "[phone]");
  apply("phone", /(?<![\w+])\+\d{1,3}[\s().-]*\d{2,4}(?:[\s.-]*\d{2,4}){2,3}(?!\d)/g, "[phone]");
  apply("phone", /(?<![\d.])9\d{9}(?![\d.])/g, "[phone]");
  apply("address", new RegExp(`(?<![\\p{L}])${STREET_WORD}\\.?\\s+\\p{L}[\\p{L}.\\- ]{0,40}?[,\\s]+(?:д(?:ом)?\\.?\\s*)?\\d+(?:\\s*[\\p{L}/-]\\s*\\d+|\\p{L})?(?:[,\\s]+${UNIT_WORD}\\.?\\s*\\d+)*`, "giu"), "[address]");
  apply("address", new RegExp(`(?<![\\p{L}])${UNIT_WORD}\\.?\\s*\\d+`, "giu"), "[address]");
  apply("address", new RegExp(`\\b\\d{1,5}\\s+(?:[A-Z][a-z]+\\s+){1,3}${EN_STREET}\\b\\.?`, "g"), "[address]");
  apply("address", new RegExp(`\\b(?:[A-Z][a-z]+\\s+){1,3}${EN_STREET}\\s+\\d{1,5}\\b`, "g"), "[address]");

  return { text, count: found.length, kinds: [...new Set(found)] };
}
