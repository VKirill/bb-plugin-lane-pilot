import { z } from "zod";
import { settingOff, settingOn } from "@lane-pilot/models";
import type { CoverageFinding } from "./critique-coverage";
import { clipped, extractModelJson, REVIEW_READ_ONLY_LINE } from "@lane-pilot/workflow-engine";
import { PLAN_CRITIC_METHOD } from "./role-method";
import { demoteUncited } from "./citations";
import type { Citation } from "./citations";
import { taskBrief } from "./task-brief";
import { applyRubric, isVerdictShape, legacyDecisionToStatus, legacyOutputToVerdict, normalizeVerdictInput, rubricPromptLine, settleVerdict, statusToLegacyDecision, verdictSchema, verdictSummary, verdictSeverityToLegacy, withoutDecision } from "@lane-pilot/workflow-engine";
import type { Verdict, VerdictStatus } from "@lane-pilot/workflow-engine";

export const critiqueResultSchema = z.object({
  decision: z.enum(["approve", "changes_requested"]),
  summary: clipped(2000),
  findings: z.array(z.object({
    severity: z.enum(["info", "warning", "blocking"]),
    finding: clipped(1000),
    criterion: clipped(500),
  })).max(30),
}); // not .strict(): a key the schema does not know is dropped, not refused (hub 2026-10-30)

/**
 * What the stage keeps of a plan critique: the old shape (`decision`, `summary`, findings by weight; stats and replays read it)
 * and the unified verdict beside it. An answer in the old format is read and mapped: approve is pass, changes_requested is rework.
 */
export type CritiqueResult = Omit<z.infer<typeof critiqueResultSchema>, "findings"> & {
  findings: Array<z.infer<typeof critiqueResultSchema>["findings"][number] & { file?: string; line?: number; evidence?: string }>;
  status: VerdictStatus;
  verdict: Verdict;
  /** Critical or high findings read as medium because they named no file, no line or no quoted evidence. */
  demoted?: number;
};

export type CritiquePolicyDecision = { run:boolean; reason:string; score:number; writeTaskCount:number };

const REVIEW_LANES = new Set(["verify", "review", "night", "critique"]);

/** Apply the pinned upstream run policy to strict TaskV2/run-v2 inputs. */
export function shouldRunPlanCritique(input: {
  taskRisk: string;
  tasks: readonly { lane?: string }[];
  minScore?: unknown;
  minWriteTasks?: unknown;
  onHighRisk?: unknown;
}): CritiquePolicyDecision {
  const scoreByRisk: Record<string, number> = { low:2, medium:5, high:8, critical:10 };
  const score = scoreByRisk[input.taskRisk];
  if (score === undefined) throw new Error(`unsupported_task_risk:${input.taskRisk}`);

  const minScore = policyInteger(input.minScore, 7, 0, "plan_critique.min_score");
  const minWriteTasks = policyInteger(input.minWriteTasks, 3, 1, "plan_critique.min_write_tasks");
  const onHighRisk = policyBoolean(input.onHighRisk, true, "plan_critique.on_high_risk");
  const writeTaskCount = input.tasks.filter((task) => !REVIEW_LANES.has(task.lane?.trim().toLowerCase() || "write")).length;

  if (score >= minScore) return { run:true, reason:`score ${score}>=${minScore}`, score, writeTaskCount };
  if (writeTaskCount >= minWriteTasks) return { run:true, reason:`${writeTaskCount} write tasks>=${minWriteTasks}`, score, writeTaskCount };
  if (onHighRisk && (input.taskRisk === "high" || input.taskRisk === "critical")) {
    return { run:true, reason:`risk=${input.taskRisk}`, score, writeTaskCount };
  }
  return { run:false, reason:`score ${score}<${minScore} and ${writeTaskCount} write tasks<${minWriteTasks}`, score, writeTaskCount };
}

function policyInteger(value: unknown, fallback: number, minimum: number, key: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${key} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function policyBoolean(value: unknown, fallback: boolean, key: string): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (settingOn(value)) return true;
  if (settingOff(value)) return false;
  throw new Error(`${key} must be a boolean`);
}

/**
 * The plan critic reads the code itself (owner 2026-11-08): it runs in the project checkout, and a critic that saw only the PM's summary
 * of the code could not catch a plan that does not fit it. Reading only: the checkout is the owner's, and a change there counts as the task's.
 */
export const PLAN_CRITIC_READ_LINE = `You are running in the project checkout. Before the verdict, open the files the plan changes and the files in read_first, and grep for the names the plan relies on (functions, types, settings, commands), so you judge the plan against the code as it is, not as the plan describes it. ${REVIEW_READ_ONLY_LINE}`;

