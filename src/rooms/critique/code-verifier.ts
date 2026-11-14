import { z } from "zod";
import { REVIEW_READ_ONLY_LINE, extractModelJson, settleVerdict, statusToLegacyDecision } from "@lane-pilot/workflow-engine";
import type { VerdictFinding, VerdictStatus } from "@lane-pilot/workflow-engine";
import type { CodeCritiqueFinding, CodeCritiqueResult } from "./code-critique";
import { taskBrief } from "./task-brief";

/**
 * The second look at a strict code critique: when the critic of a strict task (sensitive path, risk high, edited reference tests, no checks)
 * returns a critical or high finding, one model of another family checks only those findings against the code. A refuted finding drops to
 * medium; confirmed and unsure stay. Hub, 30 days to 2026-11-14: 5 of the 7 critic stops were serious, so the stop is worth one more look.
 */
export const VERIFIER_MAX_FINDINGS = 10;

export const verifierVerdictSchema = z.object({
  id: z.string().min(1).max(200),
  verdict: z.enum(["confirmed", "refuted", "unsure"]),
  evidence: z.preprocess((value) => value == null ? "" : value, z.string().max(2000)),
});
export type VerifierVerdict = z.infer<typeof verifierVerdictSchema>;

/** The findings the verifier looks at: the critical and high ones (the legacy `blocking`), in order, at most VERIFIER_MAX_FINDINGS. */
export const seriousFindings = (critique: Pick<CodeCritiqueResult, "findings">): CodeCritiqueFinding[] =>
  critique.findings.filter((finding) => finding.severity === "blocking").slice(0, VERIFIER_MAX_FINDINGS);

export function verifierPrompt(input: { findings: readonly CodeCritiqueFinding[]; task: unknown; workspace?: string }): string {
  const rows = input.findings.map((finding) => ({
    id: finding.id, file: finding.path ?? null, line: finding.line ?? null, criterion: finding.criterion, finding: finding.finding,
    evidence: finding.evidence ?? "", trigger: finding.trigger ?? "",
  }));
  return [
    "You are the independent verifier of a code review. Another reviewer reported the findings below against a finished change. You did not see its reasoning and you must not assume it is right.",
    `For each finding, open the file${input.workspace ? ` in ${input.workspace}` : ""} and read the code at the cited line and around it (callers, guards, types, tests). Decide: confirmed (the defect is there and its trigger can happen), refuted (the code does not do what the finding says, or a guard elsewhere covers it; quote it), or unsure (you could not settle it from the code). ${REVIEW_READ_ONLY_LINE}`,
    "TASK (for context only):", taskBrief(input.task),
    "FINDINGS:", JSON.stringify(rows),
    'Finish your final message with one JSON object and nothing after it: {"verdicts":[{"id": the finding id exactly as given, "verdict":"confirmed"|"refuted"|"unsure", "evidence": at most 2000 characters, the quoted code or output that decides it}]}. One entry per finding.',
  ].join("\n\n");
}

/** The verifier's answer: `{verdicts:[…]}` or a bare array. Entries for ids that were not asked, and repeats, are dropped. */
export function parseVerifierAnswer(output: string, asked: readonly string[]): VerifierVerdict[] {
  const raw = extractModelJson(output) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) throw new Error("verifier_answer_unreadable");
  const wanted = new Set(asked);
  const seen = new Set<string>();
  const out: VerifierVerdict[] = [];
  for (const item of list) {
    const parsed = verifierVerdictSchema.safeParse(item);
    if (!parsed.success || !wanted.has(parsed.data.id) || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    out.push(parsed.data);
  }
  return out;
}

export type VerifierSummary = {
  model: string; confirmed: number; refuted: number; unsure: number;
  /** Each checked finding with the verifier's verdict and evidence: the refuted ones are kept here, at medium in the critique. */
  findings: VerifierVerdict[];
};

/**
 * The critique after the verifier: a refuted finding is medium (`warning`), the rest unchanged. With none serious left the critique passes;
 * with a verdict beside it, the verdict's own severities are lowered and settled again, so `status` follows the same thresholds as before.
 */
export function applyVerifier(critique: CodeCritiqueResult, verdicts: readonly VerifierVerdict[], model: string, idOf: (row: VerdictFinding) => string): { critique: CodeCritiqueResult; verifier: VerifierSummary } {
  const refuted = new Set(verdicts.filter((row) => row.verdict === "refuted").map((row) => row.id));
  const count = (kind: VerifierVerdict["verdict"]) => verdicts.filter((row) => row.verdict === kind).length;
  const verifier: VerifierSummary = { model, confirmed: count("confirmed"), refuted: count("refuted"), unsure: count("unsure"), findings: [...verdicts] };
  if (!refuted.size) return { critique, verifier };
  const findings = critique.findings.map((finding) => refuted.has(finding.id) ? { ...finding, severity: "warning" as const } : finding);
  let next: CodeCritiqueResult = { ...critique, findings };
  if (critique.verdict) {
    const lowered = { ...critique.verdict, findings: critique.verdict.findings.map((row) => refuted.has(idOf(row)) && (row.severity === "critical" || row.severity === "high") ? { ...row, severity: "medium" as const } : row) };
    const { verdict } = settleVerdict(lowered, "code");
    next = { ...next, verdict, status: verdict.status, decision: statusToLegacyDecision(verdict.status) };
  } else if (!findings.some((finding) => finding.severity === "blocking")) {
    next = { ...next, status: "pass" as VerdictStatus, decision: "approve" };
  }
  return { critique: next, verifier };
}
