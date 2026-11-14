import { isProductDecision } from "./question-default";

/**
 * What a writer's question is really about, by rule (no model). Every kind but `product` and `other` has a machine door
 * (question-rules.ts): the writer asks a person for something the contract or the sandbox settles by itself. Measured on the hub's
 * 67 questions of 30 days: tests/fixtures/hub-writer-questions-30d.json.
 */
export type QuestionClass =
  | { kind: "outside_paths"; files: string[] }
  | { kind: "required_test_change"; files: string[] }
  | { kind: "sandbox"; check: string }
  | { kind: "broken_check"; check: string }
  | { kind: "already_done" }
  | { kind: "product" }
  | { kind: "other" };

/** A path-looking token: a folder path, or a name with a letter extension. Versions («0.7.9»), hashes and prose stay out. */
const PATH_TOKEN = /(?<![\w./@-])(?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w/-])|(?<![\w./@-])(?:[\w@.-]+\/)+[\w@.-]+(?![\w-])/g;
const NOT_A_FILE = /^(?:e\.g|i\.e|etc|vs|v\d.*)\.?$|^\d|^https?:|^node_modules\/|^\/(?:bin|usr|var|tmp|Users|home)\b|\*|^[A-Z][A-Za-z]+\.[a-z]+[A-Z]|\.(?:com|org|io|dev|net|app)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/** The files a question names, in order, each once; globs, urls, absolute system paths and version numbers are left out. */
export function filesNamed(question: string): string[] {
  const seen = new Set<string>();
  for (const match of question.matchAll(PATH_TOKEN)) {
    const token = match[0].replace(/^\.\//, "").replace(/[.,;:]+$/, "");
    if (!token || NOT_A_FILE.test(token) || token.includes("...") || /\.\w+\(/.test(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

const checkOf = (question: string): string => {
  const quoted = /\bcheck\s+(`[^`]+`|'[^']+'|"[^"]+"|\S+(?:\s+\S+){0,6}?)\s+(?:cannot|can't|fails)/i.exec(question) ?? /\bverification command\s+\d+/i.exec(question);
  return (quoted?.[1] ?? quoted?.[0] ?? "").replace(/^[`'"]|[`'"]$/g, "").slice(0, 200);
};

const TEST_FIT = /\btest_fit\b|\bfit gate\b|\btest_removals\b|\bgate rejects both\b/i;
const BROKEN_CHECK = /cannot exit 0 as written|as written\b.*\bcheck|\bto the check\b|mutually destructive|No test files found|can the check be relaxed|bare filenames|verify command\b.*\bexits? 1/i;
const SANDBOX = /cannot run in the sandbox|\bENOENT\b|dubious ownership|\.nuxt\b|\bmktemp\b|Operation not permitted|exit 127|command not found|No module named|safe\.directory|circular symlinks/i;
const ALREADY_DONE = /\bnot needed because\b|already (?:exists?|contains?|finished|satisfied|done|in main|at HEAD)|\bno[- ]op\b|empty diff|diff is empty|no diff is possible|needs no change|^none\.?\s+task done|уже (?:в main|существует|выполнен)|пустой diff/i;
/** Files the live system writes while the attempt runs: not the writer's paths, a person's call on the snapshot. */
const RUNTIME_DIRT = /re-?baseline|written live|live (?:bot|deployment|production)|schedule_tick|symlink you created|\bwal\b/i;
const OUTSIDE = /outside (?:of )?(?:the )?(?:[\w.]+ )?(?:task's )?`?owns_paths|not in `?owns_paths|(?:add|include) (?:it|them|those|[^?]{0,120}) (?:to|in(?:to)?) (?:the )?(?:contract's )?`?owns_paths|(?:is|are) not in this task's owns_paths|вне `?owns_paths/i;

export function classifyQuestion(question: string): QuestionClass {
  const text = question.trim();
  if (TEST_FIT.test(text)) return { kind: "required_test_change", files: filesNamed(text).filter((file) => TEST_FILE.test(file)) };
  if (BROKEN_CHECK.test(text)) return { kind: "broken_check", check: checkOf(text) };
  if (SANDBOX.test(text)) return { kind: "sandbox", check: checkOf(text) };
  if (ALREADY_DONE.test(text)) return { kind: "already_done" };
  if (RUNTIME_DIRT.test(text)) return { kind: "other" };
  if (OUTSIDE.test(text)) return { kind: "outside_paths", files: filesNamed(text) };
  return isProductDecision(text) ? { kind: "product" } : { kind: "other" };
}
