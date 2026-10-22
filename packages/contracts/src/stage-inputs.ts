import type { StageId } from "./stage-contract";

/**
 * What each stage of a task reads, and which part of the process head each one depends on (atlas delta 3.2 / 3.3, D0-2 / D1-1).
 * A stage receipt already stores the hash of its input (`lane_pilot_stage_receipt.input_sha256`); these registries make that hash
 * *explainable*: when one thing changes, which receipts are stale and which can be reused as they are. Exhaustive over STAGE_IDS like
 * STAGE_PROOF: a new stage does not compile until it declares both.
 *
 * Used by the night loop's re-run (src/rooms/wall/rerun.ts). The return-to-stage operation with added context builds on the same two
 * registries: its «stale / reused» record is `affectedFrom(...)`.
 */

/** The things a stage can read. `contract.*` are fields of the task contract; the rest are records beside it. */
export const STAGE_INPUT_KEYS = [
  "contract.objective", "contract.acceptance", "contract.verification", "contract.owns_paths", "contract.read_first", "contract.expected_outputs",
  "plan_text", "base_sha", "notes", "candidate_diff", "pm_read_summary",
] as const;
export type StageInputKey = (typeof STAGE_INPUT_KEYS)[number];

export const STAGE_INPUTS: Record<StageId, readonly StageInputKey[]> = {
  "pm-read": ["contract.read_first"],
  "plan-critique": ["contract.objective", "contract.acceptance", "contract.verification", "contract.owns_paths", "contract.expected_outputs", "plan_text", "pm_read_summary", "notes"],
  "run-gate": ["base_sha"],
  "specialist-review": ["contract.objective", "contract.owns_paths", "plan_text", "pm_read_summary", "notes"],
  "writer-agent": ["contract.objective", "contract.acceptance", "contract.owns_paths", "contract.read_first", "contract.expected_outputs", "plan_text", "base_sha", "notes"],
  "verification": ["contract.verification", "candidate_diff"],
  "code-critique": ["candidate_diff", "contract.acceptance", "plan_text"],
  "plan-fact": ["candidate_diff", "contract.acceptance", "plan_text"],
  "acceptance-receipt": ["contract.acceptance", "contract.verification", "candidate_diff"],
  "browser-qa": ["candidate_diff"],
  "docs-maintenance": [], "onboarding-preview": [], "onboarding-apply": [], "memory-maintenance": [], "project-life": [], "night-review": [], "night-fix": [],
  "workspace-status": [], "opencode-telemetry": [], "gate-triage": [],
};

/** The parts of the process head (what runs a task, as opposed to the task): a change to one of them can make a stage's verdict different. */
export const HEAD_PARTS = ["pm_read_settings", "plan_critic", "code_critic", "lint", "gates", "plan_fact", "writer_harness", "rules", "writer_key", "memory", "stage_prompts"] as const;
export type HeadPart = (typeof HEAD_PARTS)[number];

export const STAGE_HEAD_DEPS: Record<StageId, readonly HeadPart[]> = {
  "pm-read": ["pm_read_settings"],
  "plan-critique": ["plan_critic", "lint"],
  "run-gate": ["gates"],
  "specialist-review": ["plan_critic"],
  "writer-agent": ["writer_harness", "rules", "writer_key", "memory", "stage_prompts"],
  "verification": ["gates"],
  "code-critique": ["code_critic"],
  "plan-fact": ["plan_fact"],
  "acceptance-receipt": ["gates", "plan_fact"],
  "browser-qa": ["gates"],
  "docs-maintenance": [], "onboarding-preview": [], "onboarding-apply": [], "memory-maintenance": [], "project-life": [], "night-review": [], "night-fix": [],
  "workspace-status": [], "opencode-telemetry": [], "gate-triage": [],
};

