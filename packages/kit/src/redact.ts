/**
 * Masks the secret values Lane Pilot hands to a check, a browser check or an errand (Env Catalog, J3). The values are
 * known to the server only because it fetched them, so the masking is by value, not by guess: every place that stores
 * or forwards what such a run printed (check output, receipts, retry briefs, PM messages, triage, plugin logs) passes
 * it through here first. The mask is `***`.
 */
export const MASK = "***";
/** A value shorter than this is not masked: «1» or «ok» would eat the text around it, and no key is that short. */
export const MIN_SECRET_LENGTH = 4;
const MAX_KNOWN = 2000;

const escapeRegExp = (text:string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The forms a value takes when a program prints it: as is, JSON-escaped, URL-encoded, base64, and each line of a multi-line key. */
export function secretNeedles(values:Iterable<string>):string[] {
  const needles = new Set<string>();
  const add = (text:string) => { if (text.length >= MIN_SECRET_LENGTH) needles.add(text); };
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) continue;
    add(value);
    add(JSON.stringify(value).slice(1, -1));
    try { add(encodeURIComponent(value)); } catch { /* lone surrogate: no URL form */ }
    const bytes = Buffer.from(value, "utf8");
    add(bytes.toString("base64"));
    add(bytes.toString("base64").replace(/=+$/, ""));
    add(bytes.toString("base64url"));
    if (/[\r\n]/.test(value)) {
      add(value.replace(/\r?\n/g, ""));
      for (const line of value.split(/\r?\n/)) if (line.trim().length >= 8) add(line.trim());
    }
  }
  return [...needles].sort((a, b) => b.length - a.length);
}

function compile(needles:readonly string[]):RegExp | null {
  return needles.length ? new RegExp(needles.map(escapeRegExp).join("|"), "g") : null;
}

/** The text with every given secret value replaced by `***`. */
export function redactSecrets(text:string, values:Iterable<string>):string {
  const pattern = compile(secretNeedles(values));
  return pattern && text ? text.replace(pattern, MASK) : text;
}

/** The strings of an Env Catalog record that are secret: a plain value, a password, a private key and its passphrase. */
export function secretStrings(record:{ value?:unknown; access?:unknown } | null | undefined):string[] {
  if (!record) return [];
  const out:string[] = [];
  if (typeof record.value === "string") out.push(record.value);
  const access = record.access;
  if (access && typeof access === "object") {
    for (const key of ["password", "privateKey", "passphrase"]) {
      const field = (access as Record<string, unknown>)[key];
      if (typeof field === "string") out.push(field);
    }
  }
  return out;
}

// Every secret this process fetched, kept for the sinks that cannot know which run a text belongs to. Memory only.
const known = new Set<string>();
let knownPattern:RegExp | null = null;
let knownDirty = false;

/** Remembers values the server handed out, so `redactKnown` masks them wherever they turn up. */
export function registerSecrets(values:Iterable<string>):void {
  for (const value of values) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH || known.has(value)) continue;
    known.add(value);
    knownDirty = true;
    if (known.size > MAX_KNOWN) { known.delete(known.values().next().value as string); }
  }
}

/** For tests: forgets every remembered value. */
export function forgetSecrets():void { known.clear(); knownPattern = null; knownDirty = false; }

export function knownSecretCount():number { return known.size; }

/** The text with every remembered secret masked; a no-op while nothing has been handed out. */
export function redactKnown(text:string):string {
  if (!known.size || !text) return text;
  if (knownDirty) { knownPattern = compile(secretNeedles(known)); knownDirty = false; }
  return knownPattern ? text.replace(knownPattern, MASK) : text;
}

/** A JSON-like value with remembered secrets masked inside every string (keys are left alone). */
export function redactKnownDeep<T>(value:T):T {
  if (!known.size) return value;
  if (typeof value === "string") return redactKnown(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactKnownDeep(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactKnownDeep(item)])) as T;
  }
  return value;
}

