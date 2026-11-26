import { ROLE_IDS, roleRowOf, SCOUT_SEAT_ROLES } from "@lane-pilot/models";
import type { NodeForm } from "@lane-pilot/contracts";
import { READ_ONLY_LINE, wfRunIdemParent } from "@lane-pilot/workflow-engine";
import type { ContractNode, Field, StepContext, Usage } from "@lane-pilot/workflow-engine";
import { LEAD_ID } from "../../../contracts";
import { employeeView, isEmployeeSpecialist } from "../../../contracts/employee-manifest";
import { ROLE_PROFILES, type ExtraAccess, type HelperRole } from "../../../contracts/helper-context";
import { MAIN_AGENT_ID, isCustomAgentId, type ChainRuntime } from "../../../contracts/server";
import { SPECIALIST_ROLES } from "../../../critique/server";
import { mentionContext } from "../../../native-agent";
import { specialistProfileAccess, storeNativeSelection } from "../../../native-agent/server";
import type { LanePilotDatabase } from "../../../storage";
import { phaseFolder } from "../../models/planning-files";
import type { HelperModelResolution } from "../../models/helper-model-provenance";
import type { RepoGuardDetail } from "./workflow-repo-guard";

export { ROLE_PROFILES, employeeView };

/**
 * Role specifications, phase write rules, and helper request/result types for workflow agent steps.
 */
export type RoleSpec = { helper: HelperRole; metadata: string; specialist?: string; readOnly: boolean; editable: (file: string) => boolean };
// Lane Pilot's own harness folders (harness.ts) are written by its night editor in the same checkout, not by a helper: magicseo replay
// 2026-10-31, the designer failed repo_edited on `.lane-pilot/harness-edit/…`. `.lane-pilot/workflows/` stays a helper's edit (a graph is published there).
const BASE_ALLOWED = (file: string) => file.startsWith(".bb/chats/") || file.startsWith(".lane-pilot/harness/") || file.startsWith(".lane-pilot/harness-edit/");
const ROLE_MAP: Record<string, HelperRole> = {
  analyst: "analyst", planner: "planner", auditor: "auditor", debugger: "debugger", "plan-critic": "plan-critic", "code-critic": "code-critic",
  triager: "gate-triage", "gate-triage": "gate-triage", memory: "memory-maintainer", "memory-maintainer": "memory-maintainer",
  "browser-qa": "browser-qa", errand: "errand", "errand-computer": "errand", "errand-devops": "errand", "errand-research": "errand", "errand-browser": "errand",
  "api-recon": "api-recon", "pm-reader": "pm-reader", ...Object.fromEntries(SCOUT_SEAT_ROLES.map((seat) => [seat, "scout" as const])),
  writer: "writer", "code-repair": "code-repair", "night-fixer": "night-fixer", "specialist-reviewer": "specialist-reviewer",
  onboarder: "onboarder",
  "rules-analyzer": "rules-analyzer",
  "workspace-provisioner": "workspace-provisioner", lead: "lead", "workflow-architect": "workflow-architect",
  "harness-editor": "harness-editor", "harness-composer": "harness-composer", "harness-reflection": "harness-reflection",
};
/** A bundled specialist; any other `specialist:<id>` names an agent the owner created, which must exist when the step runs (`ownSpecialist`). */
export const isBundledSpecialist = (id: string): boolean => (SPECIALIST_ROLES as readonly string[]).includes(id) || isEmployeeSpecialist(id) || id === LEAD_ID;

/** The graph a schedule of kind agent runs (workflows/agent-routine.json). */
export const AGENT_ROUTINE = "agent-routine";

/** Roles Jev may never cheapen: judges, critics, the planner/PM chair (a code writer is not a table row at all, so it is never touched). */
const NO_DOWNGRADE = new Set(["plan-critic", "specialist-reviewer", "code-critic", "auditor", "debugger", "triager", "rules-analyzer", "planner", "pm", "dev-orchestrator", "writer", "analyst", "worker", ...SCOUT_SEAT_ROLES]);
export function downgradableRole(role: string): boolean {
  const row = roleRowOf(role);
  return !NO_DOWNGRADE.has(role) && ROLE_IDS.includes(row) && !NO_DOWNGRADE.has(row);
}

const SP_ENGINE_OWNED = /^\.agents\/(?:seo|marketing)\/(?:charter\.json|questions\.ext\.json|memory(?:\/|$))/;

