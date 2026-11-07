import { z } from "zod";
import type { StageId } from "./stage-contract";

/**
 * What decides that a stage is done. A stage either names the code predicate that decides it (a command's exit code, a file or a
 * hash, a gate or receipt record, a schema validation of what it produced) or says it is advisory: a model's opinion, whose text
 * code only reads for its shape. An advisory stage can never be the only reason a task is accepted (`acceptanceProofGap`).
 */
export const PROOF_KINDS = ["command", "file", "gate", "receipt", "schema"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

const checkText = z.string().min(8).max(500);

export const stageProofSchema = z.union([
  z.object({ kind: z.enum(PROOF_KINDS), check: checkText }).strict(),
  /** `form` is the code check that rejects an unreadable or uncited answer; the opinion itself stays an opinion. */
  z.object({ kind: z.literal("advisory"), reason: checkText, form: checkText.optional() }).strict(),
]);
export type StageProof = z.infer<typeof stageProofSchema>;

export const isAdvisoryProof = (proof: StageProof): boolean => proof.kind === "advisory";

/** Per stage, what the code checks. Exhaustive over STAGE_IDS: a new stage does not compile until it declares its proof. */
export const STAGE_PROOF: Record<StageId, StageProof> = {
  "pm-read": { kind: "advisory", reason: "a model's summary of the read_first excerpts; it only hands context to the critics and decides nothing",
    form: "parsePmReadResult: one JSON object with a non-blank summary (a blank or unreadable answer fails the stage)" },
  "plan-critique": { kind: "advisory", reason: "a model's verdict on the plan: it never accepts a task, and in plan_critique.mode gate (the default, SMA p2_checker) its refusal stops the attempt before the writer",
    form: "parseCritique: verdict schema; a critical or high finding counts only with a file, a line and quoted evidence, and a file the critic's input names" },
  "run-gate": { kind: "receipt", check: "the run gate decision and the ownership base preflight are stored in the run-gate receipt; the repository must report a readable base commit" },
  "specialist-review": { kind: "advisory", reason: "a model's risk opinion on the plan",
    form: "parseSpecialistResult: verdict schema; a high or critical risk counts only with a file, a line and quoted evidence, and a file the reviewer's input names" },
  "writer-agent": { kind: "gate", check: "gates owns-paths and validate: the changed files are inside owns_paths and expected_outputs exist with content" },
  "verification": { kind: "command", check: "every verification[].command exits 0 in the sandbox (gate verification passed)" },
  "code-critique": { kind: "advisory", reason: "a model's review of the candidate",
    form: "parseCodeCritique: verdict schema; a critical or high finding counts only when its file is among the candidate's files and its line exists in it" },
  "plan-fact": { kind: "file", check: "blindPlanFact checks each acceptance row of the writer's plan-fact table against the candidate: the cited file is among the changed files, the cited lines overlap a changed hunk, the cited command is a verification[] command that exited 0; the writer's prose is never read" },
  "acceptance-receipt": { kind: "schema", check: "the acceptance-v2 receipt validates against lane-stack/schemas/acceptance-v2.schema.json (validateAcceptanceV2)" },
  "browser-qa": { kind: "command", check: "the browser cases run on the host and each case's recorded result is passed" },
  "docs-maintenance": { kind: "file", check: "validateDocsEdits accepts the edits, and each written file reads back byte for byte" },
  "onboarding-preview": { kind: "schema", check: "parseOnboardingPreview validates the passport and module map the onboarder produced" },
  "onboarding-apply": { kind: "file", check: "the host applies the previewed files and reports status applied" },
  "memory-maintenance": { kind: "schema", check: "parseMemoryCandidates and the memory door's content rules accept every entry (fields, valid_until, core budget)" },
  "project-life": { kind: "gate", check: "the committed head matches the commit the helper reports, and every changed path is inside the project-life scope" },
  "night-review": { kind: "schema", check: "parseNightReviewResult validates the review verdict and findings" },
  "night-fix": { kind: "command", check: "the fix changed only the finding's paths and the task's verification commands exit 0" },
  "workspace-status": { kind: "file", check: "the environment's status and diff are read from the machine, and the status outcome is available" },
  "opencode-telemetry": { kind: "file", check: "the telemetry log is read from the host (size and sha256 match), parses without malformed lines and has a matching event" },
  "gate-triage": { kind: "schema", check: "parseGateTriageResult validates the triage result" },
};

/**
 * The reason a task may not be accepted on this evidence, or null. `passed` is the stages that passed for it; at least one of
 * them must be decided by code. Opinion stages passing alone (a critic that said «approve») prove nothing about the work.
 */
export function acceptanceProofGap(passed: Iterable<StageId>): string | null {
  const stages = [...new Set(passed)];
  if (stages.some((stage) => !isAdvisoryProof(STAGE_PROOF[stage]))) return null;
  return stages.length
    ? `acceptance_without_code_proof: only advisory stages passed (${stages.join(", ")}); a model's opinion cannot accept a task on its own`
    : "acceptance_without_code_proof: no stage passed";
}
