import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import { getRunSettingsScopes } from "../../storage";
import { writerExecutionSelection, findModelIn, isZcodeProvider, zcodeEnvironmentError } from "@lane-pilot/models";
import { jev } from "@lane-pilot/jev";
import { stepTrivialJudgment } from "@lane-pilot/jev/judgments/step-trivial";
import { providerLimitNotice } from "../../writer/server";
import { MAIN_AGENT_ID, ROLE_PROFILES, compileEffectiveMainAgent, employeeView, isCustomAgentId, isEmployeeSpecialist, mentionContext, placeEmployeeOn } from "../../native-agent";
import type { ExtraAccess, HelperRole } from "../../native-agent";
import { storeNativeSelection } from "../../native-agent/server";
import { redactKnown } from "@lane-pilot/kit";
import { READ_ONLY_LINE, agentPrompt, outputContract, parseAgentOutput } from "@lane-pilot/workflow-engine";
import { contractProblems, contractRepairPrompt, describeProblems, hasContractProblems } from "@lane-pilot/workflow-engine";
import type { ContractNode, ContractProblems } from "@lane-pilot/workflow-engine";
import type { AgentOutputError } from "@lane-pilot/workflow-engine";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { goalsBlock } from "@lane-pilot/workflow-engine";
import { planPacket } from "@lane-pilot/workflow-engine";
import type { PacketInput, PacketPlan } from "@lane-pilot/workflow-engine";
import { outputFields } from "@lane-pilot/workflow-engine";
import type { Field, GraphNode } from "@lane-pilot/workflow-engine";
import { roleMethod } from "../../critique";
import { phaseFolder } from "../../phase";
import type { LanePilotDatabase } from "../../storage";
import { folderEnvironment, fullAccessSpawn, hiddenPlacement, projectFolder, projectSources } from "../../core/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../runs/server";
import { detectRepoEdits, gitRepoStatus } from "../../verification/server";
import { SPECIALIST_GRAPH, SPECIALIST_ROLES, rememberSpecialistThread } from "../../critique/server";
import { findThreadsByMetadata, keyedSpawnSupported } from "../../core/server";
import { modelCatalogOf, noteProviderStartFailure, noteProviderStartSuccess, pmHostOf, providerBlockedForFolder, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, PROVIDER_FOLDER_BLOCK_TTL_MS } from "../../core/server";
import { modelTier, ROLE_IDS, ROLE_MODEL_OPTIONS, roleRowOf } from "@lane-pilot/models";
import { threadUsage } from "../../usage/server";
import { stringAt } from "../../core/server";
import { AUTHOR_ROWS, AUTHOR_ROW_IDS, DEFAULT_MODEL, pmAuthorOf, DEFAULT_PROVIDER, DEFAULT_REASONING } from "./workflow-agent-model";
import { outputText } from "../../writer/server";
import type { ServerCore } from "../../core/server";
import type { ChainRuntime } from "./workflow-runtime";

/**
 * The generic agent step of a workflow chain: a helper thread of the PM chat with the profile of the node's role (and the
 * skills, provider and model the node names), the node's prompt and data, a typed answer. The thread is found again by its
 * spawn key and plugin metadata after a reload (`lanePilotWorkflowRunId`, `lanePilotWorkflowStep`), so a lost spawn is not a second
 * helper. The same machinery runs a delegated action (a Telegram send, a skill script) and the router's model step.
 */

export type RoleSpec = { helper: HelperRole; metadata: string; specialist?: string; readOnly: boolean; editable: (file: string) => boolean };

const BASE_ALLOWED = (file: string) => file.startsWith(".bb/chats/");
const ROLE_MAP: Record<string, HelperRole> = {
  analyst: "analyst", planner: "planner", auditor: "auditor", debugger: "debugger", "plan-critic": "plan-critic", "code-critic": "code-critic",
  triager: "gate-triage", memory: "memory-maintainer", "browser-qa": "browser-qa", errand: "errand", "api-recon": "api-recon", council: "council-seat", "project-life": "project-life", "pm-reader": "pm-reader",
};

/** A bundled specialist; any other `specialist:<id>` names an agent the owner created, which must exist when the step runs (`ownSpecialist`). */
export const isBundledSpecialist = (id: string): boolean => (SPECIALIST_ROLES as readonly string[]).includes(id) || isEmployeeSpecialist(id);

/** The graph a schedule of kind agent runs (workflows/agent-routine.json). */
export const AGENT_ROUTINE = "agent-routine";

/** The model the schedule names for its agent (the task's `model`, `reasoning`, `serviceTier`): they stand over the settings, as the thread the old runner started did. */
function routineModel(inputs: Record<string, unknown>): Pick<HelperRequest, "model" | "reasoning" | "serviceTier"> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const reasoning = text(inputs.reasoning), tier = text(inputs.serviceTier);
  return {
    ...(text(inputs.model) ? { model: text(inputs.model) } : {}),
    ...(reasoning ? { reasoning } : {}),
    serviceTier: tier === "fast" ? "fast" : "default",
  };
}

/** What a node's `role` means here: the profile of the helper, the role in its metadata, and which repository files it may touch (none, except the notes of its own chat). */
const TIER_RANK: Record<string, number> = { light: 0, standard: 1, strong: 2 };
/** Roles Jev may never cheapen: judges, critics, the planner/PM chair (a code writer is not a table row at all, so it is never touched). */
const NO_DOWNGRADE = new Set(["plan-critic", "specialist-reviewer", "code-critic", "critic-tiebreak", "auditor", "council", "debugger", "triager", "rules-analyzer", "planner", "pm", "dev-orchestrator", "writer", "analyst", "worker"]);
export function downgradableRole(role: string): boolean {
  const row = roleRowOf(role);
  return !NO_DOWNGRADE.has(role) && ROLE_IDS.includes(row) && !NO_DOWNGRADE.has(row);
}