export function roleSpec(role: string): RoleSpec {
  // Graphs name an employee either as `specialist:game-dev` or as the bare id (`game-dev` in roblox-asset).
  const named = role.startsWith("specialist:") ? role.slice("specialist:".length) : role;
  const specialist = role.startsWith("specialist:") || isEmployeeSpecialist(role) || role === LEAD_ID ? named : null;
  // The lead («Штурман», workflows/lead-tick.json): its own bundled profile and row of the role table; it reads, proposes and edits nothing of the repository.
  if (specialist === LEAD_ID) return { helper: `specialist:${LEAD_ID}` as HelperRole, metadata: LEAD_ID, specialist: LEAD_ID, readOnly: true, editable: BASE_ALLOWED };
  if (specialist && (isBundledSpecialist(specialist) || (MAIN_AGENT_ID.test(specialist) && isCustomAgentId(specialist)))) {
    // design-lead keeps the design canon: DESIGN.md at the root and in an app's docs (the specialist's own prompt says the same).
    const designCanon = (file: string) => specialist === "design-lead" && (file === "DESIGN.md" || file.endsWith("/DESIGN.md"));
    return { helper: `specialist:${specialist}` as HelperRole, metadata: "specialist", specialist, readOnly: false, editable: (file) => !SP_ENGINE_OWNED.test(file) && (BASE_ALLOWED(file) || file === ".agents" || file.startsWith(".agents/") || designCanon(file)) };
  }
  const helper = ROLE_MAP[role] ?? "analyst";
  return { helper, metadata: helper, readOnly: true, editable: BASE_ALLOWED };
}

/**
 * The stage workflows of a phase (lp.analyze, lp.plan, lp.draw, lp.close, lp.review, retrospective) are started by the phase driver under the
 * key `phase:<phaseId>:<kind>:…` (auto-stages.ts). The read-only helper that authors a stage's documents (below) may write the folders of its
 * own role, where those documents live; every other edit is still `repo_edited` (live ph_26f65b142d: the stages failed on their own files).
 */
const PHASE_RUN_KEY = /^phase:(ph_[0-9a-z]+):/;

/** The phase a workflow run belongs to, from its key or the key of the run it is a subworkflow of; null for any other run. */
export function phaseOfWorkflowRun(db: LanePilotDatabase, runId: string): string | null {
  let current: string | null = runId;
  for (let hop = 0; current && hop < 8; hop += 1) {
    const row = wfRunIdemParent(db, current);
    const phaseId = row?.idem_key ? PHASE_RUN_KEY.exec(row.idem_key)?.[1] : undefined;
    if (phaseId) return phaseId;
    current = row?.parent_run_id ?? null;
  }
  return null;
}

/**
 * The authors of a phase stage's documents and the folders each may write. A judge (the plan critic, the code critic, the auditor)
 * writes none: it must not edit what it judges (Matvey Maslov: the candidate cannot change the judge, nor the judge the candidate).
 * The planner writes the phase's folder (its PLAN.md); the analyst the phase's folder too (its CONTEXT.md). The drawing is the
 * design-lead specialist's own rule, not this one.
 */
const PHASE_AUTHORS: Partial<Record<HelperRole, "phase" | "plans">> = { analyst: "phase", planner: "plans" };
export const isPhaseAuthor = (helper: HelperRole): boolean => helper in PHASE_AUTHORS;
// The planner no longer writes the shared .agents/plans/ (docs/task-folder.md): a phase's plan lives in its own folder, and a task's in its home.
const phaseFolders = (phaseId: string, helper: HelperRole): string[] => PHASE_AUTHORS[helper] ? [`${phaseFolder(phaseId)}/`] : [];

/** Whether a stage helper of this phase may write the file: the folders of its own role, if it is an author. */
export const phaseWritable = (phaseId: string, helper: HelperRole) => (file: string): boolean =>
  !file.split("/").includes("..") && phaseFolders(phaseId, helper).some((folder) => file.startsWith(folder));

/** The read-only line of a phase stage's prompt, with the folders the stage writes (the brief said «write nothing» while the check expected files). */
export const phaseWriteNote = (prompt: string, phaseId: string, helper: HelperRole): string => {
  const line = `Write the step's documents only under ${phaseFolders(phaseId, helper).join(" and ")}; do not change, commit or push any other file of the repository (reports and scratch files go under .bb/chats/ or /tmp).`;
  return prompt.includes(READ_ONLY_LINE) ? prompt.replace(READ_ONLY_LINE, line) : `${prompt}\n\n${line}`;
};

