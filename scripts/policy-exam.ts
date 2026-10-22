/**
 * Runs the night-policy exam outside BB and (with --write) records the result next to the policy, policy/exam-result.json.
 * tests/policy/exam.test.ts fails when that record does not match the current policy and exam, so a policy edited without a fresh run is caught in CI.
 *
 *   npx esbuild scripts/policy-exam.ts --bundle --platform=node --format=esm --outfile=/tmp/policy-exam.mjs && node /tmp/policy-exam.mjs [--write]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExam } from "../src/rooms/policy/exam";

const result = runExam();
const record = { ranAt: new Date().toISOString().slice(0, 10), accuracy: result.accuracy, correct: result.correct, total: result.total, passed: result.passed, minAccuracy: result.minAccuracy, unsafe: result.unsafe, fingerprint: result.fingerprint };
console.log(JSON.stringify({ ...record, bySource: result.bySource, byStrength: result.byStrength, confusion: result.confusion, answeredByEntry: result.answeredByEntry, answeredByDefault: result.answeredByDefault, misses: result.misses }, null, 2));
if (process.argv.includes("--write")) writeFileSync(join(process.cwd(), "policy", "exam-result.json"), `${JSON.stringify(record, null, 2)}\n`);
