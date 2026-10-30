import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * Gemini #1: the cheap first pass over lp.review's confirm swarm. For each critical/high finding one noul — is this
 * finding's verdict obvious to a second reader (a real defect with quoted evidence, or plainly self-contradicting)?
 * Obvious findings keep their place without paying three critic threads; the unsure ones go to the majority swarm as
 * before. Jev never drops a finding — rejection stays the swarm's call, so shadow mode just sends everything onward.
 */
export const REVIEW_CONFIRM_SCREEN_ID = "review.confirm_screen";
const MAX_FINDINGS = 16;

export type ReviewFinding = { file?: string; line?: number | string; severity?: string; evidence?: string; impact?: string; suggestion?: string } & Record<string, unknown>;

export type ConfirmScreenInput = { findings: ReviewFinding[] };
export type ConfirmScreenDecision = { unsure_findings: ReviewFinding[]; settled: number };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const findingsOf = (input: ConfirmScreenInput) => (Array.isArray(input.findings) ? input.findings : []).slice(0, MAX_FINDINGS);

export const reviewConfirmScreenJudgment = defineJudgment<ConfirmScreenInput, ConfirmScreenDecision>({
  id: REVIEW_CONFIRM_SCREEN_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    findings: clip(JSON.stringify(findingsOf(input).map((f) => ({ file: f.file ?? "", line: f.line ?? "", severity: f.severity ?? "", evidence: f.evidence ?? "", impact: f.impact ?? "" }))), 6_000),
  }),
  // The swarm's own scope: only critical/high findings are screened; the rest never reach `unsure_findings`.
  questions: (input) => Object.fromEntries(
    findingsOf(input).map((finding, index) => [
      `sure_${index}`,
      noul(
        "Finding " + index + " in `findings` (" + (finding.file ?? "?") + ":" + (finding.line ?? "?") + ", " + (finding.severity ?? "?") + "): is its verdict obvious — either a real defect the quoted evidence proves, or a plainly wrong one — so three more critics would surely agree? Answer no when the finding is plausible but disputable.",
        { true: "obvious — the swarm would agree", false: "disputable — worth the swarm" },
      ),
    ]),
  ),
  thresholds: {
    min_p: { default: 0.75, min: 0.55, max: 0.95, about: "least probability of «obvious» before the finding skips the confirm swarm" },
  },
  decide(answers, t, input) {
    const unsure: ReviewFinding[] = [];
    const major = (finding: ReviewFinding) => finding.severity === "critical" || finding.severity === "high";
    for (const [index, finding] of findingsOf(input).entries()) {
      const p = noulOf(answers, `sure_${index}`);
      if (major(finding) && (p === undefined || p < t.min_p!)) unsure.push(finding);
    }
    const settled = findingsOf(input).filter(major).length - unsure.length;
    return { decision: { unsure_findings: unsure, settled } };
  },
  // Unsure on everything: the swarm sees every major finding, exactly as without the screen.
  fallback: (input) => ({ unsure_findings: findingsOf(input).filter((finding) => finding.severity === "critical" || finding.severity === "high"), settled: 0 }),
  describe: (decision) => `${decision.settled} settled, ${decision.unsure_findings.length} to the swarm`,
});
