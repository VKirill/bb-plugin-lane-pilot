import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import { getRunSettingsScopes } from "../database";
import { writerExecutionSelection, findModelIn } from "@lane-pilot/models";
import { ROLE_PROFILES } from "../helper-context";
import type { ExtraAccess, HelperRole } from "../helper-context";
import { redactKnown } from "@lane-pilot/kit";
import { agentPrompt, outputContract, parseAgentOutput } from "../workflow/agent-output";
import { contractProblems, contractRepairPrompt, describeProblems, hasContractProblems } from "../workflow/contract";
import type { ContractNode, ContractProblems } from "../workflow/contract";
import type { AgentOutputError } from "../workflow/agent-output";
import type { StepContext } from "../workflow/engine";
import { goalsBlock } from "../workflow/goals";
import { planPacket } from "../workflow/handoff";
import type { PacketInput, PacketPlan } from "../workflow/handoff";
import { outputFields } from "../workflow/lower";
import type { Field, GraphNode } from "../workflow/schema";
import { roleMethod } from "../stages/role-method";
import { fullAccessSpawn } from "./pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { detectRepoEdits, gitRepoStatus } from "./repo-edits";
import { SPECIALIST_ROLES } from "./specialists";
import { findThreadsByMetadata, keyedSpawnSupported } from "./thread-keys";
import { modelCatalogOf, pmHostOf } from "./model-catalog-reader";
import { offeredOnHost } from "@lane-pilot/models";
import { threadUsage } from "./token-usage";
import { stringAt } from "./values";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING, resolveAgentModel } from "./workflow-agent-model";
import { outputText } from "./writer-task";
import type { ServerCore } from "./core";
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
  triager: "gate-triage", memory: "memory-maintainer", "browser-qa": "browser-qa", errand: "errand", council: "council-seat", "project-life": "project-life", "pm-reader": "pm-reader",
};

/** What a node's `role` means here: the profile of the helper, the role in its metadata, and which repository files it may touch (none, except the notes of its own chat). */
export function roleSpec(role: string): RoleSpec {
  const specialist = role.startsWith("specialist:") ? role.slice("specialist:".length) : null;
  if (specialist && (SPECIALIST_ROLES as readonly string[]).includes(specialist)) {
    return { helper: `specialist:${specialist}` as HelperRole, metadata: "specialist", specialist, readOnly: false, editable: (file) => BASE_ALLOWED(file) || file === ".agents" || file.startsWith(".agents/") };
  }
  const helper = ROLE_MAP[role] ?? "analyst";
  if (helper === "project-life") return { helper, metadata: "project-life", readOnly: false, editable: (file) => BASE_ALLOWED(file) || file.startsWith(".agents/") || file === "CHANGELOG.md" };
  return { helper, metadata: helper, readOnly: true, editable: BASE_ALLOWED };
}

export type HelperRequest = {
  rt: ChainRuntime;
  workflowRunId: string; stepKey: string; nodeId: string; spawnKey: string;
  /** The workflow the node belongs to: with `nodeId` it is the key of the owner's model override of the step. */
  workflowId?: string;
  role: string; title: string;
  /** The whole first message (or, into a running thread, the follow-up). */
  prompt: string;
  fields: readonly Field[];
  provider?: string; model?: string; reasoning?: string; serviceTier?: "default" | "fast"; preset?: string;
  skills?: readonly string[];
  /** BB plugins and MCP servers the step's session may load on top of its role's. */
  plugins?: readonly string[]; mcp?: readonly string[];
  /** Same session: send into this thread (a step that goes on in the earlier helper's session). */
  intoThread?: string | null;
  /** The step contract (`produces`, `gates`): an answer that breaks it gets the same one repair turn as an answer without a JSON block. */
  contract?: ContractNode;
  signal?: AbortSignal;
};
/** What the step spent: tokens and the price of them, from the thread's own usage events (the budget of the run counts these). */
export type HelperResult = { threadId: string; output: Record<string, unknown>; text: string; usage?: { tokens: number; costUsd: number; unknown?: true } };