export type HelperRequest = {
  rt: ChainRuntime;
  workflowRunId: string; stepKey: string; nodeId: string; spawnKey: string;
  /** The workflow the node belongs to: with `nodeId` it is the key of the owner's model override of the step. */
  workflowId?: string;
  role: string; title: string;
  /** The whole first message (or, into a running thread, the follow-up). */
  prompt: string;
  fields: readonly Field[];
  provider?: string; model?: string; reasoning?: string; serviceTier?: "default" | "fast"; form?: NodeForm;
  /** The node itself names the model: it wins over the role's row, and a provider loss does not move the role. */
  nodeModel?: true;
  /** Set by `withResolvedModel`: provider and model are the table's answer, not a pin. `run` resolves a request that lacks it, so no helper spawns on a guess. */
  resolved?: true;
  /** Set by `withResolvedModel`; absent for callers that already resolved their request and for continued threads. */
  modelResolution?: HelperModelResolution;
  skills?: readonly string[];
  /** BB plugins and MCP servers the step's session may load on top of its role's. */
  plugins?: readonly string[]; mcp?: readonly string[];
  /** Same session: send into this thread (a step that goes on in the earlier helper's session). */
  intoThread?: string | null;
  /** The step's declared risk (`$inputs.risk` of the graph), for the model downgrade guard: high/critical never cheapens. */
  risk?: string;
  /** The step contract (`produces`, `gates`): an answer that breaks it gets the same one repair turn as an answer without a JSON block. */
  contract?: ContractNode;
  /** The files the step's start packet points at (the `files` of its PacketPlan): the executor writes them on the PM checkout, `run` writes the same relative paths where the helper actually reads them (a placed specialist's own folder or host, a continued thread's environment). */
  packetFiles?: ReadonlyArray<{ path: string; text: string }>;
  /** Where `packetFiles` already are (the executor's PM checkout): `run` skips materializing again when the helper's workspace is the same place. */
  packetFilesAt?: { hostId: string; path: string };
  signal?: AbortSignal;
  checkTurn?: StepContext["checkTurn"];
  trackChild?: StepContext["trackChild"];
};
/** What the step spent: tokens and the price of them, from the thread's own usage events (the budget of the run counts these). */
export type HelperResult = { threadId: string; output: Record<string, unknown>; text: string; usage?: Usage & { tokens: number; costUsd: number; unknown?: true };
  /** Read-only helpers only: `repoGuard` lands in the step's `receipt_json.detail` for the goal audit. */
  detail?: { repoGuard?: RepoGuardDetail; answered?: { providerId: string; model: string } } };

export class HelperFailure extends Error {
  /** What the helper spent before it failed (`run` sets it): the engine adds it to the run, so a failed step is not free. */
  usage?: Usage & { tokens: number; costUsd: number; unknown?: true };
  /** The code leads the message: it is what a run's step error shows. */
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}

/** What a step asks its session to load besides the role's own: the session policy of the spawn adds exactly these. */
export function extraAccessOf(request: Pick<HelperRequest, "skills" | "plugins" | "mcp">): ExtraAccess | undefined {
  const extra: ExtraAccess = {};
  if (request.skills?.length) extra.skills = [...request.skills];
  if (request.plugins?.length) extra.bbPlugins = [...request.plugins];
  if (request.mcp?.length) extra.mcpServers = [...request.mcp];
  return Object.keys(extra).length ? extra : undefined;
}

/**
 * The profile of an agent the owner created, named by a node's `specialist:<id>` role: the stored selection a chat started with that agent
 * gets (its prompt), the skills and MCP servers its profile asks for, its model and effort. An id that is no agent of the owner stops the
 * step with a clear code (the validator says the same when the draft is saved).
 */
export async function ownSpecialist(rt: ChainRuntime, id: string, options?: { openEnded?: boolean }): Promise<{ marker: string; access: ExtraAccess }> {
  const row = (await rt.ctx.ownedAgents())[id];
  if (!isBundledSpecialist(id) && (!row || row.compiledCorrupt)) throw new HelperFailure("unknown_specialist", `there is no agent "${id}" (deleted or renamed?): a node with role specialist:${id} needs a bundled specialist or an agent you created (bb lane-pilot agents list --custom)`);
  const { selection } = await storeNativeSelection(rt.ctx, { projectId: rt.projectId, agentId: id, ...(rt.runId ? { parentRunId: rt.runId } : {}) });
  return { marker: mentionContext(selection), access: specialistProfileAccess(id, row, options) };
}