export function roleSpec(role: string): RoleSpec {
  // Graphs name an employee either as `specialist:game-dev` or as the bare id (`game-dev` in roblox-asset).
  const named = role.startsWith("specialist:") ? role.slice("specialist:".length) : role;
  const specialist = role.startsWith("specialist:") || isEmployeeSpecialist(role) ? named : null;
  if (specialist && (isBundledSpecialist(specialist) || (MAIN_AGENT_ID.test(specialist) && isCustomAgentId(specialist)))) {
    // design-lead keeps the design canon: DESIGN.md at the root and in an app's docs (the specialist's own prompt says the same).
    const designCanon = (file: string) => specialist === "design-lead" && (file === "DESIGN.md" || file.endsWith("/DESIGN.md"));
    return { helper: `specialist:${specialist}` as HelperRole, metadata: "specialist", specialist, readOnly: false, editable: (file) => BASE_ALLOWED(file) || file === ".agents" || file.startsWith(".agents/") || designCanon(file) };
  }
  const helper = ROLE_MAP[role] ?? "analyst";
  if (helper === "project-life") return { helper, metadata: "project-life", readOnly: false, editable: (file) => BASE_ALLOWED(file) || file.startsWith(".agents/") || file === "CHANGELOG.md" };
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
    const row = db.prepare("SELECT idem_key, parent_run_id FROM lane_pilot_wf_run WHERE id=?").get(current) as { idem_key: string | null; parent_run_id: string | null } | undefined;
    const phaseId = row?.idem_key ? PHASE_RUN_KEY.exec(row.idem_key)?.[1] : undefined;
    if (phaseId) return phaseId;
    current = row?.parent_run_id ?? null;
  }
  return null;
}

/**
 * The authors of a phase stage's documents and the folders each may write. A judge (the plan critic, the code critic, the auditor, a council
 * seat) writes none: it must not edit what it judges (Matvey Maslov: the candidate cannot change the judge, nor the judge the candidate).
 * The planner writes the phase's folder and the plans folder; the analyst only the phase's folder (its CONTEXT.md). The drawing is the
 * design-lead specialist's own rule, not this one.
 */
const PHASE_AUTHORS: Partial<Record<HelperRole, "phase" | "plans">> = { analyst: "phase", planner: "plans" };
export const isPhaseAuthor = (helper: HelperRole): boolean => helper in PHASE_AUTHORS;
const phaseFolders = (phaseId: string, helper: HelperRole): string[] => PHASE_AUTHORS[helper] === "plans" ? [`${phaseFolder(phaseId)}/`, ".agents/plans/"] : PHASE_AUTHORS[helper] ? [`${phaseFolder(phaseId)}/`] : [];

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
  provider?: string; model?: string; reasoning?: string; serviceTier?: "default" | "fast";
  /** Set by `withResolvedModel`: provider and model are the table's answer, not a pin. `run` resolves a request that lacks it, so no helper spawns on a guess. */
  resolved?: true;
  skills?: readonly string[];
  /** BB plugins and MCP servers the step's session may load on top of its role's. */
  plugins?: readonly string[]; mcp?: readonly string[];
  /** Same session: send into this thread (a step that goes on in the earlier helper's session). */
  intoThread?: string | null;
  /** The step's declared risk (`$inputs.risk` of the graph), for the model downgrade guard: high/critical never cheapens. */
  risk?: string;
  /** The step contract (`produces`, `gates`): an answer that breaks it gets the same one repair turn as an answer without a JSON block. */
  contract?: ContractNode;
  signal?: AbortSignal;
};
/** What the step spent: tokens and the price of them, from the thread's own usage events (the budget of the run counts these). */
export type HelperResult = { threadId: string; output: Record<string, unknown>; text: string; usage?: { tokens: number; costUsd: number; unknown?: true } };

/** The answer is JSON but breaks the step's contract. */
class ContractFailure extends Error { constructor(readonly problems: ContractProblems) { super(describeProblems(problems).join("; ")); } }

