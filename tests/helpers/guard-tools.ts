/**
 * Guard tools (SMA map: Guard tools): checks that run in tests and before publishing.
 * - Leak scanner: no secret-shaped string in what ships (dist, docs, i18n texts).
 * - Internal ids forbidden: a text a person reads (i18n strings) carries no internal id (lpattempt_…, lprun_…, thr_…, s123).
 * - Explained unshown fields: an RPC field the screens do not show is named with why (the register below).
 * - Permission rules parity and session/terminal parity: the PM's tool allow-list is the same in a BB session and in a terminal session.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{24,}/, /\bxox[abpr]-[A-Za-z0-9-]{12,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/];

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path]; });

/** The walk-and-scan the test run and the publish gate share (SMA m_tl_rebrand_wired): every leak hit under the
 * shipped sources as `path:line`. The same list fails `npx vitest` and `lp-ship.ts publishable`. */
export function leakFindings(root: string): string[] {
  const dirs = ["src", "docs", "packages/i18n/src"].map((dir) => join(root, dir)).filter(existsSync);
  const files = dirs.flatMap(walk).filter((path) => /\.(ts|tsx|md|json)$/.test(path) && !path.includes("guard-tools"));
  return files.flatMap((path) => leaks(readFileSync(path, "utf8")).map((hit) => `${relative(root, path)}:${hit.line}`));
}

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
  "session_memory_search.weakMatch": "read by the terminal session client (lane-memory search), which prints the message above the notes; no screen shows a memory search",
  "canary_status.samples": "for the CLI (scripts/lp-canary.sh) and the PM alert, not for a screen",
  "phase_get.facts": "the raw facts of the pieces for the CLI and the PM; the screen shows the book and the lines",
  "world_version.version": "polled by screens to know when to read the board again; never shown itself",
  "money_status.series": "the 14-day series feeds the chart; the numbers are not listed",
  "work_file_read.lineStart": "the reader opens a work file from its first line and marks a cut with «…»; it has no page control to show a range in",
  "work_file_read.lineEnd": "see work_file_read.lineStart: the range of a page the reader does not turn",
  "work_file_read.totalLines": "see work_file_read.lineStart: the cut is shown as «…», not as a count",
  "work_file_read.sizeBytes": "the file's size is the server's bound on the read, not something the owner is told",
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

/** Files a tool writes: their text follows the code, so a scan of them only repeats the scan of the sources. */
export const isGeneratedFile = (path: string): boolean => /(^|\/)(docs\/atlas\.md|docs\/enabled-settings\.md|docs\/map\/|src\/rooms\/sma-map\/)/.test(path.replaceAll("\\", "/"));

/**
 * The house-word hits of a source text (comments, docs, tests): one `path|matched text` per occurrence. Only the old brand is flagged here —
 * colour literals and internal ids are checked in the catalogs a person reads (`houseWordHits`), not in the sources. Not line numbers: another
 * branch that adds a line above a baselined one must not turn the suite red.
 */
export function sourceWordHits(path: string, text: string): string[] {
  return text.split("\n").flatMap((line) => FORBIDDEN_WORDS.flatMap(({ shape }) => {
    const found = new RegExp(shape.source, `${shape.flags.replace("g", "")}g`);
    return [...line.matchAll(found)].map((hit) => `${path}|${hit[0]}`);
  }));
}

/** Baseline shape: file -> matched text -> how many occurrences are tolerated. */
export type HouseWordBaseline = Record<string, Record<string, number>>;

export function countHouseWordHits(hits: readonly string[]): HouseWordBaseline {
  const counts: HouseWordBaseline = {};
  for (const hit of hits) {
    const at = hit.indexOf("|");
    const file = hit.slice(0, at), word = hit.slice(at + 1);
    counts[file] = { ...(counts[file] ?? {}), [word]: (counts[file]?.[word] ?? 0) + 1 };
  }
  return Object.fromEntries(Object.entries(counts).sort(([x], [y]) => x.localeCompare(y)));
}

/** The occurrences beyond what the baseline tolerates, as `path|word (n over baseline m)`. */
export function freshHouseWordHits(found: HouseWordBaseline, baseline: HouseWordBaseline): string[] {
  return Object.entries(found).flatMap(([file, words]) => Object.entries(words)
    .filter(([word, count]) => count > (baseline[file]?.[word] ?? 0))
    .map(([word, count]) => `${file}|${word} (${count} found, ${baseline[file]?.[word] ?? 0} in the baseline)`));
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