/** The answer is JSON but breaks the step's contract. */
class ContractFailure extends Error { constructor(readonly problems: ContractProblems) { super(describeProblems(problems).join("; ")); } }

export class HelperFailure extends Error {
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

/** Whether the thread shows a follow-up turn requested at or after `at`. */
async function followUpRequested(bb: ServerCore["bb"], threadId: string, at: number): Promise<boolean> {
  const listed = await listThreadEventsRaw(bb, { threadId, types: THREAD_WATCH_EVENT_TYPES, order: "desc", limit: "50" });
  return listed.ok && listed.events.some((event) => (event as { type?: unknown; createdAt?: unknown }).type === "client/turn/requested" && Number((event as { createdAt?: unknown }).createdAt) >= at);
}

export function createWorkflowAgents() {
  async function lookup(rt: ChainRuntime, request: HelperRequest): Promise<string | null> {
    // The spawn key makes `spawnKeyed` return the same thread; without the VK keys a thread is found by its metadata, or not at all.
    const found = await findThreadsByMetadata(rt.ctx.bb, { lanePilotWorkflowRunId: request.workflowRunId, lanePilotWorkflowStep: request.stepKey, lanePilotWorkflowSpawn: request.spawnKey }, rt.projectId);
    return found?.[0]?.id ?? null;
  }

  async function run(request: HelperRequest): Promise<HelperResult> {
    const { rt } = request;
    const { bb, db, host } = rt.ctx;
    const spec = roleSpec(request.role);
    const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
    const environmentId = stringAt(pm, "environmentId");
    if (!environmentId) throw new HelperFailure("no_pm_environment", "the PM chat has no environment to run the helper in");
    const envObj = await bb.sdk.environments.get({ environmentId }).catch(() => null);
    const checkoutPath = stringAt(envObj, "path") ?? "", checkoutHostId = stringAt(envObj, "hostId") ?? "";
    const before = checkoutPath && checkoutHostId ? await gitRepoStatus(host, checkoutHostId, checkoutPath) : null;

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
      threadId = await lookup(rt, request);
      if (!threadId) {
        const providerId = request.provider ?? DEFAULT_PROVIDER;
        const policy = requireHelperSpawn({ bb, db, projectId: rt.projectId, runId: rt.runId });
        const placement = await helperChildPlacement({ bb, db, projectId: rt.projectId, runId: rt.runId, role: spec.metadata, taskTitle: `${request.title}`.slice(0, 80) });
        const spawned = await fullAccessSpawn(bb, {
          ...placement,
          ...requiredPolicyField(bb, policy, providerId, spec.helper, extraAccessOf(request)),
          ...writerExecutionSelection(providerId, request.model ?? DEFAULT_MODEL, request.reasoning ?? DEFAULT_REASONING, request.serviceTier ?? null),
          prompt: request.prompt,
          environment: { type: "reuse", environmentId },
          pluginMetadata: {
            role: spec.metadata, ...(spec.specialist ? { specialist: spec.specialist } : {}), ...(rt.origin ? { origin: rt.origin } : {}), spawnId: request.spawnKey, lanePilotRunId: rt.runId, parentPmThreadId: rt.pmThreadId, helperMode: policy.mode,
            lanePilotWorkflowRunId: request.workflowRunId, lanePilotWorkflowStep: request.stepKey, lanePilotWorkflowSpawn: request.spawnKey, lanePilotWorkflowNode: request.nodeId,
          },
        } as Parameters<typeof fullAccessSpawn>[1]);
        threadId = stringAt(spawned, "id");
        if (!threadId) throw new HelperFailure("thread_id_missing", "the helper thread was not created");
      }
    }

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

    await wait(sentAt);
    let text = await read();
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
      const edited = after ? detectRepoEdits(before, after, spec.editable) : [];
      if (edited.length) throw new HelperFailure("repo_edited", `the ${request.role} helper edited repository files it may not touch: ${edited.slice(0, 8).join(", ")}`);
    }
    if (!output) throw new HelperFailure(broken ? "artifact_invalid" : "output_invalid", broken ? `the ${request.role} helper's answer breaks the step's contract: ${problem}` : `the ${request.role} helper's final message could not be read: ${problem}`);
    // Read last, so the repair turn counts too. A thread whose usage cannot be read, or has no usage events, reports `unknown`:
    // the engine then holds the run to a time and step limit instead of letting a token or money budget pass unseen.
    const measured = await threadUsage(bb, threadId!, { ...(sentAt !== undefined ? { since: sentAt } : {}), ...(request.model ? { fallbackModel: request.model } : {}) }).catch(() => undefined);
    const usage = measured ? { tokens: measured.tokens, costUsd: measured.costUsd, ...(measured.known ? {} : { unknown: true as const }) } : { tokens: 0, costUsd: 0, unknown: true as const };
    return { threadId: threadId!, output, text, usage };
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
  const values = { ...(intoThread ? {} : ctx.inputs), ...ctx.input.with };
  const inputs: PacketInput[] = Object.entries(values).map(([name, value]) => ({ name, value }));
  if (ctx.input.item !== undefined) inputs.push({ name: "item", value: ctx.input.item });
  if (ctx.input.via.handoff) inputs.push({ name: "previous_handoff", value: ctx.input.via.handoff });
  const goalName = GOAL_INPUTS.find((name) => typeof values[name] === "string" && String(values[name]).trim());
  const kinds = Object.fromEntries((node.consumes ?? []).flatMap((spec) => (spec.as ? [[spec.as, `${spec.kind}/${spec.version}`] as const] : [])));
  return planPacket({ step: { id: node.id, role: node.role, mode: ctx.mode }, ...(goalName ? { goal: String(values[goalName]), goalInput: goalName } : {}), inputs, produces: node.produces, gates: node.gates, kinds, chatId: ctx.runtime?.pmThreadId ?? "chat", runId: ctx.runId, byReference });
}

