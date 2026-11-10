import type Database from "better-sqlite3";
import { EXAM, EXAM_RESULT_KEY, authorize, runExam, runLiveExam, storedExam, type StoredExam } from "./exam";
import { collectAndAppend, loadLiveExam, recordOwnerDecision, appendLiveItems, type OwnerDecisionInput } from "./live-exam";
import { EXAM_DRAFTS_KEY, mineDecisions, settleDraft, type DecisionDraft, type DecisionJudge, type MinedMessage } from "./mine";
import { composeMorningList, MORNING_WINDOW_MS } from "./morning";
import type { OwnerItemSweep } from "../owner-waiting";
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
export type PolicyCliDeps = { db: Pick<Database.Database, "prepare">; kv: Kv; now?(): number; ownerSweeps?: readonly OwnerItemSweep[]; reviewedObs?: Parameters<typeof collectAndAppend>[4];
  /** decisions-mine: the owner messages of a window and the judgment that tells a decision from chatter. */
  mineMessages?: (from: number, to: number) => Promise<MinedMessage[]>;
  mineJudge?: DecisionJudge };

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
    if (op === "exam-collect") return { exitCode: 0, stdout: json(await collectAndAppend(deps.db, deps.kv, now(), undefined, deps.reviewedObs)) };
    if (op === "exam-add") {
      if (!rest[0]) return { exitCode: 1, stderr: `exam-add needs a JSON object\n${POLICY_USAGE}` };
      const input = JSON.parse(rest.join(" ")) as Omit<OwnerDecisionInput, "at"> & { at?: number };
      return { exitCode: 0, stdout: json(await appendLiveItems(deps.kv, [recordOwnerDecision({ ...input, at: input.at ?? now() })])) };
    }
    if (op === "exam-export") return { exitCode: 0, stdout: json(await loadLiveExam(deps.kv)) };
    if (op === "morning") return { exitCode: 0, stdout: composeMorningList(deps.db, now(), MORNING_WINDOW_MS, deps.ownerSweeps ?? []).join("\n") };
    // sma decisions mine (SMA k_v_decisions): owner messages -> drafts; only `accept` moves one into the exam.
    if (op === "decisions-mine") {
      if (!deps.mineMessages || !deps.mineJudge) return { exitCode: 1, stderr: "decisions-mine is not wired in this context (no message source or judge)" };
      const hours = Number(rest[0] ?? 24 * 7);
      if (!Number.isFinite(hours) || hours <= 0) return { exitCode: 1, stderr: "usage: bb lane-pilot policy decisions-mine [hours=168]" };
      const messages = await deps.mineMessages(now() - hours * 3_600_000, now());
      return { exitCode: 0, stdout: json(await mineDecisions(deps.kv, messages, deps.mineJudge)) };
    }
    if (op === "decisions-drafts") {
      const [word, id] = rest as [string | undefined, string | undefined];
      if (!word) return { exitCode: 0, stdout: json((await deps.kv.get<DecisionDraft[]>(EXAM_DRAFTS_KEY)) ?? []) };
      if ((word !== "accept" && word !== "dismiss") || !id) return { exitCode: 1, stderr: "usage: bb lane-pilot policy decisions-drafts accept|dismiss <id>" };
      const settled = await settleDraft(deps.kv, id, word);
      return settled.ok ? { exitCode: 0, stdout: json(settled) } : { exitCode: 1, stderr: settled.reason };
    }
    return { exitCode: 1, stderr: `unknown policy operation «${op}»\n${POLICY_USAGE}` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
