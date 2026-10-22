import type Database from "better-sqlite3";
import { EXAM, EXAM_RESULT_KEY, authorize, runExam, runLiveExam, storedExam, type StoredExam } from "./exam";
import { collectAndAppend, loadLiveExam, recordOwnerDecision, appendLiveItems, type OwnerDecisionInput } from "./live-exam";
import { composeMorningList } from "./morning";
import { POLICY, TIERS, explainChange, type ChangeDescriptor } from "./policy";

export const POLICY_USAGE = [
  "bb lane-pilot policy-exam                        score the current policy on the newest unseen split (exam-v2: owner decisions after its freeze); stores the result",
  "bb lane-pilot policy show                        the lists (ids), the standing prohibitions and the last stored exam result",
  "bb lane-pilot policy classify '<descriptor-json>' tier of a change {kind?, files?, settings?, tables?, attrs?} and what the exam lets the night do with it",
  "bb lane-pilot policy exam-collect                (night) append the owner's new decisions to exam-v2",
  "bb lane-pilot policy exam-add '<json>'           append an owner message that approves or refuses a change: {quote, ref, at?, descriptor, expected, strength?, why}",
  "bb lane-pilot policy exam-export                 print exam-v2 (committed part plus store) as policy/exam-v2.json",
  "bb lane-pilot policy morning                     the three-line morning list",
].join("\n");

type Kv = { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: never): Promise<unknown> };
export type PolicyCliDeps = { db: Pick<Database.Database, "prepare">; kv: Kv; now?(): number };

const json = (value: unknown) => JSON.stringify(value, null, 2);

export async function runPolicyCli(deps: PolicyCliDeps, command: "policy-exam" | "policy", args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const now = deps.now ?? Date.now;
  try {
    if (command === "policy-exam") {
      const live = await loadLiveExam(deps.kv);
      const result = runLiveExam(POLICY, live);
      await deps.kv.set(EXAM_RESULT_KEY, storedExam(result, now()) as never);
      // The v1 split is history: this policy version has seen it, so its score is printed as a regression check and is not evidence.
      const history = runExam(POLICY, EXAM);
      const note = { policyVersion: POLICY.version, frozenAt: POLICY.frozen_at, history: { split: "exam v1 (seen by this policy, in-sample, not evidence)", correct: history.correct, total: history.total, accuracy: history.accuracy } };
      return { exitCode: result.passed ? 0 : result.enough ? 1 : 2, stdout: `${json({ ...result, ...note })}\n${result.verdict}` };
    }
    const [op = "show", ...rest] = args;
    if (op === "show") {
      const stored = await deps.kv.get<StoredExam>(EXAM_RESULT_KEY);
      const live = await loadLiveExam(deps.kv);
      return { exitCode: 0, stdout: json({
        version: POLICY.version, frozenAt: POLICY.frozen_at,
        ...Object.fromEntries(TIERS.map((tier) => [tier, POLICY[tier].map((entry) => entry.id)])),
        standing_prohibitions: POLICY.standing_prohibitions.map((entry) => entry.id),
        exam: { v1Items: EXAM.items.length, v2Items: live.items.length, minAccuracy: POLICY.exam.min_accuracy, minItems: POLICY.exam.min_items, lastStoredRun: stored ?? null },
      }) };
    }
    if (op === "classify") {
      if (!rest[0]) return { exitCode: 1, stderr: `classify needs a descriptor\n${POLICY_USAGE}` };
      const change = JSON.parse(rest.join(" ")) as ChangeDescriptor;
      return { exitCode: 0, stdout: json({ ...explainChange(change), authorized: authorize(change) }) };
    }
    if (op === "exam-collect") return { exitCode: 0, stdout: json(await collectAndAppend(deps.db, deps.kv, now())) };
    if (op === "exam-add") {
      if (!rest[0]) return { exitCode: 1, stderr: `exam-add needs a JSON object\n${POLICY_USAGE}` };
      const input = JSON.parse(rest.join(" ")) as Omit<OwnerDecisionInput, "at"> & { at?: number };
      return { exitCode: 0, stdout: json(await appendLiveItems(deps.kv, [recordOwnerDecision({ ...input, at: input.at ?? now() })])) };
    }
    if (op === "exam-export") return { exitCode: 0, stdout: json(await loadLiveExam(deps.kv)) };
    if (op === "morning") return { exitCode: 0, stdout: composeMorningList(deps.db, now()).join("\n") };
    return { exitCode: 1, stderr: `unknown policy operation «${op}»\n${POLICY_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