/** The PM reader's open questions (its JSON `openQuestions`); its summary of the code is not sent, the critic reads the code. */
function openQuestions(pmReadContext: string | undefined): string[] {
  try {
    const parsed = JSON.parse(pmReadContext ?? "") as { openQuestions?: unknown };
    return Array.isArray(parsed.openQuestions) ? parsed.openQuestions.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, 8) : [];
  } catch { return []; }
}

export function critiquePrompt(input: { plan:string; task:unknown; agent?:string; pmReadContext?:string; structuralFindings?:readonly CoverageFinding[] }): string {
  return [
    `You are ${input.agent?.trim() || "the independent plan-critique stage"} for a bounded software task.`,
    `Review the plan against the task contract and the code. ${PLAN_CRITIC_READ_LINE}`,
    ...PLAN_CRITIC_METHOD,
    "Answer with one JSON object and nothing else: no text before or after it. Keys: status (\"pass\", \"rework\" or \"block\"), summary (string, at most 2000 characters), findings (at most 30 objects, each with file, line, severity \"critical\", \"high\", \"medium\", \"low\" or \"info\", evidence (at most 2000 characters: the quoted line or the contract field you looked at), and optionally finding (at most 1000: what is wrong and the fix), criterion (at most 500: the acceptance line or rule it breaks)), evidence (string, what you examined and how, at most 4000 characters). Other keys are ignored.",
    rubricPromptLine("plan"),
    "pass: the plan can go to a writer. rework: a concrete missing, contradictory, unsafe, or unverifiable requirement that the PM fixes by editing the plan or the contract and sending it again; its findings are critical or high. block: the task cannot be saved by editing, because it asks for something destructive or unsafe that the owner must decide, or contradicts its own objective; use it only then. Do not invent criteria. A critical or high finding counts only with a file, a line and quoted evidence; without them it is read as medium.",
    "A verification command that is not focused on this task (a whole-suite run) or that runs a suite the project marks sandbox-unsafe is an unverifiable requirement: rework, severity high, with the focused command as the fix.",
    "Verification commands run in a check sandbox that mounts the workspace writable except .git/, .agents/ and .cls/ (read-only for every check): a build, a page regeneration or any command that writes there is a plan step the writer runs in its session, never a verification command, and must not be demanded as one; a verification command that would write there is an unverifiable requirement (rework, with a check that writes nothing there as the fix).",
    ...(input.structuralFindings?.length ? ["Deterministic structural findings (independently assess each; info findings are non-blocking):",JSON.stringify(input.structuralFindings)] : []),
    "TASK BRIEF:", taskBrief(input.task, { fields: ["title", "objective", "risk", "acceptance", "invariants", "out_of_scope", "read_first", "expected_outputs", "owns_paths", "never_touch", "depends_on", "test_removals", "verification"] }),
    ...(openQuestions(input.pmReadContext).length ? ["Questions the PM's reader of the code left open; answer each from the code before the verdict:", openQuestions(input.pmReadContext).map((q) => `- ${q}`).join("\n")] : []),
    "CANONICAL PLAN:", input.plan,
  ].join("\n\n");
}

/** `cites` is the code check on the findings' files (inputCitations): a serious finding that names a file the critic never saw counts as medium. */
export function parseCritique(output: string, cites?: Citation): CritiqueResult {
  const raw = normalizeVerdictInput(extractModelJson(output));
  if (isVerdictShape(raw)) {
    const cited = demoteUncited(verdictSchema.parse(withoutDecision(raw)), cites);
    const settled = settleVerdict(applyRubric(cited.verdict, "plan"), "plan");
    const { verdict } = settled, demoted = settled.demoted + cited.demoted;
    return {
      decision: statusToLegacyDecision(verdict.status),
      summary: verdictSummary(verdict),
      findings: verdict.findings.map((row) => ({
        severity: verdictSeverityToLegacy(row.severity), finding: row.finding ?? row.evidence.slice(0, 1000), criterion: row.criterion ?? row.dimension ?? "plan review",
        file: row.file, ...(row.line ? { line: row.line } : {}), evidence: row.evidence,
      })),
      status: verdict.status, verdict, ...(demoted ? { demoted } : {}),
    };
  }
  const legacy = critiqueResultSchema.parse(raw);
  const status = legacyDecisionToStatus(legacy.decision);
  return { ...legacy, status, verdict: legacyOutputToVerdict({ status, summary: legacy.summary, findings: legacy.findings }) };
}