/** What a hidden credential reads as: the helpers see that there is one and where it lives, never the value. */
export const CREDENTIAL_MASK = "[password hidden: it is in the owner's message; the PM keeps it in Env Catalog]";
// A value: no spaces, 4+ characters, at least one Latin letter or digit (so «пароль такой же» is left alone), not a link.
const VALUE = String.raw`(?!https?:\/\/)(?=[^\s]*[A-Za-z0-9])[^\s]{4,}`;
// A word that only means a secret inside its value («secret plan», «pass this on») needs a separator or a credential-shaped token;
// the unambiguous keywords («пароль», «token») take the loose space form as before.
const CRED_TOKEN = String.raw`(?=[^\s]*(?:[\d_]|[^\s\w]))` + VALUE.replace("{4,}", "{4,}");
const KEYED = new RegExp(String.raw`((?:парол[ьяюе]|password|passwd|токен|token|api[ _-]?key)\s*(?:[:=—–-]\s*|\s+)|(?:pwd|pass|secret|секрет)\s*[:=—–-]\s*|(?:pwd|pass|secret|секрет)\s+(?=` + CRED_TOKEN + `))(` + VALUE + ")", "giu");
// The value after an email is separated by at least one space or punctuation mark (or the email's own tail becomes the
// «value»), and the token itself carries a letter plus a digit or non-word mark — a plain word is not a credential.
const AFTER_EMAIL = new RegExp(String.raw`([\w.+-]+@[\w-]+(?:\.[\w-]+)+)(\s*[:/|,;]+\s*|\s+)(?=[^\s]*[A-Za-z])(?=[^\s]*(?:[\d_]|[^\s\w]))(` + VALUE.replace("{4,}", "{6,}") + ")", "gu");

/**
 * The one credential table every outward writer shares (SMA k_lib_secretsmask): private-key blocks, well-known token
 * shapes, JWTs, Bearer tokens and keyed assignments — including Russian «пароль»/«токен» and UPPER_KEY forms.
 * A rule's mask keeps the part that names what was hidden (the keyword, the email login, the Bearer scheme).
 */
type CredentialRule = { pattern: RegExp; reason: string; mask: (m: RegExpExecArray | string[], mask: string) => string };
const CREDENTIAL_TABLE: CredentialRule[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, reason: "a private key", mask: (_m, mask) => mask },
  { pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, reason: "an API key", mask: (_m, mask) => mask },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, reason: "an API key", mask: (_m, mask) => mask },
  { pattern: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, reason: "a credential", mask: (m, mask) => `${m[1]}${mask}` },
  { pattern: /\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY)\s*[=:]\s*)\S+/g, reason: "a credential assignment", mask: (m, mask) => `${m[1]}${mask}` },
  { pattern: KEYED, reason: "a credential assignment", mask: (m, mask) => `${m[1]}${mask}` },
  { pattern: AFTER_EMAIL, reason: "a credential", mask: (m, mask) => `${m[1]}${m[2] || " "}${mask}` },
];

/** Why a text may not be written outward: what the credential table saw, or null. */
export function credentialIssue(text:string):string | null {
  for (const rule of CREDENTIAL_TABLE) { rule.pattern.lastIndex = 0; if (rule.pattern.test(text)) return rule.reason; }
  return null;
}

/** The one mask: every table hit becomes `mask`, plus every secret the server fetched (redactKnown). */
export function maskCredentials(text:string, mask:string = MASK):{ text:string; masked:boolean } {
  let out = text; let masked = false;
  for (const rule of CREDENTIAL_TABLE) {
    out = out.replace(rule.pattern, (...args) => { masked = true; return rule.mask(args as unknown as RegExpExecArray, mask); });
  }
  const known = redactKnown(out);
  if (known !== out) { out = known; masked = true; }
  return { text: out, masked };
}

/**
 * The owner's request without the credentials typed into it: the shared credential table with the long mask that
 * points at the owner's message. A phase stored the magicseo ТЗ verbatim, so its password went into BOOK.md,
 * CONTEXT.md and SECURITY.md in the repository and into the first commit (replay 2026-10-31), and to every helper's
 * prompt. The email stays: it names the login.
 */
export function withoutCredentials(text:string):string {
  // Idempotent: a mask already in the text is kept as it is (a phase is cleaned when stored and again when read).
  return text.split(CREDENTIAL_MASK).map((part) => maskCredentials(part, CREDENTIAL_MASK).text).join(CREDENTIAL_MASK);
}

/** Text without Lane Pilot's `[lane-pilot-selection:<uuid>]` markers: the token a session start carries is never part of a goal or a phase. */
export const withoutSelectionMarkers = (text: string): string => text.replace(/\[lane-pilot-selection:[0-9a-f-]{36}\]\s*/g, "").trim();