export class HelperFailure extends Error {
  /** What the helper spent before it failed (`run` sets it): the engine adds it to the run, so a failed step is not free. */
  usage?: { tokens: number; costUsd: number; unknown?: true };
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

/** A step's own extra access and an agent's profile as one: each group is the union, so both load. */
function withProfileAccess(step: ExtraAccess | undefined, profile: ExtraAccess | undefined): ExtraAccess | undefined {
  if (!profile) return step;
  const merged: ExtraAccess = {};
  for (const group of ["bbPlugins", "skills", "mcpServers"] as const) {
    const names = [...new Set([...(step?.[group] ?? []), ...(profile[group] ?? [])])];
    if (names.length) merged[group] = names;
  }
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * The profile of an agent the owner created, named by a node's `specialist:<id>` role: the stored selection a chat started with that agent
 * gets (its prompt), the skills and MCP servers its profile asks for, its model and effort. An id that is no agent of the owner stops the
 * step with a clear code (the validator says the same when the draft is saved).
 */
export async function ownSpecialist(rt: ChainRuntime, id: string): Promise<{ marker: string; access: ExtraAccess }> {
  const row = (await rt.ctx.ownedAgents())[id];
  if (!isBundledSpecialist(id) && (!row || row.compiledCorrupt)) throw new HelperFailure("unknown_specialist", `there is no agent "${id}" (deleted or renamed?): a node with role specialist:${id} needs a bundled specialist or an agent you created (bb lane-pilot agents list --custom)`);
  const { selection } = await storeNativeSelection(rt.ctx, { projectId: rt.projectId, agentId: id, ...(rt.runId ? { parentRunId: rt.runId } : {}) });
  // A bundled specialist's skills and servers come from its role profile; an agent of the owner brings its own.
  const profile = row && !isBundledSpecialist(id) ? compileEffectiveMainAgent(id, row) : { skills: [], mcpServers: [] };
  return { marker: mentionContext(selection), access: { ...(profile.skills?.length ? { skills: [...profile.skills] } : {}), ...(profile.mcpServers?.length ? { mcpServers: [...profile.mcpServers] } : {}) } };
}

/** Whether the thread shows a follow-up turn requested at or after `at`. */
async function followUpRequested(bb: ServerCore["bb"], threadId: string, at: number): Promise<boolean> {
  const listed = await listThreadEventsRaw(bb, { threadId, types: THREAD_WATCH_EVENT_TYPES, order: "desc", limit: "50" });
  return listed.ok && listed.events.some((event) => (event as { type?: unknown; createdAt?: unknown }).type === "client/turn/requested" && Number((event as { createdAt?: unknown }).createdAt) >= at);
}

/** A thread a helper step started or went on in, with the marker its own turns begin at (`since`, ms; none = from the thread's start) and the model it ran on. */
type TrackedThread = { id: string; since?: number; model?: string };

/**
 * What the threads of a step spent, summed: tokens and price of the turns since each one's marker. A thread whose usage cannot be read, or
 * that reports none, marks the sum `unknown` (the engine then holds the run to a time and step limit instead of counting the step free).
 */
async function spentBy(bb: ServerCore["bb"], threads: readonly TrackedThread[]): Promise<{ tokens: number; costUsd: number; unknown?: true }> {
  const rows = await Promise.all(threads.map((thread) => threadUsage(bb, thread.id, { ...(thread.since !== undefined ? { since: thread.since } : {}), ...(thread.model ? { fallbackModel: thread.model } : {}) }).catch(() => null)));
  const blind = rows.some((row) => !row || !row.known);
  return { tokens: rows.reduce((sum, row) => sum + (row?.tokens ?? 0), 0), costUsd: rows.reduce((sum, row) => sum + (row?.costUsd ?? 0), 0), ...(blind ? { unknown: true as const } : {}) };
}

export function createWorkflowAgents() {
  async function lookup(rt: ChainRuntime, request: HelperRequest): Promise<string | null> {
    // The spawn key makes `spawnKeyed` return the same thread; without the VK keys a thread is found by its metadata, or not at all.
    const found = await findThreadsByMetadata(rt.ctx.bb, { lanePilotWorkflowRunId: request.workflowRunId, lanePilotWorkflowStep: request.stepKey, lanePilotWorkflowSpawn: request.spawnKey }, rt.projectId);
    return found?.[0]?.id ?? null;
  }

  /**
   * One helper step. The model is always the table's answer (`withResolvedModel`) unless the request says it already is; the threads the step
   * touched are listed as they start, so what it spent is read from all of them once, whether it ends well or not.
   */
  async function run(asked: HelperRequest): Promise<HelperResult> {
    const tracked: TrackedThread[] = [];
    try {
      return await runTracked(asked.resolved ? asked : await withResolvedModel(asked), tracked);
    } catch (cause) {
      if (cause instanceof Error && tracked.length) (cause as HelperFailure).usage = await spentBy(asked.rt.ctx.bb, tracked);
      throw cause;
    }
  }

  async function runTracked(asked: HelperRequest, tracked: TrackedThread[]): Promise<HelperResult> {
    const { rt } = asked;
    const { bb, db, host } = rt.ctx;
    const spec = roleSpec(asked.role);
    // A `specialist:` role that names no specialist (a role taken from an input, a reserved id) must not quietly run as an analyst.
    if (asked.role.startsWith("specialist:") && !spec.specialist) throw new HelperFailure("unknown_specialist", `"${asked.role.slice("specialist:".length)}" is neither a bundled specialist nor an agent you created (bb lane-pilot agents list)`);
    // An agent the owner created runs with its own profile: its marker leads the first message, its skills and MCP servers join the session's.
    // A scheduled agent's routine runs a bundled specialist as itself too (its stored profile selection, as a chat started with it gets).
    const own = spec.specialist && (!isBundledSpecialist(spec.specialist) || asked.workflowId === AGENT_ROUTINE || asked.workflowId === SPECIALIST_GRAPH) ? await ownSpecialist(rt, spec.specialist) : null;
    // A phase stage writes its documents: its helper is told which folders it may write, the same ones the check below allows.
    const phaseId = spec.readOnly && isPhaseAuthor(spec.helper) ? phaseOfWorkflowRun(db, asked.workflowRunId) : null;
    const noted = phaseId ? phaseWriteNote(asked.prompt, phaseId, spec.helper) : asked.prompt;
    let request = { ...asked, prompt: own && !asked.intoThread ? `${own.marker}\n\n${noted}` : noted };
    // With a PM chat the helper reuses the chat's environment; with none, it works in the project's own first folder.
    let environment: ReturnType<typeof folderEnvironment> | { type: "reuse"; environmentId: string };
    let checkoutPath = "", checkoutHostId = "", chatSection: string | null = null;
    if (rt.pmThreadId) {
      const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
      chatSection = stringAt(pm, "sectionId");
      const environmentId = stringAt(pm, "environmentId");
      if (!environmentId) throw new HelperFailure("no_pm_environment", "the PM chat has no environment to run the helper in");
      const envObj = await bb.sdk.environments.get({ environmentId }).catch(() => null);
      checkoutPath = stringAt(envObj, "path") ?? "";
      checkoutHostId = stringAt(envObj, "hostId") ?? "";
      environment = { type: "reuse", environmentId };
    } else {
      const folder = await projectFolder(bb, rt.projectId);
      if (!folder) throw new HelperFailure("no_project_folder", "the project has no folder on a machine to run the helper in; add one to the project in BB");
      checkoutPath = folder.path;
      checkoutHostId = folder.hostId;
      environment = folderEnvironment(folder);
    }
    if (spec.specialist && employeeView(spec.specialist).machineAffinity !== "any") {
      const place = await placeEmployeeOn(bb, spec.specialist, await projectSources(bb, rt.projectId));
      if (place.mode === "folder") {
        environment = folderEnvironment({ hostId: place.hostId, path: place.path });
        checkoutPath = place.path;
        checkoutHostId = place.hostId;
      } else if (place.mode === "fallback") {
        bb.log?.warn(`Lane Pilot employee ${spec.specialist} stays in the current environment: ${place.reason}`);
      }
    }
    const before = checkoutPath && checkoutHostId ? await gitRepoStatus(host, checkoutHostId, checkoutPath) : null;

    async function spawn(req: HelperRequest): Promise<string> {
      const providerId = req.provider ?? DEFAULT_PROVIDER;
      const policy = requireHelperSpawn({ bb, db, projectId: rt.projectId, runId: rt.runId });
      // With no PM chat the helper is a hidden thread of the project. A scheduled agent's thread is one too even with a chat: as the chat's child its
      // end would wake whichever chat happened to be open (scheduled errands learned that, 2026-10-19); the schedule board keeps the report.
      const detached = !rt.runId || req.workflowId === AGENT_ROUTINE;
      const placement = !detached ? await helperChildPlacement({ bb, db, projectId: rt.projectId, runId: rt.runId!, role: spec.metadata, taskTitle: `${req.title}`.slice(0, 80) })
        : hiddenPlacement(rt.projectId, `Lane Pilot ${req.workflowId === AGENT_ROUTINE ? "scheduled agent" : "workflow"}: ${req.title}`, chatSection);
      const args = (placementArg: typeof placement, parent: Record<string, unknown>) => ({
        ...placementArg,
        ...requiredPolicyField(bb, policy, providerId, spec.helper, withProfileAccess(extraAccessOf(req), own?.access)),
        ...writerExecutionSelection(providerId, req.model ?? DEFAULT_MODEL, req.reasoning ?? DEFAULT_REASONING, req.serviceTier ?? "default"),
        prompt: req.prompt,
        environment,
        pluginMetadata: {
          role: spec.metadata, ...(spec.specialist ? { specialist: spec.specialist } : {}), ...(rt.origin ? { origin: rt.origin } : {}), spawnId: req.spawnKey, ...(rt.runId ? { lanePilotRunId: rt.runId } : {}), ...parent, helperMode: policy.mode,
          lanePilotWorkflowRunId: req.workflowRunId, lanePilotWorkflowStep: req.stepKey, lanePilotWorkflowSpawn: req.spawnKey, lanePilotWorkflowNode: req.nodeId,
        },
      } as Parameters<typeof fullAccessSpawn>[1]);
      let spawned: Awaited<ReturnType<typeof fullAccessSpawn>>;
      try {
        spawned = await fullAccessSpawn(bb, args(placement, !detached && rt.pmThreadId ? { parentPmThreadId: rt.pmThreadId } : {}));
      } catch (cause) {
        // lp.analyze hit this 12 times in 31 runs (G11): the phase's PM chat is gone or sealed, so the API refuses the
        // child. The work still needs doing — spawn hidden, without a parent, instead of failing the run.
        if (!detached && /parent thread is invalid/i.test(String(cause instanceof Error ? cause.message : cause))) {
          bb.log.warn(`Lane Pilot ${req.workflowId}: parent thread ${rt.pmThreadId} invalid, the helper spawns hidden instead`);
          spawned = await fullAccessSpawn(bb, args(hiddenPlacement(rt.projectId, `Lane Pilot workflow: ${req.title}`, chatSection), {}));
        } else throw cause;
      }
      const id = stringAt(spawned, "id");
      if (!id) throw new HelperFailure("thread_id_missing", "the helper thread was not created");
      // The PM asks for a specialist by its thread: the run behind it is looked up from here.
      if (req.workflowId === SPECIALIST_GRAPH) await rememberSpecialistThread(bb, req.workflowRunId, id);
      return id;
    }

    let threadId = request.intoThread ?? null;
    let sentAt: number | undefined;
    if (threadId) {
      // A re-run of the step after a reload must not send the task a second time: the send is recorded by the step key before it is made,
      // and a record whose follow-up BB shows as requested means it already went; a record without one (the process died in between) sends again.
      const sentKey = `workflow-send:${request.workflowRunId}:${request.stepKey}:${request.spawnKey}`;
      const earlier = await bb.storage.kv.get<{ at: number }>(sentKey).catch(() => null);
      if (earlier && await followUpRequested(bb, threadId, earlier.at)) sentAt = earlier.at;
      else {
        sentAt = Date.now();
        await bb.storage.kv.set(sentKey, { at: sentAt });
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: request.prompt, mentions: [] }] } as never);
      }
    } else {
      const startFolder = await projectFolder(rt.ctx.bb, rt.projectId).catch(() => null);
      const blockStore = bb.storage?.kv ?? { set: async () => undefined };
      try {
        threadId = await lookup(rt, request) ?? await spawn(request);
        // A start that went through clears this machine's observed folder block for the provider.
        await noteProviderStartSuccess(blockStore, startFolder?.hostId ?? null, request.provider ?? "", startFolder?.path ?? null);
      } catch (cause) {
        // The provider cannot start in this environment (its own session policy unenforceable, or its server 500s the
        // MCP listing — opencode2 under ~/Documents on macOS): one retry on the role's next provider, no PM involved.
        if (!/vk_required_session_policy_unenforceable|OpenCode[^\n]*\b500\b|\b500\b[^\n]*mcp/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
        const failed = request.provider ?? DEFAULT_PROVIDER;
        // An observed refusal in a ~/Documents folder on this machine is remembered: the pick stops offering it there
        // until a success or the block's TTL (provider.folder_block_ttl_ms, 6 h).
        await noteProviderStartFailure(blockStore, startFolder?.hostId ?? null, failed, startFolder?.path ?? null, cause instanceof Error ? cause.message : String(cause));
        const again = await withResolvedModel({ ...request, provider: undefined as never, model: undefined as never, reasoning: undefined as never, resolved: undefined as never }, { avoidProvider: failed }).catch(() => null);
        if (!again || again.provider === failed) throw cause;
        bb.log.warn(`workflow step ${request.stepKey}: ${failed} could not start (${cause instanceof Error ? cause.message.slice(0, 160) : String(cause)}); rerunning on ${again.provider}/${again.model}`);
        const fallback = { ...request, provider: again.provider, model: again.model, reasoning: again.reasoning, serviceTier: undefined, spawnKey: `${request.spawnKey}:start` };
        threadId = await lookup(rt, fallback) ?? await spawn(fallback);
        await noteProviderStartSuccess(blockStore, startFolder?.hostId ?? null, fallback.provider ?? "", startFolder?.path ?? null);
        request = { ...request, provider: fallback.provider, model: fallback.model };
      }
    }
    tracked.push({ id: threadId, ...(sentAt !== undefined ? { since: sentAt } : {}), ...(request.model ? { model: request.model } : {}) });

    const wait = async (since?: number) => {
      try {
        await waitThreadIdle(bb, threadId!, `workflow_${request.nodeId}`, undefined, since, () => (rt.ctx.isDisposed() ? "plugin_stopped" : request.signal?.aborted ? "aborted" : null));
      } catch (cause) {
        if (request.signal?.aborted) await bb.sdk.threads.stop({ threadId: threadId! }).catch(() => undefined);
        throw new HelperFailure("thread_failed", cause instanceof Error ? cause.message : String(cause));
      }
    };
    const read = async () => {
      const raw = (await bb.sdk.threads.output({ threadId: threadId! })).output;
      return redactKnown(typeof raw === "string" ? raw : outputText(raw));
    };

    // The ZCode app cannot take the work now (busy, text not visible, needs the foreground, signed out): the machine's state, handled below as a limit.
    let zcodeRefusal: string | null = null;
    try {
      await wait(sentAt);
    } catch (cause) {
      zcodeRefusal = isZcodeProvider(request.provider) && !request.intoThread ? zcodeEnvironmentError(cause instanceof Error ? cause.message : String(cause)) : null;
      if (!zcodeRefusal) throw cause;
    }
    let text = zcodeRefusal ? "" : await read();
    // A provider out of plan or quota answers with its notice and does no work (insights-post critic on acp-cursor, 2026-10-09:
    // «Upgrade your plan to continue»). The step runs once more in a fresh thread on another provider instead of failing the run.
    // Any provider, Claude included: the resolver answers with the failed provider taken out of the offer (the peer of the other family).
    const limit = zcodeRefusal ?? providerLimitNotice(text) ?? (isZcodeProvider(request.provider) ? zcodeEnvironmentError(text.length <= 400 ? text : null) : null);
    // A specialist or the architect runs as a Claude Code agent profile: another provider would refuse it (409), so its limit fails the step.
    if (limit && !request.intoThread && (request.role.startsWith("specialist") || request.role === "workflow-architect")) throw new HelperFailure("provider_limit", `the ${request.role} helper hit Claude's limit (${limit}); a specialist runs only on Claude Code, so it waits for the window to reset`);
    if (limit && !request.intoThread) {
      const failed = request.provider ?? DEFAULT_PROVIDER;
      const again = await withResolvedModel({ ...request, provider: undefined as never, model: undefined as never, reasoning: undefined as never, resolved: undefined as never }, { avoidProvider: failed }).catch(() => null);
      // Nothing else on offer (the answer is the failed provider again): the step fails with the limit notice, it does not run the same pair twice.
      if (!again || again.provider === failed) throw new HelperFailure("provider_limit", `${failed}/${request.model ?? ""} hit a provider limit (${limit}) and no other model family is on offer on this machine`);
      const fallback = { ...request, provider: again.provider, model: again.model, reasoning: again.reasoning, serviceTier: undefined, spawnKey: `${request.spawnKey}:limit` };
      rt.ctx.bb.log.warn(`workflow step ${request.stepKey}: ${request.provider}/${request.model} hit a provider limit (${limit}); rerunning on ${fallback.provider}/${fallback.model}`);
      // A fresh thread starts with the prompt: its first turn is the one to wait for, as for the first spawn.
      sentAt = undefined;
      threadId = await lookup(rt, fallback) ?? await spawn(fallback);
      tracked.push({ id: threadId, model: fallback.model });
      await wait();
      text = await read();
    }
    let output: Record<string, unknown> | null = null, problem = "", broken = false;
    for (let round = 0; round < 2 && !output; round += 1) {
      try {
        const parsed = parseAgentOutput(text, request.fields);
        const issues = request.contract ? contractProblems(request.contract, parsed) : null;
        if (issues && hasContractProblems(issues)) throw new ContractFailure(issues);
        output = parsed;
      } catch (cause) {
        broken = cause instanceof ContractFailure;
        problem = (cause as Error).message;
        if (round === 1) break;
        // One repair turn in the same thread: the answer is judged by its JSON and by the step's contract, so a missing block or a wrong shape is asked for, not guessed.
        const asked = Date.now();
        const repair = cause instanceof ContractFailure
          ? contractRepairPrompt(cause.problems, request.contract?.produces, outputContract(request.fields))
          : `Your last message ended without the required JSON block (${problem}).\n\n${outputContract(request.fields)}\nAnswer with that block now; do not redo the work.`;
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: repair, mentions: [] }] } as never);
        await wait(asked);
        text = await read();
      }
    }
    if (checkoutPath && checkoutHostId && before) {
      const after = await gitRepoStatus(host, checkoutHostId, checkoutPath);
      const editable = phaseId ? (file: string) => spec.editable(file) || phaseWritable(phaseId, spec.helper)(file) : spec.editable;
      const edited = after ? detectRepoEdits(before, after, editable) : [];
      if (edited.length) throw new HelperFailure("repo_edited", `the ${request.role} helper edited repository files it may not touch: ${edited.slice(0, 8).join(", ")}`);
    }
    if (!output) throw new HelperFailure(broken ? "artifact_invalid" : "output_invalid", broken ? `the ${request.role} helper's answer breaks the step's contract: ${problem}` : `the ${request.role} helper's final message could not be read: ${problem}`);
    // Read last, so the repair turn counts too. A thread whose usage cannot be read, or has no usage events, reports `unknown`:
    // the engine then holds the run to a time and step limit instead of letting a token or money budget pass unseen.
    // Every thread the step started counts (a provider-limit fallback leaves the first thread behind), each from its own start marker.
    return { threadId: threadId!, output, text, usage: await spentBy(bb, tracked) };
  }

  return { run };
}
export type WorkflowAgents = ReturnType<typeof createWorkflowAgents>;

