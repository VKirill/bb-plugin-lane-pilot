import { filterOwnershipNoise } from "@lane-pilot/settings-catalog";
import { findUnownedChanges } from "../verification";
import { addedLineNumbers, changedRanges, linesOf } from "./linediff";
import {
  DEFECT_CLASSES, EXPECTED_CATCHERS, defectId,
  type DefectClass, type FileChange, type PlanFactClaim, type PlantInput, type Planted,
} from "./types";

/**
 * The planted defects: deterministic mutators over a real accepted candidate. The same candidate always gives the same defects (the middle
 * match of a class is taken, never a random one), so a scorecard can be compared with the one before it. A mutator that finds nothing to
 * mutate in this candidate returns null: the class is not planted there, and the scorecard counts it as «not applicable», not as a miss.
 */
export const TEST_PATH = /(^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[A-Za-z]+$|(^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/;
const CODE_PATH = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py|go|rb|php|java|kt|swift|rs)$/;
const JS_PATH = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue)$/;
const PY_PATH = /\.py$/;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);
const isCodeChange = (change: FileChange): boolean => change.after !== null && CODE_PATH.test(change.path) && !isTestPath(change.path);

const middle = <T>(items: readonly T[]): T | undefined => items[Math.floor((items.length - 1) / 2)];
const balanced = (text: string): boolean => {
  let round = 0, square = 0, curly = 0;
  for (const ch of text) { if (ch === "(") round++; else if (ch === ")") round--; else if (ch === "[") square++; else if (ch === "]") square--; else if (ch === "{") curly++; else if (ch === "}") curly--; }
  return round === 0 && square === 0 && curly === 0;
};

type Located = { change: FileChange; at: number; line: number; text: string };

/** The added lines of the changes that pass `keep`, in path and line order. */
function addedLines(changes: readonly FileChange[], keep: (change: FileChange) => boolean): Located[] {
  const out: Located[] = [];
  for (const [at, change] of changes.map((item, index) => [index, item] as const).sort((x, y) => (x[1].path < y[1].path ? -1 : 1))) {
    if (change.after === null || !keep(change)) continue;
    const lines = linesOf(change.after);
    for (const line of addedLineNumbers(change.before, change.after)) out.push({ change, at, line, text: lines[line - 1] ?? "" });
  }
  return out;
}

/** The text of `after` with one line replaced (or removed when `next` is null); the final newline is kept. */
function withLine(after: string, line: number, next: string | null): string {
  const lines = after.split("\n");
  if (next === null) lines.splice(line - 1, 1); else lines[line - 1] = next;
  return lines.join("\n");
}

function replaced(changes: readonly FileChange[], at: number, after: string): FileChange[] {
  return changes.map((change, index) => (index === at ? { ...change, after } : change));
}

/** The writer's honest table: every acceptance item cites the lines of one changed file, the code files first. */
export function honestClaim(input: Pick<PlantInput, "contract" | "changes">): PlanFactClaim {
  const live = input.changes.filter((change) => change.after !== null && change.after !== change.before);
  const pool = [...live.filter(isCodeChange), ...live.filter((change) => !isCodeChange(change))];
  if (!pool.length) return { rows: [] };
  return {
    rows: input.contract.acceptance.map((_, index) => {
      const change = pool[index % pool.length]!;
      const [first] = changedRanges(change.before, change.after!);
      return { item: index + 1, evidence: [first ? `${change.path}:${first[0]}-${first[1]}` : change.path] };
    }),
  };
}

type Mutation = { changes: FileChange[]; contract?: PlantInput["contract"]; path: string | null; line: number | null; summary: string };
type Mutator = (input: PlantInput) => Mutation | null;

