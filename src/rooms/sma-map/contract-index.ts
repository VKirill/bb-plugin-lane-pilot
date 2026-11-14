// Builds contracts.ts (scripts/sma-contracts.mjs): for each SMA card id, the tests whose title names it ([sma:<id>]).
// Local tests are read from this checkout's tests/ and packages/*/tests; a sibling's (siblings.ts) are read from git AT A
// PINNED COMMIT and recorded with the repository prefix (`core:packages/x/y.test.ts › title`), the pin beside them in
// SMA_SIBLING_TESTS_AT. That keeps `--check` deterministic whatever branch a sibling checkout has out:
//   generate  the pin moves to the sibling's HEAD only when HEAD contains the recorded pin (a checkout without the proofs
//             branch cannot drop them); an uncommitted sibling test is invisible — commit it in the sibling first;
//   check     the sibling is re-read at the recorded pin (any worktree of that repository has the objects);
//   absent    the sibling is not on this machine, or lacks the pinned commit: its recorded lines are kept as they are and a
//             note says so (the hub runs without the siblings; the deploy gate on OVH has both and re-reads them).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { grepFilesAt, hasCommit, headOf, isAncestor, showAt } from "./sibling-git";
import { resolveSibling, SIBLING_NAMES, SIBLINGS, type SiblingName } from "./siblings";

const TITLE = /\b(?:it|test|describe)(?:\.each\([^)]*\))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const CARD = /\[sma:([a-z0-9_]+)\]/g;

/** Adds every `[sma:<id>]` title of one test file to `byCard` as `<file> › <title without the tag>`. */
export function cardsInText(text: string, file: string, byCard: Map<string, string[]>): void {
  for (const match of text.matchAll(TITLE)) {
    const title = match[2]!;
    for (const card of title.matchAll(CARD)) {
      const list = byCard.get(card[1]!) ?? [];
      list.push(`${file} › ${title.replace(/\s*\[sma:[a-z0-9_]+\]\s*/g, " ").trim()}`);
      byCard.set(card[1]!, list);
    }
  }
}

function localTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(join(root, "tests"));
  for (const pkg of readdirSync(join(root, "packages"))) { try { walk(join(root, "packages", pkg, "tests")); } catch { /* a package without tests */ } }
  return files.sort();
}

/** The `[sma:<id>]` tests of a sibling at `commit`, prefixed with its name. */
export function siblingTestsAt(name: SiblingName, root: string, commit: string): Map<string, string[]> {
  const byCard = new Map<string, string[]>();
  for (const path of grepFilesAt(root, commit, SIBLINGS[name].testGlobs, "\\[sma:[a-z0-9_]+\\]")) {
    const text = showAt(root, commit, path);
    if (text !== null) cardsInText(text, `${name}:${path}`, byCard);
  }
  return byCard;
}

export type ContractsNow = { tests: Readonly<Record<string, readonly string[]>>; at: Readonly<Partial<Record<SiblingName, string>>> };
export type BuildOptions = { root: string; check: boolean; current: ContractsNow; env?: Readonly<Record<string, string | undefined>> };

/** The recorded lines of one sibling in the current contracts.ts. */
function recorded(current: ContractsNow, name: SiblingName): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [card, lines] of Object.entries(current.tests)) {
    const mine = lines.filter((line) => line.startsWith(`${name}:`));
    if (mine.length) out.set(card, [...mine]);
  }
  return out;
}

/** One sibling's tests and pin under the rules in the header, with a note when it was not (re-)read. */
export function siblingBlock(name: SiblingName, options: BuildOptions): { tests: Map<string, string[]>; pin?: string; note?: string } {
  const pinned = options.current.at[name];
  const keep = (why: string) => ({ tests: recorded(options.current, name), ...(pinned ? { pin: pinned } : {}), note: `${why}: kept its ${[...recorded(options.current, name).values()].flat().length} recorded test(s)${pinned ? ` at ${pinned}` : ""}` });
  const at = resolveSibling(name, options.root, options.env);
  if (at.root === null) return keep(at.why);
  if (pinned && !hasCommit(at.root, pinned)) return keep(`${SIBLINGS[name].repo} at ${at.root} has no commit ${pinned}`);
  if (options.check) return pinned ? { tests: siblingTestsAt(name, at.root, pinned), pin: pinned } : { tests: new Map() };
  const head = headOf(at.root);
  if (!head) return keep(`${SIBLINGS[name].repo} at ${at.root} has no HEAD`);
  if (pinned && !isAncestor(at.root, pinned, head)) return { tests: siblingTestsAt(name, at.root, pinned), pin: pinned, note: `${SIBLINGS[name].repo} at ${at.root} (HEAD ${head}) does not contain the pinned ${pinned}: kept the pin; point ${SIBLINGS[name].env} at a checkout of ${SIBLINGS[name].proofBranch}` };
  const tests = siblingTestsAt(name, at.root, head);
  return tests.size ? { tests, pin: head } : { tests };
}

/** The text of contracts.ts and the notes about siblings that were not re-read. */
export function buildContracts(options: BuildOptions): { out: string; notes: string[]; cards: number; tests: number } {
  const byCard = new Map<string, string[]>();
  for (const file of localTestFiles(options.root)) cardsInText(readFileSync(file, "utf8"), relative(options.root, file), byCard);
  const pins: Partial<Record<SiblingName, string>> = {};
  const notes: string[] = [];
  for (const name of SIBLING_NAMES) {
    const block = siblingBlock(name, options);
    if (block.pin) pins[name] = block.pin;
    if (block.note) notes.push(block.note);
    for (const [card, lines] of block.tests) byCard.set(card, [...(byCard.get(card) ?? []), ...lines]);
  }
  const lines = [...byCard.keys()].sort().map((card) => `  ${card}: ${JSON.stringify(byCard.get(card))},`);
  const out = `// Generated by scripts/sma-contracts.mjs from the tests that name an SMA card in their title ([sma:<card id>]): the tests that
// hold Lane Pilot to that card's behaviour. Do not edit by hand; tests/sma-map.test.ts checks it is current. A sibling repository's
// tests carry its prefix (core:, telegram:) and were read at the commit in SMA_SIBLING_TESTS_AT (src/rooms/sma-map/contract-index.ts).
export const SMA_CONTRACT_TESTS: Readonly<Record<string, readonly string[]>> = {
${lines.join("\n")}
};
export const SMA_SIBLING_TESTS_AT: Readonly<Partial<Record<"core" | "telegram", string>>> = ${JSON.stringify(pins)};
`;
  return { out, notes, cards: byCard.size, tests: [...byCard.values()].reduce((n, list) => n + list.length, 0) };
}