/** The data a node hands its helper: the mapped edge fields and the node's own `with`, and the item of its branch. */
export function agentRequest(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>, options: { byReference?: boolean } = {}): HelperRequest {
  const rt = ctx.runtime!;
  const fields = outputFields(ctx.workflow, node) as Field[];
  const spec = roleSpec(node.role);
  const via = ctx.input.via;
  const prior = via.mode === "same-session" || via.mode === "read-prior-session" ? { mode: via.mode, threadId: via.fromThreadId ?? null } : undefined;
  const task = ctx.render(node.prompt);
  const method = roleMethod(spec.helper.startsWith("specialist:") ? "" : node.role);
  const title = node.title?.en ?? node.label ?? node.id;
  const intoThread = intoThreadOf(ctx, node);
  const packet = stepPacket(ctx, node, options.byReference !== false)?.packet;
  // The step's own `with` over the workflow's `$inputs`: a fragment's goal reaches its helper even where no edge or node maps it. A step that
  // continues a thread was given the workflow's inputs earlier in it.
  const inputs = { ...(intoThread ? {} : ctx.inputs), ...ctx.input.with };
  // K7: the first step and every third remind the helper what the whole run is for.
  const goals = ctx.reground ? goalsBlock(ctx.goals) : undefined;
  const body = intoThread
    ? `Continue the workflow step "${node.id}". New material for you:\n\n${packet ?? JSON.stringify(inputs, null, 1).slice(0, 20_000)}\n\n${task}${goals ? `\n\n${goals}` : ""}\n\n${outputContract(fields)}`
    : agentPrompt({ workflow: ctx.workflow.id, node: node.id, title, role: node.role, mode: ctx.mode, ...(method.length ? { method: method.join("\n") } : {}), task, inputs,
      ...(ctx.input.item !== undefined ? { item: ctx.input.item } : {}), handoff: via.handoff ?? null, ...(prior ? { prior } : {}), contract: outputContract(fields),
      readOnly: spec.readOnly, skills: [...(node.skills ?? []), ...(node.profile?.skills ?? [])], ...(goals ? { goals } : {}), ...(packet ? { packet } : {}), ...(node.authorized !== undefined ? { authorized: node.authorized } : {}) });
  return {
    rt, workflowRunId: ctx.runId, workflowId: ctx.workflow.id, stepKey: ctx.stepKey, nodeId: node.id, spawnKey: ctx.spawnKey, role: node.role, title, prompt: body, fields,
    ...(node.provider ? { provider: node.provider } : {}), ...(node.model ? { model: node.model } : {}), ...(node.reasoning ? { reasoning: node.reasoning } : {}), ...(node.service_tier ? { serviceTier: node.service_tier } : {}), ...(node.model_preset ? { preset: node.model_preset } : {}),
    skills: [...new Set([...(node.skills ?? []), ...(node.profile?.skills ?? [])])], plugins: [...new Set(node.plugins ?? [])], mcp: [...new Set(node.mcp ?? [])], intoThread, signal: ctx.signal,
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

/**
 * The request with the model the step will run on written into it: the node's fields, its preset, the role's stage selection, the
 * generic agent selection, the PM's model (resolveAgentModel decides; the Models view calls the same function). Applied to the
 * generic agent node and to the actions that run in an errand helper; the router, the architect and the audits keep their own.
 */
export async function withResolvedModel(request: HelperRequest): Promise<HelperRequest> {
  const { rt } = request;
  const settings = (await rt.ctx.effectiveProjectSettings(rt.projectId, getRunSettingsScopes(rt.ctx.db, rt.runId)).catch(() => ({ values: {} }))).values;
  const pm = await pmPairOfThread(rt.ctx.bb, rt.pmThreadId);
  // The helper starts in the PM chat's environment, on one machine: a model that machine does not offer is passed over (a preset, a Settings
  // selection) or, when the step names it itself, refused here with the machines that do have it, instead of failing inside the spawn.
  const hostId = await pmHostOf(rt.ctx.bb, rt.pmThreadId).catch(() => null);
  const read = hostId ? modelCatalogOf(rt.ctx).peek() : null;
  const offered = read && hostId ? (providerId: string, model: string) => offeredOnHost(read, providerId, model, hostId) : undefined;
  const chosen = resolveAgentModel({ role: request.role, node: { provider: request.provider, model: request.model, reasoning: request.reasoning, service_tier: request.serviceTier, model_preset: request.preset }, settings, pm, ...(offered ? { offered } : {}), ...(request.workflowId ? { at: { workflowId: request.workflowId, nodeId: request.nodeId } } : {}) });
  if (chosen.issues.includes("model_unavailable_here") && read) {
    const where = findModelIn(read.providers.find((row) => row.id === chosen.providerId)?.models, chosen.model)?.hostIds.map((id) => read.hosts.find((row) => row.id === id)?.name ?? id).join(", ") ?? "";
    throw new HelperFailure("model_unavailable", `${chosen.providerId}/${chosen.model} is not offered by the machine this workflow's helpers run on (${read.hosts.find((row) => row.id === hostId)?.name ?? hostId})${where ? `; it is on ${where}` : ""}. Pick another model for the step.`);
  }
  return { ...request, provider: chosen.providerId, model: chosen.model, reasoning: chosen.reasoningEffort, ...(chosen.serviceTier ? { serviceTier: chosen.serviceTier } : {}) };
}

export const agentUsesKeyedSpawn = (rt: ChainRuntime | undefined) => Boolean(rt && keyedSpawnSupported(rt.ctx.bb));
export { ROLE_PROFILES };