const ASSERTION = /^\s*(?:await\s+)?(?:expect\(|assert(?:[.(]|[A-Z]\w*\()|self\.assert\w*\(|t\.(?:is|true|false|deepEqual|equal|truthy|falsy)\()/;
const PY_ASSERT = /^\s*assert\s+\S/;

const deletedAssertion: Mutator = ({ changes }) => {
  const found = middle(addedLines(changes, (change) => isTestPath(change.path))
    .filter((row) => (ASSERTION.test(row.text) || PY_ASSERT.test(row.text)) && balanced(row.text) && !/[,(\\]\s*$/.test(row.text) && !/^\s*assert\s*$/.test(row.text)));
  if (!found) return null;
  return { changes: replaced(changes, found.at, withLine(found.change.after!, found.line, null)), path: found.change.path, line: found.line, summary: `deleted the assertion «${found.text.trim().slice(0, 80)}»` };
};

const COMPARISONS: Array<[RegExp, string]> = [
  [/(\w|\))(\s*)<=(\s*)(\w|\()/, "$1$2<$3$4"],
  [/(\w|\))(\s*)>=(\s*)(\w|\()/, "$1$2>$3$4"],
  [/(\w|\))(\s+)<(\s+)(\w|\()/, "$1$2<=$3$4"],
  [/(\w|\))(\s+)>(\s+)(\w|\()/, "$1$2>=$3$4"],
];
const COMMENT_OR_IMPORT = /^\s*(?:\/\/|#|\*|\/\*|import\b|export\s+\*|from\b)/;

const offByOne: Mutator = ({ changes }) => {
  const rows = addedLines(changes, isCodeChange).filter((row) => !COMMENT_OR_IMPORT.test(row.text) && !/=>|->|<\w+>/.test(row.text));
  const candidates = rows.flatMap((row) => {
    for (const [pattern, to] of COMPARISONS) if (pattern.test(row.text)) return [{ row, text: row.text.replace(pattern, to) }];
    const length = /\b(length|size|count)(\s*)-(\s*)1\b/.exec(row.text);
    return length ? [{ row, text: row.text.replace(/\b(length|size|count)(\s*)-(\s*)1\b/, "$1$2-$3 0") }] : [];
  });
  const found = middle(candidates);
  if (!found) return null;
  const { row, text } = found;
  return { changes: replaced(changes, row.at, withLine(row.change.after!, row.line, text)), path: row.change.path, line: row.line, summary: `shifted a boundary: «${row.text.trim().slice(0, 60)}» became «${text.trim().slice(0, 60)}»` };
};

const OUTSIDE_NAMES = ["lp-planted-unowned.txt", "lp-planted/unowned.txt", "notes/lp-planted-unowned.md"];

const outsideOwns: Mutator = ({ contract, changes }) => {
  const task = { project_cwd: contract.project_cwd, owns_paths: contract.owns_paths, never_touch: contract.never_touch, verification: contract.verification.map((check) => ({ cwd: check.cwd })) };
  const name = OUTSIDE_NAMES.find((path) => !changes.some((change) => change.path === path) && filterOwnershipNoise([path]).length === 1 && findUnownedChanges([path], task).length === 1);
  if (!name) return null;
  return { changes: [...changes, { path: name, before: null, after: "planted: a change outside owns_paths\n" }], path: name, line: 1, summary: `changed ${name}, which owns_paths does not cover` };
};

const AWAIT_CALL = /^(\s*)(await\s+[\w.$]+\(.*\));(\s*)$/;
const THROW = /^(\s*)throw\s+(.+?);?\s*$/;
const RAISE = /^(\s*)raise\b.*$/;

const swallowedError: Mutator = ({ changes }) => {
  const rows = addedLines(changes, (change) => isCodeChange(change) && (JS_PATH.test(change.path) || PY_PATH.test(change.path)));
  const candidates = rows.flatMap((row) => {
    const js = JS_PATH.test(row.change.path);
    const awaited = js ? AWAIT_CALL.exec(row.text) : null;
    if (awaited && balanced(awaited[2]!)) return [{ row, text: `${awaited[1]}${awaited[2]}.catch(() => undefined);${awaited[3]}`, what: "the awaited call's rejection is swallowed" }];
    const thrown = js ? THROW.exec(row.text) : null;
    if (thrown && balanced(thrown[2]!)) return [{ row, text: `${thrown[1]}console.warn(${thrown[2]});`, what: "a thrown error is only logged" }];
    if (!js && RAISE.test(row.text) && balanced(row.text)) return [{ row, text: row.text.replace(/\S.*$/, "pass"), what: "a raised error is dropped" }];
    return [];
  });
  const found = middle(candidates);
  if (!found) return null;
  return { changes: replaced(changes, found.row.at, withLine(found.row.change.after!, found.row.line, found.text)), path: found.row.change.path, line: found.row.line, summary: found.what };
};

const maskedCheck: Mutator = ({ contract, changes }) => {
  const index = contract.verification.findIndex((check) => !/\|\|\s*true\s*$/.test(check.command));
  if (index < 0) return null;
  const command = `${contract.verification[index]!.command} || true`;
  return {
    changes: [...changes], path: null, line: null, summary: `verification[${index}] ends in «|| true»`,
    contract: { ...contract, verification: contract.verification.map((check, at) => (at === index ? { ...check, command } : check)) },
  };
};

const acceptanceMissing: Mutator = (input) => {
  const claim = honestClaim(input);
  const cited = new Set(claim.rows.flatMap((row) => row.evidence.map((entry) => entry.replace(/:\d+(?:-\d+)?$/, ""))));
  const target = middle(input.changes.filter((change) => isCodeChange(change) && change.after !== change.before && cited.has(change.path)));
  if (!target) return null;
  const items = claim.rows.filter((row) => row.evidence.some((entry) => entry.startsWith(`${target.path}:`) || entry === target.path)).map((row) => row.item);
  const rest = input.changes.flatMap((change) => (change !== target ? [change] : change.before === null ? [] : [{ ...change, after: change.before }]));
  return { changes: rest, path: target.path, line: null, summary: `the work for acceptance item ${items.join(", ")} (${target.path}) is not in the diff, the table still claims it` };
};

const LITERAL = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false)`;
const EXPECTED = [new RegExp(String.raw`\.(?:toBe|toEqual|toStrictEqual)\(\s*${LITERAL}\s*\)`, "g"), new RegExp(String.raw`assert\w*(?:\.\w+)?\(.*,\s*${LITERAL}\s*\);?\s*$`, "gm"), new RegExp(String.raw`assert\s+\S.*==\s*${LITERAL}\s*$`, "gm")];
const RETURN_EXPR = /^(\s*)return\s+(.+?)\s*(;?)\s*$/;
const BARE_LITERAL = /^(?:["'`].*["'`]|-?\d[\d.]*|true|false|null|undefined|\[\]|\{\})$/;

const hardcodedValue: Mutator = ({ changes }) => {
  const literals: string[] = [];
  for (const change of changes) if (change.after !== null && isTestPath(change.path)) for (const pattern of EXPECTED) for (const hit of change.after.matchAll(pattern)) literals.push(hit[1]!);
  const literal = literals.find((item) => !["0", "1", "true", "false"].includes(item)) ?? literals[0];
  if (!literal) return null;
  const candidates = addedLines(changes, isCodeChange).flatMap((row) => {
    const match = RETURN_EXPR.exec(row.text);
    if (!match || BARE_LITERAL.test(match[2]!) || !balanced(match[2]!) || /[,({\[]$/.test(match[2]!)) return [];
    return [{ row, text: `${match[1]}return ${literal}${match[3]}` }];
  });
  const found = middle(candidates);
  if (!found) return null;
  return { changes: replaced(changes, found.row.at, withLine(found.row.change.after!, found.row.line, found.text)), path: found.row.change.path, line: found.row.line, summary: `«${found.row.text.trim().slice(0, 60)}» returns the constant ${literal} the tests expect` };
};

const JS_IMPORT = /^(\s*(?:import|export)\b[^'"]*?\bfrom\s+)(['"])(\.{1,2}\/[^'"]+)\2/;
const JS_REQUIRE = /require\((['"])(\.{1,2}\/[^'"]+)\1\)/;
const PY_IMPORT = /^(\s*from\s+)(\.?[A-Za-z_][\w.]*)(\s+import\b)/;

const brokenImport: Mutator = ({ changes }) => {
  const importTexts = (row: { text: string; change: FileChange }): string | null => {
    if (JS_PATH.test(row.change.path)) {
      const from = JS_IMPORT.exec(row.text);
      if (from) return row.text.replace(JS_IMPORT, `$1$2$3-planted$2`);
      return JS_REQUIRE.test(row.text) ? row.text.replace(JS_REQUIRE, "require($1$2-planted$1)") : null;
    }
    return PY_PATH.test(row.change.path) && PY_IMPORT.test(row.text) ? row.text.replace(PY_IMPORT, "$1$2_planted$3") : null;
  };
  const pick = (rows: Located[]) => middle(rows.flatMap((row) => { const text = importTexts(row); return text ? [{ row, text }] : []; }));
  let found = pick(addedLines(changes, (change) => isCodeChange(change)));
  if (!found) {
    // No added import: any import line of a changed code file breaks the same way.
    const every: Located[] = [];
    for (const [at, change] of changes.entries()) if (isCodeChange(change)) linesOf(change.after!).forEach((text, index) => every.push({ change, at, line: index + 1, text }));
    found = pick(every);
  }
  if (!found) return null;
  return { changes: replaced(changes, found.row.at, withLine(found.row.change.after!, found.row.line, found.text)), path: found.row.change.path, line: found.row.line, summary: `the import «${found.row.text.trim().slice(0, 70)}» points at a module that does not exist` };
};

const MUTATORS: Readonly<Record<DefectClass, Mutator>> = {
  test_assertion_deleted: deletedAssertion, off_by_one: offByOne, outside_owns: outsideOwns, swallowed_error: swallowedError,
  masked_check: maskedCheck, acceptance_missing: acceptanceMissing, hardcoded_value: hardcodedValue, broken_import: brokenImport,
};

/** The candidate with one defect of this class, or null when the class has nothing to mutate in it. */
export function plantDefect(input: PlantInput, defectClass: DefectClass): Planted | null {
  const mutation = MUTATORS[defectClass](input);
  if (!mutation) return null;
  const changed = JSON.stringify(mutation.changes) !== JSON.stringify(input.changes) || mutation.contract !== undefined;
  if (!changed) return null;
  return {
    defect: { id: defectId(input.taskId, defectClass), class: defectClass, taskId: input.taskId, path: mutation.path, line: mutation.line, summary: mutation.summary, expected: EXPECTED_CATCHERS[defectClass] },
    contract: mutation.contract ?? input.contract,
    changes: mutation.changes,
    claim: honestClaim(input),
  };
}

/** Every defect the candidate can carry, one per class, in class order. */
export function plantAll(input: PlantInput, classes: readonly DefectClass[] = DEFECT_CLASSES): Planted[] {
  return classes.flatMap((defectClass) => { const planted = plantDefect(input, defectClass); return planted ? [planted] : []; });
}