// ---------------------------------------------------------------- the executor of an agent node

const GOAL_INPUTS = ["goal", "topic", "question", "query", "subject", "symptom", "idea", "task_ref"] as const;

/** Whether the node has a step contract, which is what puts its inputs into a start packet. */
const hasContract = (node: Extract<GraphNode, { type: "agent" }>): boolean => Boolean(node.produces?.length || node.consumes?.length);

/** The session the step goes on in, when it continues an earlier helper's. */
const intoThreadOf = (ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>): string | null =>
  ctx.input.via.mode === "same-session" && node.session !== "new" ? ctx.input.via.fromThreadId ?? null : null;

/**
 * The start packet of a step with a contract (W0): its goal, its inputs (the data of its edges and its `with`, the workflow's
 * inputs when it starts a session, the item of its branch, the previous step's handoff), what it must produce and its gates,
 * in about 3 KB. An input over a few hundred characters stands as a file and a summary (`files` are to be written before the helper
 * starts; `byReference: false` shows them cut when they could not be). Null for a node without a contract.
 */
export function stepPacket(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>, byReference = true): PacketPlan | null {
  if (!hasContract(node)) return null;
  const intoThread = intoThreadOf(ctx, node);
  // A specialist run's first message (its `brief` step) already carries the task: the inputs are not repeated in the packet.
  const values = { ...(intoThread || ctx.workflow.id === SPECIALIST_GRAPH ? {} : ctx.inputs), ...ctx.input.with };
  const inputs: PacketInput[] = Object.entries(values).map(([name, value]) => ({ name, value }));
  if (ctx.input.item !== undefined) inputs.push({ name: "item", value: ctx.input.item });
  if (ctx.input.via.handoff) inputs.push({ name: "previous_handoff", value: ctx.input.via.handoff });
  const goalName = GOAL_INPUTS.find((name) => typeof values[name] === "string" && String(values[name]).trim());
  const kinds = Object.fromEntries((node.consumes ?? []).flatMap((spec) => (spec.as ? [[spec.as, `${spec.kind}/${spec.version}`] as const] : [])));
  return planPacket({ step: { id: node.id, role: ctx.render(node.role), mode: ctx.mode }, ...(goalName ? { goal: String(values[goalName]), goalInput: goalName } : {}), inputs, produces: node.produces, gates: node.gates, kinds, chatId: ctx.runtime?.pmThreadId ?? "chat", runId: ctx.runId, byReference });
}