/** The stages of one task in the order they run. The writer's candidate exists after `writer-agent`; everything after it judges that candidate. */
export const TASK_STAGE_ORDER = ["pm-read", "plan-critique", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"] as const satisfies readonly StageId[];
export type TaskStage = (typeof TASK_STAGE_ORDER)[number];
/** The stages that judge a saved candidate: a change to the judge re-runs them on the stored diff, without a writer. */
export const JUDGE_STAGES: readonly TaskStage[] = ["verification", "code-critique", "plan-fact", "acceptance-receipt"];
/** The stages Lane Pilot can restart in place today (stability's parked restart: `reopenWriterStages` + a resumed writer). */
export const RESTARTABLE_STAGES: readonly TaskStage[] = ["writer-agent", "verification", "acceptance-receipt"];

export type ReceiptSummary = { stage: string; state: string; inputSha256: string };
export type Affected = {
  /** The earliest stage that must run again; null when every stage of the chain can be kept. */
  from: TaskStage | null;
  reused: TaskStage[];
  stale: Array<{ stage: TaskStage; why: string }>;
  /** `rejudge`: the writer's candidate is kept and only the judging stages run; `rerun`: from `from` on, including the writer. */
  mode: "rejudge" | "rerun" | "none";
};

/**
 * Which stages of a task must run again after something changed. A stage is stale when (a) it did not pass, (b) a changed head part is among
 * its `STAGE_HEAD_DEPS`, (c) a changed input key is among its `STAGE_INPUTS`, or (d) the hash of its input, recomputed now, differs from the
 * receipt's. The earliest stale stage starts the re-run and everything from it on is stale too (a later stage reads the earlier one's output).
 * When every stale stage is a judge and the writer's receipt is intact, the mode is `rejudge`.
 */
export function affectedFrom(input: {
  receipts: readonly ReceiptSummary[];
  headParts?: readonly HeadPart[];
  changedInputs?: readonly StageInputKey[];
  /** The input hash each stage would have now, where the caller can compute it. */
  currentInputSha?: Readonly<Partial<Record<string, string>>>;
  /** A stage the failure is known to have happened in; the re-run starts there at the latest. */
  failedStage?: string | null;
}): Affected {
  const heads = new Set(input.headParts ?? []);
  const keys = new Set(input.changedInputs ?? []);
  const why = new Map<TaskStage, string>();
  for (const stage of TASK_STAGE_ORDER) {
    const receipt = input.receipts.find((row) => row.stage === stage);
    if (!receipt) { why.set(stage, "no receipt"); continue; }
    if (!["passed", "skipped"].includes(receipt.state)) { why.set(stage, `receipt ${receipt.state}`); continue; }
    const head = STAGE_HEAD_DEPS[stage].find((part) => heads.has(part));
    if (head) { why.set(stage, `head part ${head} changed`); continue; }
    const key = STAGE_INPUTS[stage].find((item) => keys.has(item));
    if (key) { why.set(stage, `input ${key} changed`); continue; }
    const now = input.currentInputSha?.[stage];
    if (now && now !== receipt.inputSha256) why.set(stage, "its input hash changed");
  }
  if (input.failedStage && (TASK_STAGE_ORDER as readonly string[]).includes(input.failedStage) && !why.has(input.failedStage as TaskStage)) why.set(input.failedStage as TaskStage, "the failure happened here");
  const firstIndex = TASK_STAGE_ORDER.findIndex((stage) => why.has(stage));
  if (firstIndex < 0) return { from: null, reused: [...TASK_STAGE_ORDER], stale: [], mode: "none" };
  const from = TASK_STAGE_ORDER[firstIndex]!;
  const stale = TASK_STAGE_ORDER.slice(firstIndex).map((stage) => ({ stage, why: why.get(stage) ?? `after ${from}: it reads the output of an earlier stage` }));
  const judgeOnly = stale.every((row) => JUDGE_STAGES.includes(row.stage));
  return { from, reused: TASK_STAGE_ORDER.slice(0, firstIndex) as TaskStage[], stale, mode: judgeOnly ? "rejudge" : "rerun" };
}
