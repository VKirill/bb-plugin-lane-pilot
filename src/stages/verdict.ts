import { z } from "zod";
import { clipped } from "./model-json";

/**
 * One verdict for every stage that judges something: plan critique, code critique, specialist review, browser check and
 * the self-repair triage. `pass` goes on; `rework` is the repair path that already exists (the writer fixes the findings,
 * or the PM fixes the plan); `block` stops the task with no free redo and a message for the PM.
 */
export const VERDICT_STATUSES = ["pass", "rework", "block"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const VERDICT_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type VerdictSeverity = (typeof VERDICT_SEVERITIES)[number];

export const verdictFindingSchema = z.object({
  /** The repository file the finding is about; `TASK` or `PLAN` for the contract or the plan; empty when it is not located. */
  file: z.string().max(500),
  line: z.number().int().positive().nullable().optional(),
  severity: z.enum(VERDICT_SEVERITIES),
  /** What was observed: the quoted code, the output line, the element that was (not) found. */
  evidence: clipped(2000),
  id: clipped(80).optional(),
  finding: clipped(1000).optional(),
  criterion: clipped(500).optional(),
  dimension: clipped(80).optional(),
  impact: clipped(500).optional(),
  trigger: clipped(500).optional(),
  verificationExpectation: clipped(500).optional(),
}).strict();

export const verdictSchema = z.object({
  status: z.enum(VERDICT_STATUSES),
  summary: clipped(2000).optional(),
  findings: z.array(verdictFindingSchema).max(30),
  /** What was examined and how, so the verdict can be checked. */
  evidence: clipped(4000),
}).strict();

export type VerdictFinding = z.infer<typeof verdictFindingSchema>;
export type Verdict = z.infer<typeof verdictSchema>;
export type VerdictKind = "plan" | "code" | "specialist";

/** The reading the host gives a finding at or above this severity: it can stop or send back work. */
export const isSerious = (finding: Pick<VerdictFinding, "severity">): boolean => finding.severity === "critical" || finding.severity === "high";

/** Old stage outputs call a finding `blocking`, `warning` or `info`. */
export const legacySeverityToVerdict = (severity: "info" | "warning" | "blocking"): VerdictSeverity => severity === "blocking" ? "high" : severity === "warning" ? "medium" : "info";
export const verdictSeverityToLegacy = (severity: VerdictSeverity): "info" | "warning" | "blocking" => severity === "critical" || severity === "high" ? "blocking" : severity === "medium" ? "warning" : "info";

/**
 * The decisions old outputs carried: `approve` and `changes_requested` (plan and code critics), `approve` and `block`
 * (specialist). An old specialist block means a risk the plan does not mitigate, which the PM settles by editing the plan:
 * that is a rework. Only an answer in the new format can say `block`.
 */
export function legacyDecisionToStatus(decision: "approve" | "changes_requested" | "block"): VerdictStatus {
  return decision === "approve" ? "pass" : "rework";
}

/** The old `decision` a status stands for in a stored result (stats and replays read `decision`). */
export const statusToLegacyDecision = (status: VerdictStatus): "approve" | "changes_requested" => status === "pass" ? "approve" : "changes_requested";

/** A browser check ends passed, failed or blocked: pass, rework (the page is wrong) or block (it could not be checked). */
export const qaStateToStatus = (state: "passed" | "failed" | "blocked"): VerdictStatus => state === "passed" ? "pass" : state === "failed" ? "rework" : "block";

/** A new-format answer carries `status`; anything else is read as an old output. */
export function isVerdictShape(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && "status" in (value as object);
}

/** A finding only counts at critical or high when it names where it is and quotes what was seen. */
function counts(finding: VerdictFinding, kind: VerdictKind): boolean {
  if (finding.file.trim() === "" || finding.evidence.trim().length < 12) return false;
  return kind === "specialist" || finding.line != null;
}

export type SettledVerdict = { verdict: Verdict; demoted: number };

/**
 * The host's reading of a verdict, so a model's status cannot say more than its findings back up:
 * - a critical or high finding with no file, no line (specialist: no file) or no quoted evidence does not count and is read as medium;
 * - a pass that carries a critical or high finding is a rework;
 * - code: BLOCK is one critical finding or more than 5 high, a block below that is a rework, a rework with no serious
 *   finding is a pass (it has nothing to repair).
 */
export function settleVerdict(verdict: Verdict, kind: VerdictKind): SettledVerdict {
  let demoted = 0;
  const findings = verdict.findings.map((finding) => {
    if (!isSerious(finding) || counts(finding, kind)) return finding;
    demoted += 1;
    return { ...finding, severity: "medium" as const };
  });
  const critical = findings.filter((finding) => finding.severity === "critical").length;
  const high = findings.filter((finding) => finding.severity === "high").length;
  let status = verdict.status;
  if (kind === "code") {
    const blocks = critical >= 1 || high > 5;
    if (blocks) status = "block";
    else if (status === "block") status = high > 0 ? "rework" : "pass";
    if (status === "rework" && high === 0) status = "pass";
  }
  if (status === "pass" && critical + high > 0) status = "rework";
  return { verdict: { ...verdict, status, findings }, demoted };
}

/** The text a verdict that tells the PM to stop carries; the same string is the attempt's reason and the receipt's. */
export const VERDICT_BLOCK_PREFIX = "verdict_block:";
export const isVerdictBlockReason = (reason: string | null | undefined): boolean => (reason ?? "").startsWith(VERDICT_BLOCK_PREFIX);

export function blockReason(stage: string, input: { summary?: string; findings: readonly Pick<VerdictFinding, "file" | "line" | "severity" | "evidence" | "finding">[] }): string {
  const lead = (input.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  const top = input.findings.filter(isSerious).slice(0, 3)
    .map((finding) => `${finding.file || "-"}${finding.line ? `:${finding.line}` : ""} [${finding.severity}] ${(finding.finding ?? finding.evidence).replace(/\s+/g, " ").trim().slice(0, 160)}`);
  return `${VERDICT_BLOCK_PREFIX}${stage}: ${lead || "the reviewer stopped this task"}${top.length ? ` | ${top.join(" | ")}` : ""} | stopped, not redone: the work is not fixable by another turn of the same task; tell the owner or change the approach before sending anything again`;
}

/** A model that answers with `status` sometimes keeps the old `decision` next to it: the status is the answer. */
export const withoutDecision = (raw: Record<string, unknown>): Record<string, unknown> => {
  const { decision: _decision, ...rest } = raw;
  return rest;
};

/** An old critic output as a verdict: its findings carry no file and no line, only a weight and a text. */
export function legacyOutputToVerdict(input: {
  status: VerdictStatus;
  summary: string;
  findings: ReadonlyArray<{ severity: "info" | "warning" | "blocking"; finding: string; criterion: string; id?: string; path?: string; line?: number; evidence?: string;
    impact?: string; trigger?: string; verificationExpectation?: string }>;
}): Verdict {
  return {
    status: input.status,
    summary: input.summary,
    findings: input.findings.map((row) => ({
      file: row.path ?? "", ...(row.line ? { line: row.line } : {}), severity: legacySeverityToVerdict(row.severity),
      evidence: row.evidence ?? row.finding, finding: row.finding, criterion: row.criterion,
      ...(row.id ? { id: row.id } : {}), ...(row.impact ? { impact: row.impact } : {}), ...(row.trigger ? { trigger: row.trigger } : {}),
      ...(row.verificationExpectation ? { verificationExpectation: row.verificationExpectation } : {}),
    })),
    evidence: input.summary,
  };
}

/** The summary of a verdict: its own, or the start of its evidence. */
export const verdictSummary = (verdict: Verdict): string => verdict.summary ?? verdict.evidence.slice(0, 2000);

/** The reason a stage returns for a status that stops the task: the block text for `block`, the stage's own for `rework`. */
export const reasonForStatus = (status: VerdictStatus | undefined, stage: string, result: { summary?: string; verdict?: Verdict }, reworkReason: string): string =>
  status === "block" ? blockReason(stage, { summary: result.summary, findings: result.verdict?.findings ?? [] }) : reworkReason;