/** The data a node hands its helper: the mapped edge fields and the node's own `with`, and the item of its branch. */
export function agentRequest(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>, options: { byReference?: boolean } = {}): HelperRequest {
  const rt = ctx.runtime!;
  const fields = outputFields(ctx.workflow, node) as Field[];
  // The role may be taken from an input (`specialist:{{$inputs.agentId}}`: the scheduled agent's routine runs whichever agent the schedule names).
  const role = ctx.render(node.role);
  const spec = roleSpec(role);
  const via = ctx.input.via;
  const prior = via.mode === "same-session" || via.mode === "read-prior-session" ? { mode: via.mode, threadId: via.fromThreadId ?? null } : undefined;
  const task = ctx.render(node.prompt);
  const method = roleMethod(spec.helper.startsWith("specialist:") ? "" : role);
  const title = ctx.render(node.title?.en ?? node.label ?? node.id);
  const intoThread = intoThreadOf(ctx, node);
  const packet = stepPacket(ctx, node, options.byReference !== false)?.packet;
  // The step's own `with` over the workflow's `$inputs`: a fragment's goal reaches its helper even where no edge or node maps it. A step that
  // continues a thread was given the workflow's inputs earlier in it.
  // The routine graph of a scheduled agent carries everything the agent needs in its first message already (its `brief` step): the inputs are not repeated.
  const routine = ctx.workflow.id === AGENT_ROUTINE;
  const inputs = routine || ctx.workflow.id === SPECIALIST_GRAPH ? {} : { ...(intoThread ? {} : ctx.inputs), ...ctx.input.with };
  // K7: the first step and every third remind the helper what the whole run is for.
  const goals = ctx.reground ? goalsBlock(ctx.goals) : undefined;
  const body = intoThread
    ? `Continue the workflow step "${node.id}". New material for you:\n\n${packet ?? JSON.stringify(inputs, null, 1).slice(0, 20_000)}\n\n${task}${goals ? `\n\n${goals}` : ""}\n\n${outputContract(fields)}`
    : agentPrompt({ workflow: ctx.workflow.id, node: node.id, title, role, mode: ctx.mode, ...(method.length ? { method: method.join("\n") } : {}), task, inputs,
      ...(ctx.input.item !== undefined ? { item: ctx.input.item } : {}), handoff: via.handoff ?? null, ...(prior ? { prior } : {}), contract: outputContract(fields),
      readOnly: spec.readOnly, skills: [...(node.skills ?? []), ...(node.profile?.skills ?? [])], ...(goals ? { goals } : {}), ...(packet ? { packet } : {}), ...(node.authorized !== undefined ? { authorized: node.authorized } : {}) });
  return {
    rt, workflowRunId: ctx.runId, workflowId: ctx.workflow.id, stepKey: ctx.stepKey, nodeId: node.id, spawnKey: ctx.spawnKey, role, title, prompt: body, fields,
    ...(routine ? routineModel(ctx.inputs ?? {}) : {}),
    skills: [...new Set([...(node.skills ?? []), ...(node.profile?.skills ?? [])])], plugins: [...new Set(node.plugins ?? [])], mcp: [...new Set(node.mcp ?? [])], intoThread, signal: ctx.signal,
    ...(typeof ctx.inputs?.risk === "string" ? { risk: ctx.inputs.risk } : {}),
    ...(node.produces?.length || node.gates?.length ? { contract: { id: node.id, produces: node.produces, gates: node.gates } } : {}),
  };
}

