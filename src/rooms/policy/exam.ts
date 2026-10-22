import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";
import examJson from "../../../policy/exam.json";
import liveJson from "../../../policy/exam-v2.json";
import { POLICY, RESTRICTION, TIERS, explainChange, type ChangeDescriptor, type Policy, type Tier } from "./policy";

/**
 * The exams of the night policy. An item is a situation taken from a decision the owner really made (a rule proposal he accepted,
 * rejected or took back, a learning observation he labelled, a decision written in the memory files or in a message), turned into the
 * change descriptor the night would have faced, with the tier his decision implies. The policy sees the descriptor and never the label.
 *
 * Two splits:
 *  - exam v1 (policy/exam.json): the first 32 items. History. The version-1 policy scored 14/32 on it; every later policy has seen it, so it
 *    can show a regression and prove nothing.
 *  - exam v2 (policy/exam-v2.json + the plugin store, `live-exam.ts`): grows at night with decisions made AFTER the policy version was
 *    frozen. Only items decided after `frozen_at` score a policy. A measurement of how close the policy is to the owner's own decisions;
 *    since 2026-10-22 no gate reads it (the owner takes no part in the loop: `authorize`).
 */
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const descriptorSchema = z.object({
  kind: z.string().optional(), files: z.array(z.string()).optional(), settings: z.array(z.string()).optional(), tables: z.array(z.string()).optional(),
  attrs: z.record(z.string(), scalar).optional(),
}).strict();

const itemBody = {
  /** The owner's words or the stored record the label comes from. */
  quote: z.string().min(1),
  descriptor: descriptorSchema,
  expected: z.enum(TIERS),
  /** strong: the owner said it or took an action against the agent; medium: he decided an individual proposal; weak: he left it standing (silence). */
  strength: z.enum(["strong", "medium", "weak"]),
  why: z.string().min(1),
};

export const examItemSchema = z.object({
  id: z.string().regex(/^x\d+$/),
  source: z.object({ type: z.enum(["rule_proposal", "learning_observation", "memory"]), ref: z.string().min(1), date: z.string().min(1) }).strict(),
  ...itemBody,
}).strict();
export type ExamItem = z.infer<typeof examItemSchema>;

export const examSchema = z.object({
  version: z.number().int().positive(),
  labelling: z.record(z.string(), z.string()),
  items: z.array(examItemSchema).min(1),
}).passthrough();
export type Exam = z.infer<typeof examSchema>;

/** The v1 split, kept as history. Not read by `authorize`. */
export const EXAM: Exam = examSchema.parse(examJson);

/** One owner decision of the growing split. `decided_at` is when he decided; only items decided after the policy's freeze may score it. */
export const liveItemSchema = z.object({
  id: z.string().regex(/^y_[0-9a-f]{12}$/),
  source: z.object({ type: z.enum(["rule_proposal", "learning_observation", "owner_message"]), ref: z.string().min(1), date: z.string().min(1) }).strict(),
  decided_at: z.string().datetime(),
  ...itemBody,
}).strict();
export type LiveItem = z.infer<typeof liveItemSchema>;

export const liveExamSchema = z.object({
  version: z.number().int().positive(),
  labelling: z.record(z.string(), z.string()),
  items: z.array(liveItemSchema),
}).passthrough();
export type LiveExam = z.infer<typeof liveExamSchema>;

/** The committed part of exam v2. The night appends to the plugin store; `loadLiveExam` (live-exam.ts) merges both. */
export const EXAM_LIVE: LiveExam = liveExamSchema.parse(liveJson);

/** What the scorer needs from an item of either split. */
export type Scorable = { items: ReadonlyArray<{ id: string; source: { type: string; ref: string }; descriptor: ChangeDescriptor; expected: Tier; strength: string }> };

export type ExamMiss = { id: string; source: string; expected: Tier; got: Tier; unsafe: boolean; reason: string };
export type ExamResult = {
  total: number; correct: number; accuracy: number; passed: boolean; minAccuracy: number;
  /** Answers less restrictive than the owner's decision implies (night_decides where he wanted a proposal or the decision himself). */
  unsafe: number;
  bySource: Record<string, { total: number; correct: number; accuracy: number }>;
  byStrength: Record<string, { total: number; correct: number; accuracy: number }>;
  /** How many answers came from a matching entry and how many from the default for unknown changes. */
  answeredByEntry: number; answeredByDefault: number;
  confusion: Record<string, number>;
  misses: ExamMiss[];
  fingerprint: string;
};

const rate = (correct: number, total: number) => (total ? Math.round((correct / total) * 1000) / 1000 : 0);
const group = (rows: Array<{ key: string; ok: boolean }>) => {
  const out: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const row of rows) { const g = (out[row.key] ??= { total: 0, correct: 0, accuracy: 0 }); g.total++; if (row.ok) g.correct++; }
  for (const g of Object.values(out)) g.accuracy = rate(g.correct, g.total);
  return out;
};

const policyLists = (policy: Policy) => ({
  night_decides: policy.night_decides, night_proposes: policy.night_proposes, owner_only: policy.owner_only,
  standing_prohibitions: policy.standing_prohibitions, min: policy.exam.min_accuracy, min_items: policy.exam.min_items,
});
/** Hash of what a version decides with. `frozen_hash` in the policy file must equal it: edit the lists, bump `version` and `frozen_at`, freeze the new hash. */
export const policyHash = (policy: Policy = POLICY): string => sha256Hex(JSON.stringify(policyLists(policy)));

