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