/** The model the PM chat runs on; null when BB cannot say. */
export async function pmPairOfThread(bb: ServerCore["bb"], threadId: string): Promise<{ providerId: string; model: string } | null> {
  try {
    const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
    const providerId = stringAt(options, "providerId"), model = stringAt(options, "model");
    return providerId && model ? { providerId, model } : null;
  } catch { return null; }
}

type Pair = { providerId: string; model: string };
/** Where the model an author row ran on is kept: per Lane Pilot run (the phase's planner is read by its plan critic and its auditor), else per workflow run. */
const authorKey = (rt: ChainRuntime, workflowRunId: string, row: string) => `author-model:${rt.runId ?? workflowRunId}:${row}`;

/**
 * The model that wrote the work a judge row judges: the planner (else the analyst) of the same run, as recorded when their step was resolved.
 * A plan critic with no planner on record is judging the plan of the PM chat, so the PM's model stands in. Unknown (nothing recorded, the
 * KV unreadable, a role that judges no one): null, and the table's choice stands.
 */
async function authorOf(rt: ChainRuntime, workflowRunId: string, row: string, pm: Pair | null): Promise<Pair | null> {
  const rows = AUTHOR_ROWS[row];
  if (!rows) return null;
  for (const author of rows) {
    const kept = await rt.ctx.bb.storage?.kv.get<Pair>(authorKey(rt, workflowRunId, author)).catch(() => null);
    if (kept?.providerId && kept.model) return { providerId: kept.providerId, model: kept.model };
  }
  return pmAuthorOf(row, pm);
}

