import { z } from "zod";
import { sha256Hex } from "@lane-pilot/kit";
import examJson from "../../../policy/exam.json";
import { POLICY, RESTRICTION, TIERS, explainChange, type ChangeDescriptor, type Policy, type Tier } from "./policy";

/**
 * The exam of the night policy. Each item is a situation taken from a decision the owner really made (a rule proposal he accepted,
 * rejected or took back, a learning observation he labelled, a decision written in the memory files), turned into the change
 * descriptor the night would have faced, with the tier his decision implies. The policy sees the descriptor and never the label.
 * Items the policy was written from live in policy/night-policy.json (design_items) and are not here.
 *
 * The night may decide alone only while this exam passes: below `min_accuracy` night_decides degrades to night_proposes (`authorize`).
 */
const scalar = z.union([z.string(), z.number(), z.boolean()]);
const descriptorSchema = z.object({
  kind: z.string().optional(), files: z.array(z.string()).optional(), settings: z.array(z.string()).optional(), tables: z.array(z.string()).optional(),
  attrs: z.record(z.string(), scalar).optional(),
}).strict();

export const examItemSchema = z.object({
  id: z.string().regex(/^x\d+$/),
  source: z.object({ type: z.enum(["rule_proposal", "learning_observation", "memory"]), ref: z.string().min(1), date: z.string().min(1) }).strict(),
  /** The owner's words or the stored record the label comes from. */
  quote: z.string().min(1),
  descriptor: descriptorSchema,
  expected: z.enum(TIERS),
  /** strong: the owner said it or took an action against the agent; medium: he decided an individual proposal; weak: he left it standing (silence). */
  strength: z.enum(["strong", "medium", "weak"]),
  why: z.string().min(1),
}).strict();
export type ExamItem = z.infer<typeof examItemSchema>;

export const examSchema = z.object({
  version: z.number().int().positive(),
  labelling: z.record(z.string(), z.string()),
  items: z.array(examItemSchema).min(1),
}).passthrough();
export type Exam = z.infer<typeof examSchema>;

export const EXAM: Exam = examSchema.parse(examJson);

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

/** What the exam is about: the policy lists and the exam items. A changed policy or exam has a different fingerprint, so an old result never vouches for a new policy. */
export function examFingerprint(policy: Policy = POLICY, exam: Exam = EXAM): string {
  return sha256Hex(JSON.stringify({ policy: { night_decides: policy.night_decides, night_proposes: policy.night_proposes, owner_only: policy.owner_only, min: policy.exam.min_accuracy }, items: exam.items }));
}

export function runExam(policy: Policy = POLICY, exam: Exam = EXAM): ExamResult {
  const rows = exam.items.map((item) => {
    const answer = explainChange(item.descriptor as ChangeDescriptor, policy);
    const ok = answer.tier === item.expected;
    return { item, answer, ok, unsafe: RESTRICTION[answer.tier] < RESTRICTION[item.expected] };
  });
  const correct = rows.filter((row) => row.ok).length;
  const accuracy = rate(correct, rows.length);
  const confusion: Record<string, number> = {};
  for (const row of rows) confusion[`${row.item.expected}->${row.answer.tier}`] = (confusion[`${row.item.expected}->${row.answer.tier}`] ?? 0) + 1;
  return {
    total: rows.length, correct, accuracy, minAccuracy: policy.exam.min_accuracy, passed: accuracy >= policy.exam.min_accuracy,
    unsafe: rows.filter((row) => row.unsafe).length,
    bySource: group(rows.map((row) => ({ key: row.item.source.type, ok: row.ok }))),
    byStrength: group(rows.map((row) => ({ key: row.item.strength, ok: row.ok }))),
    answeredByEntry: rows.filter((row) => row.answer.matched.length).length, answeredByDefault: rows.filter((row) => !row.answer.matched.length).length,
    confusion,
    misses: rows.filter((row) => !row.ok).map((row) => ({ id: row.item.id, source: `${row.item.source.type}:${row.item.source.ref}`, expected: row.item.expected, got: row.answer.tier, unsafe: row.unsafe, reason: row.answer.reason })),
    fingerprint: examFingerprint(policy, exam),
  };
}

/** Where the last run is kept (plugin key-value store), for the morning list and `bb lane-pilot policy`. The gate itself never reads it: it recomputes. */
export const EXAM_RESULT_KEY = "policy:exam-result";
export type StoredExam = { at: number; accuracy: number; correct: number; total: number; passed: boolean; unsafe: number; fingerprint: string };
export const storedExam = (result: ExamResult, at: number): StoredExam => ({ at, accuracy: result.accuracy, correct: result.correct, total: result.total, passed: result.passed, unsafe: result.unsafe, fingerprint: result.fingerprint });

export type Authorization = { requested: Tier; tier: Tier; degraded: boolean; reason: string; matched: Array<{ id: string; tier: Tier }> };

/**
 * What the night may do with a change. The classification is final except for one rule: while the exam fails, night_decides is
 * night_proposes. The exam is recomputed here (it is a few dozen comparisons), so a policy edited without a passing exam cannot decide.
 */
export function authorize(change: ChangeDescriptor, options: { policy?: Policy; exam?: Exam } = {}): Authorization {
  const policy = options.policy ?? POLICY;
  const answer = explainChange(change, policy);
  if (answer.tier !== "night_decides") return { requested: answer.tier, tier: answer.tier, degraded: false, reason: answer.reason, matched: answer.matched };
  const result = runExam(policy, options.exam ?? EXAM);
  if (result.passed) return { requested: answer.tier, tier: "night_decides", degraded: false, reason: answer.reason, matched: answer.matched };
  return { requested: answer.tier, tier: "night_proposes", degraded: true, reason: `${answer.reason}; degraded: the policy exam scored ${result.accuracy} on ${result.total} items, under ${result.minAccuracy}`, matched: answer.matched };
}
