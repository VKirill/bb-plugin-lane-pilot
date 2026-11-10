/**
 * Guard tools (SMA map: Guard tools): checks that run in tests and before publishing.
 * - Leak scanner: no secret-shaped string in what ships (dist, docs, i18n texts).
 * - Internal ids forbidden: a text a person reads (i18n strings) carries no internal id (lpattempt_…, lprun_…, thr_…, s123).
 * - Explained unshown fields: an RPC field the screens do not show is named with why (the register below).
 * - Permission rules parity and session/terminal parity: the PM's tool allow-list is the same in a BB session and in a terminal session.
 */
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{24,}/, /\bxox[abpr]-[A-Za-z0-9-]{12,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/];

/** Leak scanner: the secret-shaped strings of a text, each with its line number. */
export function leaks(text: string): Array<{ line: number; shape: string }> {
  const out: Array<{ line: number; shape: string }> = [];
  text.split("\n").forEach((line, index) => {
    for (const shape of SECRET_SHAPES) if (shape.test(line)) out.push({ line: index + 1, shape: shape.source.slice(0, 24) });
  });
  return out;
}

export const INTERNAL_ID = /\b(lpattempt_[0-9a-f]{8,}|lprun_[0-9a-f]{8,}|thr_[a-z0-9]{8,}|proj_[a-z0-9]{8,}|host_[a-z0-9]{8,})\b/;
/** Internal ids forbidden: the strings of a catalog a person reads that carry an internal id (placeholders like {taskId} are fine). */
export function internalIds(strings: Readonly<Record<string, string>>): string[] {
  return Object.entries(strings).filter(([, value]) => INTERNAL_ID.test(value)).map(([key]) => key);
}

/** Explained unshown fields: RPC answer fields no screen shows, and why each is there. */
export const UNSHOWN_FIELDS: Readonly<Record<string, string>> = {
  "canary_status.samples": "for the CLI (scripts/lp-canary.sh) and the PM alert, not for a screen",
  "phase_get.facts": "the raw facts of the pieces for the CLI and the PM; the screen shows the book and the lines",
  "world_version.version": "polled by screens to know when to read the board again; never shown itself",
  "money_status.series": "the 14-day series feeds the chart; the numbers are not listed",
};

/** Permission rules parity (SMA: Permission rules parity, Session and terminal parity): the tools one place allows and the other does not. */
export function parityGaps(session: readonly string[], terminal: readonly string[]): { onlySession: string[]; onlyTerminal: string[] } {
  const a = new Set(session), b = new Set(terminal);
  return { onlySession: [...a].filter((tool) => !b.has(tool)).sort(), onlyTerminal: [...b].filter((tool) => !a.has(tool)).sort() };
}

/** House words, old brand names, hard-coded colours and internal ids forbidden in the texts a person reads, comments and tests. */
export const FORBIDDEN_WORDS: ReadonlyArray<{ shape: RegExp; reason: string }> = [
  { shape: /Claude Lane/, reason: "the old harness brand; the product a person reads about is Lane Pilot" },
];
const COLOUR_LITERAL = /#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i;

/** The lines of a text file (comments, docs, tests) carrying a house word or a colour literal — the shapes that are never a legitimate word. */
export function sourceWordHits(path: string, text: string): string[] {
  return text.split("\n").flatMap((line, index) => FORBIDDEN_WORDS.some(({ shape }) => shape.test(line)) ? [`${path}:${index + 1}`] : []);
}

/** The strings of a catalog a person reads that carry a house word, an old brand, a colour literal or an internal id. */
export function houseWordHits(strings: Readonly<Record<string, string>>): string[] {
  return Object.entries(strings)
    .filter(([, value]) => FORBIDDEN_WORDS.some(({ shape }) => shape.test(value)) || COLOUR_LITERAL.test(value) || INTERNAL_ID.test(value))
    .map(([key]) => key);
}

/**
 * Window contract is read (SMA map: Window contract is read): every top-level field of a zod-object output is either named in a
 * ui source (as `.field`, `field:` or a destructured `field`) or explained as `method.field` in `explained` (UNSHOWN_FIELDS).
 * Outputs that are `z.unknown()` or not plain objects report nothing — the baseline below carries today's unread fields.
 */
export function unreadFields(contract: Readonly<Record<string, { output: unknown }>>, uiSources: ReadonlyArray<{ path: string; text: string }>, explained: Readonly<Record<string, string>>): string[] {
  const unread: string[] = [];
  for (const [method, op] of Object.entries(contract)) {
    const def = (op.output as { _def?: { type?: string; typeName?: string; shape?: Record<string, unknown> | (() => Record<string, unknown>) } })?._def;
    const fields = typeof def?.shape === "function" ? def.shape() : def?.shape;
    if ((def?.typeName !== "ZodObject" && def?.type !== "object") || !fields) continue;
    for (const field of Object.keys(fields)) {
      if (explained[`${method}.${field}`] !== undefined) continue;
      const read = uiSources.some(({ text }) => new RegExp(`[.\\s,{]${field}\\b`).test(text) || new RegExp(`\\b${field}\\s*:`).test(text));
      if (!read) unread.push(`${method}.${field}`);
    }
  }
  return unread.sort();
}
