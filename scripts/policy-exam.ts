/**
 * Runs the night-policy exam outside BB: scores the current policy version on the committed part of the newest unseen split (exam-v2) and
 * (with --write) records the result next to the policy, policy/exam-result.json. `--hash` prints policyHash, the value `frozen_hash` must hold.
 * tests/policy/exam.test.ts fails when the record does not match the current policy and split, so a policy edited without a fresh run is caught in CI.
 * The plugin store part of exam-v2 is not visible here; `bb lane-pilot policy-exam` scores the merged split.
 *
 *   npx esbuild scripts/policy-exam.ts --bundle --platform=node --format=esm --outfile=/tmp/policy-exam.mjs && node /tmp/policy-exam.mjs [--write|--hash]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policyHash, runLiveExam } from "../src/rooms/policy/exam";
import { POLICY } from "../src/rooms/policy/policy";

if (process.argv.includes("--hash")) {
  console.log(policyHash());
  process.exit(0);
}
const file = join(process.cwd(), "policy", "exam-result.json");
const result = runLiveExam();
let history: unknown[] = [];
try { history = (JSON.parse(readFileSync(file, "utf8")) as { history?: unknown[] }).history ?? []; } catch { /* first run */ }
const record = {
  ranAt: new Date().toISOString().slice(0, 10), policyVersion: POLICY.version, frozenAt: POLICY.frozen_at, split: result.split,
  inSplit: result.inSplit, unseen: result.total, seenExcluded: result.seenExcluded, needed: result.needed, enough: result.enough,
  accuracy: result.accuracy, correct: result.correct, total: result.total, passed: result.passed, minAccuracy: result.minAccuracy, unsafe: result.unsafe,
  fingerprint: result.fingerprint, verdict: result.verdict, history,
};
console.log(JSON.stringify({ ...record, bySource: result.bySource, byStrength: result.byStrength, confusion: result.confusion, misses: result.misses }, null, 2));
if (process.argv.includes("--write")) writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