/** Keeps the model an author row runs on for the judges of the same run (the same value each time the step is resolved again after a reload). */
async function rememberAuthor(rt: ChainRuntime, workflowRunId: string, row: string, chosen: Pair): Promise<void> {
  await rt.ctx.bb.storage?.kv.set(authorKey(rt, workflowRunId, row), { providerId: chosen.providerId, model: chosen.model }).catch(() => undefined);
}

/**
 * The request with the model the step will run on written into it: the role's row of the table (the one resolver, `resolveSpawnModel`, decides;
 * the Models view calls the same function), unless a scheduled agent or an owner-created agent pins its own. Every helper step comes
 * through here, from the generic agent node to the goal audit and the contract planner (`run` resolves what was not resolved before).
 * `avoidProvider`: a provider that just hit its limit is taken out of the offer and no pin applies, so the answer is the role's next model.
 */
export async function withResolvedModel(request: HelperRequest, options: { avoidProvider?: string | null } = {}): Promise<HelperRequest> {
  const { rt } = request;
  const avoid = options.avoidProvider ?? null;
  const settings = (await Promise.resolve().then(() => rt.ctx.effectiveProjectSettings(rt.projectId, rt.runId ? getRunSettingsScopes(rt.ctx.db, rt.runId) : [])).catch(() => ({ values: {} as Record<string, unknown> }))).values;
  const pm = rt.pmThreadId ? await pmPairOfThread(rt.ctx.bb, rt.pmThreadId) : null;
  // The helper starts in the PM chat's environment, on one machine: a model that machine does not offer is passed over (the table's row)
  // or, when the run pins it itself, refused here with the machines that do have it, instead of failing inside the spawn.
  const hostId = rt.pmThreadId ? await pmHostOf(rt.ctx.bb, rt.pmThreadId).catch(() => null) : (await projectFolder(rt.ctx.bb, rt.projectId).catch(() => null))?.hostId ?? null;
  // The folder the thread starts in: a provider that cannot work there (opencode2 under ~/Documents on macOS: its
  // /api/mcp 500s EPERM) is out of the offer like a failed one (`providerBlockedForFolder` in spawn-model).
  const pmEnvPath = rt.pmThreadId
    ? await Promise.resolve().then(async () => {
        const pm = await rt.ctx.bb.sdk.threads.get({ threadId: rt.pmThreadId! });
        const environmentId = stringAt(pm, "environmentId");
        return environmentId ? stringAt(await rt.ctx.bb.sdk.environments.get({ environmentId }), "path") : null;
      }).catch(() => null)
    : null;
  // Reading the PM thread's folder must never break the pick: when it is unavailable the project folder answers,
  // as in a run without a PM chat.
  const envPath = pmEnvPath ?? (await projectFolder(rt.ctx.bb, rt.projectId).catch(() => null))?.path ?? null;
  const read = (() => { try { return modelCatalogOf(rt.ctx).peek(); } catch { return null; } })();
  // An agent the owner created may name its own model and effort: they pin the run unless the schedule named one.
  const specialist = request.role.startsWith("specialist:") ? request.role.slice("specialist:".length) : "";
  const agentMeta = !avoid && specialist && !isBundledSpecialist(specialist) ? (await Promise.resolve().then(() => rt.ctx.ownedAgents()).catch(() => ({} as Awaited<ReturnType<typeof rt.ctx.ownedAgents>>)))[specialist]?.meta : undefined;
  // The only models a run may pin: the one a scheduled agent names, and the one an owner-created agent names. The graph's node names none.
  const pinned = { provider: request.provider, model: request.model ?? agentMeta?.model, reasoning: request.reasoning ?? agentMeta?.effort, service_tier: request.serviceTier };
  const row = roleRowOf(request.role);
  const author = await authorOf(rt, request.workflowRunId, row, pm);
  // Provider limits: the usage of both table providers is read first (bounded, never blocks), then the resolver moves a pick off a nearly spent one.
  const usage = spawnUsageOf({ bb: rt.ctx.bb, log: rt.ctx.log });
  await warmSpawnUsage(usage, hostId);
  // Only an observed refusal holds a provider out of the folder: the block this machine recorded on a real failed start.
  const folderBlockTtl = Number(settings["provider.folder_block_ttl_ms"]) || PROVIDER_FOLDER_BLOCK_TTL_MS;
  const blockStore = rt.ctx.bb.storage?.kv ?? { get: async () => null };
  const folderBlock = await readProviderFolderBlock(blockStore, hostId, "opencode2", folderBlockTtl);
  const chosen = resolveSpawnModel({ role: request.role, pinned, settings, pm, author, catalog: read, hostId, envPath, avoidProvider: avoid, usage, folderBlock });
  if (request.provider && providerBlockedForFolder(request.provider, envPath, folderBlock)) rt.ctx.log?.(`Lane Pilot: ${request.role} cannot run on ${request.provider} in ${envPath}: ${providerBlockedForFolder(request.provider, envPath, folderBlock)}; the role's next provider takes the step`);
  // №9: a trivial step may run one model tier cheaper — only unpinned picks of a downgradable table role (a code
  // writer is not in the table at all, judges stay their own family, high/critical risk never cheapens).
  if (!pinned.model) {
    const judge = jev();
    if (judge?.enabled(settings as never) && downgradableRole(request.role) && request.risk !== "high" && request.risk !== "critical") {
      const verdict = await judge.judge(stepTrivialJudgment, { nodeType: "agent", role: roleRowOf(request.role), inputChars: request.prompt.length, ...(request.risk ? { risk: request.risk } : {}) }, { projectId: rt.projectId, runId: rt.runId, subject: `spawn:${request.nodeId}`, settings: settings as never }).catch(() => null);
      if (verdict?.by === "jev" && verdict.decision.trivial) {
        const cheaper = ROLE_MODEL_OPTIONS.find((o) => o.providerId === chosen.providerId && TIER_RANK[o.tier] === (TIER_RANK[modelTier(chosen.model) ?? "strong"] - 1));
        if (cheaper && cheaper.id !== chosen.model) {
          rt.ctx.log?.(`Lane Pilot: ${request.role} step ${request.nodeId} is trivial (jev); it runs on ${cheaper.id} instead of ${chosen.model}`);
          chosen.providerId = cheaper.providerId; chosen.model = cheaper.id;
        }
      }
    }
  }
  if (AUTHOR_ROW_IDS.includes(row)) await rememberAuthor(rt, request.workflowRunId, row, chosen);
  const where = `the ${request.role} of ${request.workflowId ?? "a workflow"}/${request.nodeId}`;
  if (chosen.issues.includes("crossed_family")) rt.ctx.log?.(`Lane Pilot: ${where} would have judged work of its own model family; it runs on ${chosen.providerId}/${chosen.model} (the other family)`);
  if (chosen.issues.includes("same_family_judge")) rt.ctx.log?.(`Lane Pilot: ${where} judges work of its own model family on ${chosen.providerId}/${chosen.model}: the other family has no model on this machine, so the judge is not independent`);
  if (chosen.issues.includes("model_unavailable_here") && read) {
    const on = findModelIn(read.providers.find((row) => row.id === chosen.providerId)?.models, chosen.model)?.hostIds.map((id) => read.hosts.find((row) => row.id === id)?.name ?? id).join(", ") ?? "";
    throw new HelperFailure("model_unavailable", `${chosen.providerId}/${chosen.model} is not offered by the machine this workflow's helpers run on (${read.hosts.find((row) => row.id === hostId)?.name ?? hostId})${on ? `; it is on ${on}` : ""}. Change the model of the role \"${request.role}\" in Settings (the role table).`);
  }
  if (chosen.issues.includes("escalated_for_role")) rt.ctx.log?.(`Lane Pilot: ${where} inherited a model too light for it; it runs on ${chosen.providerId}/${chosen.model} (the role's default)`);
  if (chosen.issues.includes("light_model_for_role")) rt.ctx.log?.(`Lane Pilot: ${where} runs on ${chosen.model}, a light model for that role, as the role table says`);
  return { ...request, provider: chosen.providerId, model: chosen.model, reasoning: chosen.reasoningEffort, resolved: true, ...(chosen.serviceTier ? { serviceTier: chosen.serviceTier } : {}) };
}

export const agentUsesKeyedSpawn = (rt: ChainRuntime | undefined) => Boolean(rt && keyedSpawnSupported(rt.ctx.bb));
export { ROLE_PROFILES };
