import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { writerExecutionSelection } from "../jev-reasoning";
import { ROLE_PROFILES } from "../helper-context";
import type { HelperRole } from "../helper-context";
import { redactKnown } from "../redact";
import { agentPrompt, outputContract, parseAgentOutput } from "../workflow/agent-output";
import type { AgentOutputError } from "../workflow/agent-output";
import type { StepContext } from "../workflow/engine";
import { outputFields } from "../workflow/lower";
import type { Field, GraphNode } from "../workflow/schema";
import { roleMethod } from "../stages/role-method";
import { fullAccessSpawn } from "./pm-spawn";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "./run-routing";
import { detectRepoEdits, gitRepoStatus } from "./repo-edits";
import { SPECIALIST_ROLES } from "./specialists";
import { findThreadsByMetadata, keyedSpawnSupported } from "./thread-keys";
import { stringAt } from "./values";
import { outputText } from "./writer-task";
import type { ChainRuntime } from "./workflow-runtime";

/**
 * The generic agent step of a workflow chain: a helper thread of the PM chat with the profile of the node's role (and the
 * skills, provider and model the node names), the node's prompt and data, a typed answer. The thread is found again by its
 * spawn key and plugin metadata after a reload (`lanePilotWorkflowRunId`, `lanePilotWorkflowStep`), so a lost spawn is not a second
 * helper. The same machinery runs a delegated action (a Telegram send, a skill script) and the router's model step.
 */
const DEFAULT_PROVIDER = "claude-code";
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_REASONING = "high";
/** Model presets a node may name; an unknown preset is the default. */
const PRESETS: Record<string, { model: string; reasoning: string }> = { "cheap-fast": { model: "claude-sonnet-5-5", reasoning: "low" } };

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
  role: string; title: string;
  /** The whole first message (or, into a running thread, the follow-up). */
  prompt: string;
  fields: readonly Field[];
  provider?: string; model?: string; reasoning?: string; preset?: string;
  skills?: readonly string[];
  /** Same session: send into this thread (a step that goes on in the earlier helper's session). */
  intoThread?: string | null;
  signal?: AbortSignal;
};
export type HelperResult = { threadId: string; output: Record<string, unknown>; text: string };

export class HelperFailure extends Error {
  /** The code leads the message: it is what a run's step error shows. */
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
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
      sentAt = Date.now();
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: request.prompt, mentions: [] }] } as never);
    } else {
      threadId = await lookup(rt, request);
      if (!threadId) {
        const preset = request.preset ? PRESETS[request.preset] : undefined;
        const providerId = request.provider ?? DEFAULT_PROVIDER;
        const policy = requireHelperSpawn({ bb, db, projectId: rt.projectId, runId: rt.runId });
        const placement = await helperChildPlacement({ bb, db, projectId: rt.projectId, runId: rt.runId, role: spec.metadata, taskTitle: `${request.title}`.slice(0, 80) });
        const spawned = await fullAccessSpawn(bb, {
          ...placement,
          ...requiredPolicyField(bb, policy, providerId, spec.helper, request.skills?.length ? { skills: [...request.skills] } : undefined),
          ...writerExecutionSelection(providerId, request.model ?? preset?.model ?? DEFAULT_MODEL, request.reasoning ?? preset?.reasoning ?? DEFAULT_REASONING, null),
          prompt: request.prompt,
          environment: { type: "reuse", environmentId },
          pluginMetadata: {
            role: spec.metadata, ...(spec.specialist ? { specialist: spec.specialist } : {}), spawnId: request.spawnKey, lanePilotRunId: rt.runId, parentPmThreadId: rt.pmThreadId, helperMode: policy.mode,
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
    let output: Record<string, unknown> | null = null, problem = "";
    for (let round = 0; round < 2 && !output; round += 1) {
      try { output = parseAgentOutput(text, request.fields); }
      catch (cause) {
        problem = (cause as AgentOutputError).message;
        if (round === 1) break;
        // One repair turn in the same thread: the answer is judged by its JSON, so a missing block is asked for, not guessed.
        const asked = Date.now();
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: `Your last message ended without the required JSON block (${problem}).\n\n${outputContract(request.fields)}\nAnswer with that block now; do not redo the work.`, mentions: [] }] } as never);
        await wait(asked);
        text = await read();
      }
    }
    if (checkoutPath && checkoutHostId && before) {
      const after = await gitRepoStatus(host, checkoutHostId, checkoutPath);
      const edited = after ? detectRepoEdits(before, after, spec.editable) : [];
      if (edited.length) throw new HelperFailure("repo_edited", `the ${request.role} helper edited repository files it may not touch: ${edited.slice(0, 8).join(", ")}`);
    }
    if (!output) throw new HelperFailure("output_invalid", `the ${request.role} helper's final message could not be read: ${problem}`);
    return { threadId: threadId!, output, text };
  }

  return { run };
}
export type WorkflowAgents = ReturnType<typeof createWorkflowAgents>;

// ---------------------------------------------------------------- the executor of an agent node

/** The data a node hands its helper: the mapped edge fields and the node's own `with`, and the item of its branch. */
export function agentRequest(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>): HelperRequest {
  const rt = ctx.runtime!;
  const fields = outputFields(ctx.workflow, node) as Field[];
  const spec = roleSpec(node.role);
  const via = ctx.input.via;
  const prior = via.mode === "same-session" || via.mode === "read-prior-session" ? { mode: via.mode, threadId: via.fromThreadId ?? null } : undefined;
  const task = ctx.render(node.prompt);
  const method = roleMethod(spec.helper.startsWith("specialist:") ? "" : node.role);
  const title = node.title?.en ?? node.label ?? node.id;
  const intoThread = via.mode === "same-session" && node.session !== "new" ? via.fromThreadId ?? null : null;
  const inputs = { ...ctx.input.with };
  const body = intoThread
    ? `Continue the workflow step "${node.id}". New material for you:\n\n${JSON.stringify(inputs, null, 1).slice(0, 20_000)}\n\n${task}\n\n${outputContract(fields)}`
    : agentPrompt({ workflow: ctx.workflow.id, node: node.id, title, role: node.role, mode: ctx.mode, ...(method.length ? { method: method.join("\n") } : {}), task, inputs,
      ...(ctx.input.item !== undefined ? { item: ctx.input.item } : {}), handoff: via.handoff ?? null, ...(prior ? { prior } : {}), contract: outputContract(fields),
      readOnly: spec.readOnly, skills: [...(node.skills ?? []), ...(node.profile?.skills ?? [])] });
  return {
    rt, workflowRunId: ctx.runId, stepKey: ctx.stepKey, nodeId: node.id, spawnKey: ctx.spawnKey, role: node.role, title, prompt: body, fields,
    ...(node.provider ? { provider: node.provider } : {}), ...(node.model ? { model: node.model } : {}), ...(node.reasoning ? { reasoning: node.reasoning } : {}), ...(node.model_preset ? { preset: node.model_preset } : {}),
    skills: [...new Set([...(node.skills ?? []), ...(node.profile?.skills ?? [])])], intoThread, signal: ctx.signal,
  };
}

export const agentUsesKeyedSpawn = (rt: ChainRuntime | undefined) => Boolean(rt && keyedSpawnSupported(rt.ctx.bb));
export { ROLE_PROFILES };
