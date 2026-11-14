import type { Row } from "./workflow-chain-runtime";
import { str } from "./workflow-chain-runtime";
import type { Field, GraphNode } from "@lane-pilot/workflow-engine";
import { sha256Hex } from "@lane-pilot/kit";

// ---------------------------------------------------------------- code tasks of a chain

export const TERMINAL_ATTEMPT = ["accepted", "blocked", "canceled"];
export const safeId = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";

/** The task standard (the Tasks board): a workflow's own task fills what its contract leaves out, so the contract lint never refuses it. */
/** The short path's code critic: only the medium writer of issue-quick. quick stays off; a full contract still conflicts with fixed quick. */
export function shortPathCriticDefault(workflowId: string, mode: string): "medium" | undefined {
  return workflowId === "issue-quick" && mode === "standard" ? "medium" : undefined;
}

/**
 * The prefix of a graph's code tasks: one per graph run, so sibling tasks of a plan know each other's names (owner's rule, ТЗ 4д.1).
 * It was per step (`runId|stepKey`), and every branch of a fan-out had its own: a dependent looked for «T7», found no such task and
 * blocked after two minutes, or found another run's «T7» (audit plan-split 1.6-ж). A revisit of the same id becomes `<id>.2`.
 */
export const graphTaskStem = (workflowRunId: string): string => sha256Hex(`${workflowRunId}|tasks`).slice(0, 8);
export const graphTaskId = (stem: string, id: string): string => `w${stem}-${safeId(id)}`;
/**
 * depends_on rewritten with the same prefix as the ids: a name becomes its sibling's graph id, unless that sibling does not exist yet
 * while a task of exactly that name was already dispatched in the Lane Pilot run (a PM task the graph builds on) — then it stays.
 */
export const graphDependsOn = (stem: string, dependsOn: unknown, dispatched: (id: string) => boolean): string[] =>
  asList(dependsOn).map(String).filter(Boolean).map((dep) => {
    if (/^w[0-9a-f]{8}-/.test(dep)) return dep;
    const sibling = graphTaskId(stem, dep);
    return dispatched(sibling) || !dispatched(dep) ? sibling : dep;
  });

export const withTaskStandard = (contract: Row, key: string): Row => ({ ...withContractDefaults(contract),
  display_title: str(contract.display_title).trim() || str(contract.title).slice(0, 60), kind: str(contract.kind) || "feature", area: str(contract.area).trim() || `workflow:${safeId(key)}` });

const RISKS = ["low", "medium", "high", "critical"];
const VERIFY = ["none", "smoke", "tests"];
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);
/**
 * The structural fields of task-v2 a planner agent leaves out, filled the same way every time: a planner that wrote the work right but
 * not the envelope (schema_version, lane, risk, the empty lists, checks as plain command strings) was refused three times by the lint
 * and the small-task graph stopped for the owner (live issue-quick wfrun_8adbad9a…, 2026-10-25). What the planner did write wins.
 */
/**
 * The command of a check a planner wrote as prose: «`npm test` prints `0`» is the first code span, not the sentence — the shell ran the
 * backticks as command substitution and the check failed with exit 127 (live issue-quick, 2026-10-25). A plain string is the command.
 */
export function commandOf(check: string): string {
  const span = /`([^`]+)`/.exec(check);
  return (span ? span[1]! : check).trim();
}

/** The verification budget a planner's check gets when it names none: the PM's normal tasks run checks for 40 minutes. */
export const PLAN_CHECK_TIMEOUT_SEC = 2400;

export function withContractDefaults(input: Row): Row {
  // `covers` (the requirement and decision ids a phase's piece carries out) belongs to the plan's piece, not to the strict task-v2.
  const { covers: _covers, ...contract } = input;
  const files = asList(contract.files).map((file) => (file && typeof file === "object" ? str((file as Row).path) : "")).filter(Boolean);
  const owns = asList(contract.owns_paths).map(String);
  const outputs = asList(contract.expected_outputs).map(String);
  return {
    ...contract,
    schema_version: 2,
    risk: RISKS.includes(str(contract.risk)) ? str(contract.risk) : "medium",
    lane: str(contract.lane).trim() || "default",
    read_first: asList(contract.read_first).map(String),
    interfaces: asList(contract.interfaces).map(String),
    invariants: asList(contract.invariants).map(String),
    out_of_scope: asList(contract.out_of_scope).map(String),
    never_touch: asList(contract.never_touch).map(String),
    depends_on: asList(contract.depends_on).map(String),
    owns_paths: owns.length ? owns : files,
    expected_outputs: outputs.length ? outputs : files.length ? files : owns.filter((path) => !/[*?]/.test(path)),
    acceptance: asList(contract.acceptance).map((item) => (typeof item === "string" ? item : JSON.stringify(item))),
    verify: VERIFY.includes(str(contract.verify)) ? str(contract.verify) : "tests",
    verification: asList(contract.verification).map((check) => {
      const row = (typeof check === "string" ? { command: commandOf(check), cwd: "." } : check) as Row;
      // A planner never writes timeout_sec, and without one the sandbox kills the check at 120 s — under a full suite the task
      // cannot ever go green (live issue-quick, 2026-11-02). The project's normal verification budget is 40 minutes.
      return row.timeout_sec === undefined || row.timeout_sec === null ? { ...row, timeout_sec: PLAN_CHECK_TIMEOUT_SEC } : row;
    }),
    objective: str(contract.objective).trim() || str(contract.title).trim(),
    // The criteria are strings; a planner that wrote them like its checks ({command}) meant the command.
    ...(contract.convergence && typeof contract.convergence === "object" ? { convergence: { ...(contract.convergence as Row),
      criteria: asList((contract.convergence as Row).criteria).map((item) => (item && typeof item === "object" ? str((item as Row).command) || JSON.stringify(item) : String(item))) } } : {}),
  };
}

export type HelperUsage = { tokens: number; costUsd: number; unknown?: true };
export type LpTaskNode = Extract<GraphNode, { type: "lp-task" }>;

export const taskContractFields = (): Field[] => [
  { name: "contract", type: "object", required: true, ref: "Task", description: "one task-v2 contract object (objective, read_first, owns_paths, never_touch, acceptance, verification ...)" },
  { name: "handoff", type: "string", required: true },
];