/** What the exam is about: the policy lists and the exam items. A changed policy or exam has a different fingerprint, so an old result never vouches for a new policy. */
export function examFingerprint(policy: Policy = POLICY, exam: Scorable = EXAM): string {
  return sha256Hex(JSON.stringify({ policy: policyLists(policy), items: exam.items }));
}

export function runExam(policy: Policy = POLICY, exam: Scorable = EXAM): ExamResult {
  const rows = exam.items.map((item) => {
    const answer = explainChange(item.descriptor, policy);
    const ok = answer.tier === item.expected;
    return { item, answer, ok, unsafe: RESTRICTION[answer.tier] < RESTRICTION[item.expected] };
  });
  const correct = rows.filter((row) => row.ok).length;
  const accuracy = rate(correct, rows.length);
  const confusion: Record<string, number> = {};
  for (const row of rows) confusion[`${row.item.expected}->${row.answer.tier}`] = (confusion[`${row.item.expected}->${row.answer.tier}`] ?? 0) + 1;
  return {
    total: rows.length, correct, accuracy, minAccuracy: policy.exam.min_accuracy, passed: rows.length > 0 && accuracy >= policy.exam.min_accuracy,
    unsafe: rows.filter((row) => row.unsafe).length,
    bySource: group(rows.map((row) => ({ key: row.item.source.type, ok: row.ok }))),
    byStrength: group(rows.map((row) => ({ key: row.item.strength, ok: row.ok }))),
    answeredByEntry: rows.filter((row) => row.answer.matched.length).length, answeredByDefault: rows.filter((row) => !row.answer.matched.length).length,
    confusion,
    misses: rows.filter((row) => !row.ok).map((row) => ({ id: row.item.id, source: `${row.item.source.type}:${row.item.source.ref}`, expected: row.item.expected, got: row.answer.tier, unsafe: row.unsafe, reason: row.answer.reason })),
    fingerprint: examFingerprint(policy, exam),
  };
}

/** Items decided strictly after the policy version was frozen: the only ones that can score it. */
export const unseenItems = (policy: Policy, exam: { items: readonly LiveItem[] }): LiveItem[] => {
  const frozen = Date.parse(policy.frozen_at);
  return exam.items.filter((item) => Date.parse(item.decided_at) > frozen);
};

export type LiveExamResult = ExamResult & {
  split: "exam-v2";
  /** Items in the split, and how many of them were decided before the freeze and are left out. */
  inSplit: number; seenExcluded: number;
  /** Unseen items needed (policy.exam.min_items) and whether there are enough. */
  needed: number; enough: boolean;
  /** One line a person can read: what the gate decided and why. */
  verdict: string;
};

/** Scores the current policy on the newest unseen split. `passed` is true only with enough unseen items AND accuracy at the bar. */
export function runLiveExam(policy: Policy = POLICY, exam: { items: readonly LiveItem[] } = EXAM_LIVE): LiveExamResult {
  const unseen = unseenItems(policy, exam);
  const base = runExam(policy, { items: unseen });
  const needed = policy.exam.min_items;
  const enough = unseen.length >= needed;
  const passed = enough && base.accuracy >= policy.exam.min_accuracy;
  const verdict = !enough
    ? `NOT ENOUGH UNSEEN DECISIONS YET: ${unseen.length} of ${needed} needed (decided after ${policy.frozen_at}); a measurement only, the night decides by its proofs`
    : passed ? `PASSED: ${base.correct}/${base.total} = ${base.accuracy} on unseen decisions (bar ${policy.exam.min_accuracy})`
      : `FAILED: ${base.correct}/${base.total} = ${base.accuracy} on unseen decisions, under ${policy.exam.min_accuracy}: the policy disagrees with the owner's own decisions, worth a look`;
  return { ...base, passed, split: "exam-v2", inSplit: exam.items.length, seenExcluded: exam.items.length - unseen.length, needed, enough, verdict };
}

/** Where the last run is kept (plugin key-value store), for the morning list and `bb lane-pilot policy`. The gate itself never reads it: it recomputes. */
export const EXAM_RESULT_KEY = "policy:exam-result";
export type StoredExam = { at: number; accuracy: number; correct: number; total: number; passed: boolean; unsafe: number; fingerprint: string; split?: string; needed?: number; enough?: boolean };
export const storedExam = (result: ExamResult | LiveExamResult, at: number): StoredExam => ({
  at, accuracy: result.accuracy, correct: result.correct, total: result.total, passed: result.passed, unsafe: result.unsafe, fingerprint: result.fingerprint,
  ...("split" in result ? { split: result.split, needed: result.needed, enough: result.enough } : {}),
});

export type Authorization = { requested: Tier; tier: Tier; reason: string; matched: Array<{ id: string; tier: Tier }> };

/**
 * What the night may do with a change: the classification, final. The owner takes no part in the loop (2026-10-22): night_decides
 * stands on the proofs its entry asks for (the bench subset, an automatic revert) and the checks after the merge (canary, bench,
 * recurrence) revert it; the exam (`runLiveExam`) is a measurement of the policy, not a gate.
 */
export function authorize(change: ChangeDescriptor, options: { policy?: Policy } = {}): Authorization {
  const answer = explainChange(change, options.policy ?? POLICY);
  return { requested: answer.tier, tier: answer.tier, reason: answer.reason, matched: answer.matched };
}
