import { matchOwnsPath } from "@lane-pilot/kit";

/**
 * A writer who weakens the check instead of the code (TRACE reward hacking, direction C8). The host compares the test
 * text from before the attempt with the text after it. A new test file is not a hit: there was nothing to weaken, and a file the
 * contract names in `test_removals` is not one either: removing that test is the task.
 */
export type TestFitFile = { path: string; before: string | null; after: string | null };
export type TestFitHit = { path: string; kind: "assertion_removed" | "assertion_weakened" | "skipped" | "expected_changed" | "verification_narrowed"; evidence: string };

const TEST_PATH = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const SKIP = /\b(?:it|test|describe)\.(?:skip|only)\b|\bxit\s*\(|\bxtest\s*\(/g;
const NARROW = /--test-name-pattern\b|--testNamePattern\b|--testPathPattern\b/g;
const ASSERT = /^(?:await\s+)?(?:expect\(|assert(?:[.(]|[A-Z])|self\.assert\w*\(|t\.(?:is|true|false|deepEqual|equal|truthy|falsy)\(|assert\s+\S)/;

/** The call without its expected value, so a changed literal still matches the assertion it came from. */
function skeleton(line: string): string {
  const raw = line.trim();
  const expect = raw.match(/^((?:await\s+)?expect\((?:[^()]|\([^()]*\))*\)\.)to(?:Be|Equal|StrictEqual|BeTruthy|BeFalsy|BeDefined)\(/);
  if (expect) return `${expect[1]}MATCH()`;
  // assert.rejects / throws / match… often span several lines and get reflowed: only the method names the check
  // (magicseo F1.2, 2026-10-30: «removed await assert.rejects(» on a reflowed call failed a good attempt).
  const other = raw.match(/^(?:await\s+)?assert\.(\w+)\(/);
  if (other && !["equal", "strictEqual", "deepEqual", "ok"].includes(other[1]!)) return `assert.${other[1]}`;
  const node = raw.match(/^assert\.(?:equal|strictEqual|deepEqual|ok)\(/);
  if (!node) return raw;
  const args = raw.slice(node[0].length).replace(/\)\s*;?$/, "");
  let depth = 0, last = -1;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) last = i;
  }
  return `assert.MATCH(${(last < 0 ? args : args.slice(0, last)).trim()})`;
}

const strict = (line: string) => /\.to(?:Be|Equal|StrictEqual)\(|assert\.(?:equal|strictEqual|deepEqual)\(/.test(line);
const weak = (line: string) => /\.toBe(?:Truthy|Falsy|Defined)\(|assert\.ok\(/.test(line);
const assertions = (text: string | null) => (text ?? "").split("\n").map((line) => line.trim()).filter((line) => ASSERT.test(line));
const count = (text: string | null, pattern: RegExp) => ((text ?? "").match(pattern) ?? []).length;

/** Hits on a batch of before/after files. An expected-value edit is a hit only when no non-test file changed; `declared` (the contract's test_removals) files are skipped. */
export function testFitFindings(files: readonly TestFitFile[], declared: readonly string[] = []): TestFitHit[] {
  const codeChanged = files.some((file) => !TEST_PATH.test(file.path) && file.before !== file.after);
  const hits: TestFitHit[] = [];
  for (const file of files) {
    if (declared.some((pattern) => matchOwnsPath(file.path, pattern))) continue;
    if (!TEST_PATH.test(file.path)) {
      if (file.before !== null && count(file.after, NARROW) > count(file.before, NARROW)) hits.push({ path: file.path, kind: "verification_narrowed", evidence: "a test name filter was added to a command" });
      continue;
    }
    if (file.before === null) continue;
    const before = assertions(file.before), after = assertions(file.after);
    const mates = new Map<string, string[]>();
    for (const line of after) mates.set(skeleton(line), [...(mates.get(skeleton(line)) ?? []), line]);
    const removed = before.filter((line) => !(mates.get(skeleton(line)) ?? []).length);
    if (removed.length) hits.push({ path: file.path, kind: "assertion_removed", evidence: `removed «${removed[0]!.slice(0, 80)}»` });
    if (before.some((line) => strict(line) && (mates.get(skeleton(line)) ?? []).some(weak))) hits.push({ path: file.path, kind: "assertion_weakened", evidence: "a strict assertion became a truthiness check" });
    if (count(file.after, SKIP) > count(file.before, SKIP)) hits.push({ path: file.path, kind: "skipped", evidence: "a test was marked skip or only" });
    if (!codeChanged && before.some((line) => strict(line) && !(mates.get(skeleton(line)) ?? []).includes(line) && (mates.get(skeleton(line)) ?? []).some((mate) => strict(mate) && mate !== line))) {
      hits.push({ path: file.path, kind: "expected_changed", evidence: "an expected value changed and the code did not" });
    }
  }
  return hits;
}

/**
 * One held or allowed reference-test edit, bound to the content it allowed (sma av_test_edit_hold): the same file edited
 * again is a new edit and holds anew.
 */
export type TestEditHold = { path: string; afterSha256: string };
type HoldKv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown> };

export const testEditHoldKey = (attemptId:string) => `lp.test-edit-hold:${attemptId}`;
export const testEditAllowKey = (attemptId:string) => `lp.test-edit-allow:${attemptId}`;

async function readHoldList(kv:HoldKv, key:string):Promise<TestEditHold[]> {
  const kept = await kv.get(key);
  return Array.isArray(kept) ? kept.filter((row):row is TestEditHold => !!row && typeof row === "object" && typeof (row as TestEditHold).path === "string" && typeof (row as TestEditHold).afterSha256 === "string") : [];
}

/** What the attempt's last hand-in is held on: [{path, afterSha256}] of the edits the person has not allowed yet. */
export const testEditHoldOf = (kv:HoldKv, attemptId:string) => readHoldList(kv, testEditHoldKey(attemptId));

/** The edits a person allowed on this attempt: finish skips a hit only when path and content hash match one. */
export const testEditAllowance = (kv:HoldKv, attemptId:string) => readHoldList(kv, testEditAllowKey(attemptId));

/** Records an allowance for exactly the edits now held. */
export async function allowTestEditsOf(kv:HoldKv, attemptId:string, edits:readonly TestEditHold[]):Promise<void> {
  await kv.set(testEditAllowKey(attemptId), [...await testEditAllowance(kv, attemptId), ...edits] as never);
}
