import type Database from "better-sqlite3";
import { EXAM, EXAM_RESULT_KEY, authorize, runExam, storedExam, type StoredExam } from "./exam";
import { composeMorningList } from "./morning";
import { POLICY, TIERS, explainChange, type ChangeDescriptor } from "./policy";

export const POLICY_USAGE = [
  "bb lane-pilot policy-exam                        run the held-out exam of the night policy over the owner's past decisions; stores the result",
  "bb lane-pilot policy show                        the three lists (ids) and the last stored exam result",
  "bb lane-pilot policy classify '<descriptor-json>' tier of a change {kind?, files?, settings?, tables?, attrs?} and what the exam lets the night do with it",
  "bb lane-pilot policy morning                     the three-line morning list",
].join("\n");

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
export type PolicyCliDeps = { db: Pick<Database.Database, "prepare">; kv: Kv; now?(): number };

const json = (value: unknown) => JSON.stringify(value, null, 2);

export async function runPolicyCli(deps: PolicyCliDeps, command: "policy-exam" | "policy", args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const now = deps.now ?? Date.now;
  try {
    if (command === "policy-exam") {
      const result = runExam();
      await deps.kv.set(EXAM_RESULT_KEY, storedExam(result, now()) as never);
      const verdict = result.passed ? `PASSED: night_decides takes effect` : `FAILED: night_decides degrades to night_proposes until the policy is re-distilled and the exam passes`;
      return { exitCode: result.passed ? 0 : 1, stdout: `${json(result)}\n${verdict} (accuracy ${result.accuracy}, bar ${result.minAccuracy}, ${result.total} items)` };
    }
    const [op = "show", ...rest] = args;
    if (op === "show") {
      const stored = await deps.kv.get<StoredExam>(EXAM_RESULT_KEY);
      return { exitCode: 0, stdout: json({ version: POLICY.version, ...Object.fromEntries(TIERS.map((tier) => [tier, POLICY[tier].map((entry) => entry.id)])), exam: { items: EXAM.items.length, minAccuracy: POLICY.exam.min_accuracy, lastStoredRun: stored ?? null } }) };
    }
    if (op === "classify") {
      if (!rest[0]) return { exitCode: 1, stderr: `classify needs a descriptor\n${POLICY_USAGE}` };
      const change = JSON.parse(rest.join(" ")) as ChangeDescriptor;
      return { exitCode: 0, stdout: json({ ...explainChange(change), authorized: authorize(change) }) };
    }
    if (op === "morning") return { exitCode: 0, stdout: composeMorningList(deps.db, now()).join("\n") };
    return { exitCode: 1, stderr: `unknown policy operation «${op}»\n${POLICY_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
