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

const INTERNAL_ID = /\b(lpattempt_[0-9a-f]{8,}|lprun_[0-9a-f]{8,}|thr_[a-z0-9]{8,}|proj_[a-z0-9]{8,}|host_[a-z0-9]{8,})\b/;
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
