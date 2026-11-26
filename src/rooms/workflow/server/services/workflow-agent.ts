import { MACHINE_AFFINITY_ANY } from "@lane-pilot/contracts";
import { THREAD_WATCH_EVENT_TYPES, listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { planningHomeInputs } from "../../../storage";
import { isZcodeProvider, providerLimitNotice, writerExecutionSelection, zcodeEnvironmentError } from "@lane-pilot/models";
import { placeEmployeeOn } from "../../../native-agent";
import type { ExtraAccess } from "../../../contracts/helper-context";
import { planningText, resolvePlanningHome } from "../../../contracts";
import { bestEffort, isNotFound, orMiss, outputText, redactKnown, stringAt } from "@lane-pilot/kit";
import { agentPrompt, contractProblems, contractRepairPrompt, describeProblems, goalsBlock, hasContractProblems, honestExit, outputContract, outputFields, parseAgentOutput } from "@lane-pilot/workflow-engine";
import type { ContractProblems, Field, GraphNode, PacketPlan, StepContext } from "@lane-pilot/workflow-engine";
import { roleMethod } from "../../../critique";
import { findThreadsByMetadata, folderEnvironment, fullAccessSpawn, hiddenPlacement, keyedSpawnSupported, noteProviderLimit, noteProviderStartFailure, noteProviderStartSuccess, projectFolder, projectSources } from "../../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import { createRepoGuard } from "./workflow-repo-guard";
import type { RepoGuardDetail, RepoGuardPoint } from "./workflow-repo-guard";
import { SPECIALIST_GRAPH, rememberSpecialistThread } from "../../../critique/server";
import { confirmedWordHits } from "../../../memory/server";
import { deliverRunFile } from "./workflow-run-home";
import { intoThreadOf, renderTask, stepPacket } from "./workflow-agent-packet";
import { spentBy, type TrackedThread } from "./workflow-agent-facts";
import { waitAndGuardThread } from "./workflow-agent-guard";
import { nativeSkillSelection, skillThreadRoute, skillWorkspaceRoute } from "./workflow-skill-select";
import type { SkillRoute } from "./workflow-skill-select";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING } from "../../models/workflow-agent-model";
import { nodeModelOf, routineModel } from "./workflow-node-model";
import { switchRoleOnLimit } from "./workflow-role-fallback";
import { formatSavedPlan, planModelOverride } from "./workflow-plan-form";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import {
  AGENT_ROUTINE,
  HelperFailure,
  ROLE_PROFILES,
  downgradableRole,
  employeeView,
  extraAccessOf,
  isBundledSpecialist,
  isPhaseAuthor,
  ownSpecialist,
  phaseOfWorkflowRun,
  phaseWritable,
  phaseWriteNote,
  roleSpec,
  type HelperRequest,
  type HelperResult,
  type RoleSpec,
} from "./workflow-agent-spec";
import { pmPairOfThread, settingsOf, withResolvedModel } from "./workflow-agent-model-resolve";

export type { HelperModelResolution } from "../../models/helper-model-provenance";
export type { RepoGuardDetail, RoleSpec, HelperRequest, HelperResult };
export {
  AGENT_ROUTINE,
  HelperFailure,
  ROLE_PROFILES,
  downgradableRole,
  extraAccessOf,
  isBundledSpecialist,
  isPhaseAuthor,
  ownSpecialist,
  phaseOfWorkflowRun,
  phaseWritable,
  phaseWriteNote,
  pmPairOfThread,
  roleSpec,
  stepPacket,
  withResolvedModel,
};

/** The answer is JSON but breaks the step's contract. */
class ContractFailure extends Error { constructor(readonly problems: ContractProblems) { super(describeProblems(problems).join("; ")); } }

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

/** Whether the thread shows a follow-up turn requested at or after `at`. */
async function followUpRequested(bb: ServerCore["bb"], threadId: string, at: number): Promise<boolean> {
  const listed = await listThreadEventsRaw(bb, { threadId, types: THREAD_WATCH_EVENT_TYPES, order: "desc", limit: "50" });
  return listed.ok && listed.events.some((event) => (event as { type?: unknown; createdAt?: unknown }).type === "client/turn/requested" && Number((event as { createdAt?: unknown }).createdAt) >= at);
}

/**
 * The generic agent step of a workflow chain: a helper thread of the PM chat with the profile of the node's role (and the
 * skills, provider and model the node names), the node's prompt and data, a typed answer. The thread is found again by its
 * spawn key and plugin metadata after a reload (`lanePilotWorkflowRunId`, `lanePilotWorkflowStep`), so a lost spawn is not a second
 * helper. The same machinery runs a delegated action (a Telegram send, a skill script) and the router's model step.
 */
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
    const resolved = asked.resolved ? asked : await withResolvedModel(asked);
    try {
      return await runTracked(resolved, tracked);
    } catch (cause) {
      if (cause instanceof Error && tracked.length) (cause as HelperFailure).usage = await spentBy(asked.rt.ctx.bb, tracked, { requestedProvider: resolved.provider ?? null, requestedModel: resolved.model ?? null });
      throw cause;
    }
  }

  async function runTracked(asked: HelperRequest, tracked: TrackedThread[]): Promise<HelperResult> {
    const { rt } = asked;
    const { bb, db, host } = rt.ctx;
    const spec = roleSpec(asked.role);
    const requestedProvider = asked.provider ?? asked.modelResolution?.requested?.providerId ?? null;
    const requestedModel = asked.model ?? asked.modelResolution?.requested?.model ?? null;
    // A `specialist:` role that names no specialist (a role taken from an input, a reserved id) must not quietly run as an analyst.
    if (asked.role.startsWith("specialist:") && !spec.specialist) throw new HelperFailure("unknown_specialist", `"${asked.role.slice("specialist:".length)}" is neither a bundled specialist nor an agent you created (bb lane-pilot agents list)`);
    const openEnded = asked.workflowId === AGENT_ROUTINE || asked.workflowId === SPECIALIST_GRAPH;
    const own = spec.specialist
      ? (!isBundledSpecialist(spec.specialist) || openEnded
          ? await ownSpecialist(rt, spec.specialist, { openEnded })
          : await bestEffort(rt.ctx.log, "bundled specialist profile", Promise.resolve().then(() => ownSpecialist(rt, spec.specialist!)), null))
      : null;
    // A phase stage writes its documents: its helper is told which folders it may write, the same ones the check below allows.
    const phaseId = spec.readOnly && isPhaseAuthor(spec.helper) ? phaseOfWorkflowRun(db, asked.workflowRunId) : null;
    const noted = `${phaseId ? phaseWriteNote(asked.prompt, phaseId, spec.helper) : asked.prompt}`;
    let request = { ...asked, prompt: own && !asked.intoThread ? `${own.marker}\n\n${noted}` : noted };
    // With a PM chat the helper reuses the chat's environment; with none, it works in the project's own first folder.
    let environment: ReturnType<typeof folderEnvironment> | { type: "reuse"; environmentId: string };
    let checkoutPath = "", checkoutHostId = "", chatSection: string | null = null;
    if (rt.pmThreadId) {
      const pm = await bb.sdk.threads.get({ threadId: rt.pmThreadId });
      chatSection = stringAt(pm, "sectionId");
      const environmentId = stringAt(pm, "environmentId");
      if (!environmentId) throw new HelperFailure("no_pm_environment", "the PM chat has no environment to run the helper in");
      const envObj = await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound);
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
    if (spec.specialist && employeeView(spec.specialist).machineAffinity !== MACHINE_AFFINITY_ANY) {
      const place = await placeEmployeeOn(bb, spec.specialist, await projectSources(bb, rt.projectId));
      if (place.mode === "folder") {
        environment = folderEnvironment({ hostId: place.hostId, path: place.path });
        checkoutPath = place.path;
        checkoutHostId = place.hostId;
      } else if (place.mode === "fallback") {
        bb.log?.warn(`Lane Pilot employee ${spec.specialist} stays in the current environment: ${place.reason}`);
      }
    }
    // The planning home (SMA d_project_planning): a prompt that names `.agents/phases|planning|todos|plans` gets the home's absolute folder, so what
    // the model writes lands where the driver reads. Unset: the prompt is untouched. `pr-branch` names them as pathspecs to leave out of a cherry-pick.
    if (checkoutPath && checkoutHostId && asked.workflowId !== "pr-branch") {
      const home = await resolvePlanningHome({ host, hostId: checkoutHostId, cwd: checkoutPath, inputs: planningHomeInputs(db, rt.projectId), log: bb.log });
      if (home) request = { ...request, prompt: planningText(request.prompt, home) };
    }
    // The packet's files were written on the PM checkout by the executor; the helper reads them from its own workspace,
    // which a placed specialist may have moved to another host and folder (and a step continuing a thread reads them in
    // that thread's environment). The same relative paths are written there; when the target cannot be resolved the
    // step fails closed — running on references that are not there is a silent cut of required context.
    if (request.packetFiles?.length) {
      let target = { hostId: checkoutHostId, path: checkoutPath };
      if (request.intoThread) {
        try {
          const thread = await orMiss(bb.sdk.threads.get({ threadId: request.intoThread }), null, isNotFound);
          const environmentId = stringAt(thread, "environmentId");
          const env = environmentId ? await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound) : null;
          const hostId = stringAt(env, "hostId"), path = stringAt(env, "path");
          target = hostId && path ? { hostId, path } : { hostId: "", path: "" };
        } catch (cause) {
          throw new HelperFailure("input_delivery", `the continued thread's environment could not be read (${cause instanceof Error ? cause.message : String(cause)}); the step fails instead of running on references that are not there`);
        }
      }
      if (!target.hostId || !target.path) throw new HelperFailure("input_delivery", `the ${request.role} step's ${request.packetFiles.length} input file(s) have no workspace to land in (the continued thread's environment is unreadable); the step fails instead of running on references that are not there`);
      // The executor already put the files at `packetFilesAt` (the PM checkout): when the helper reads them from the same
      // place there is nothing to write again; a different host or path gets them materialized there, content-checked.
      const at = request.packetFilesAt;
      const samePlace = at && at.hostId === target.hostId && at.path.replace(/\/+$/, "") === target.path.replace(/\/+$/, "");
      if (!samePlace) {
        for (const file of request.packetFiles) {
          try {
            await deliverRunFile(bb.sdk.files, target, file);
          } catch (cause) {
            throw new HelperFailure("input_delivery", `the input file(s) of ${request.nodeId} could not be written to ${target.hostId}:${target.path} (${cause instanceof Error ? cause.message : String(cause)}); the step fails instead of running on references that are not there`);
          }
        }
      }
    }
    const watchedFrom = Date.now();
    const repoWatcher = createRepoGuard({ bb, host, hostId: checkoutHostId, path: checkoutPath,
      readOnly: spec.readOnly, pmThreadId: rt.pmThreadId, watchedFrom, role: request.role, stepKey: request.stepKey });
    const guardPoint = repoWatcher.point;
    const beforePoint = await guardPoint();

    // Optional node-local skill selection resolves against the actual spawn target once per run (provider fallback recomputes per attempt).
    let spawnSkillRouteCache: Promise<SkillRoute | null> | undefined;
    const spawnSkillRoute = () => (spawnSkillRouteCache ??= skillWorkspaceRoute(bb, rt.projectId, environment));

    async function spawn(req: HelperRequest): Promise<string> {
      const providerId = req.provider ?? DEFAULT_PROVIDER;
      const selection = req.skills?.length
        ? await nativeSkillSelection({ bb, projectId: rt.projectId, provider: providerId, route: await spawnSkillRoute(), skills: req.skills, prompt: req.prompt })
        : null;
      for (const note of selection?.notes ?? []) bb.log.warn(`workflow step ${req.stepKey}: ${note}`);
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
        ...(selection?.parts ? { input: selection.parts } : { prompt: req.prompt }),
        environment,
        pluginMetadata: {
          role: spec.metadata, ...(spec.specialist ? { specialist: spec.specialist } : {}), ...(rt.origin ? { origin: rt.origin } : {}), spawnId: req.spawnKey, ...(rt.runId ? { lanePilotRunId: rt.runId } : {}), ...parent, helperMode: policy.mode,
          lanePilotWorkflowRunId: req.workflowRunId, lanePilotWorkflowStep: req.stepKey, lanePilotWorkflowSpawn: req.spawnKey, lanePilotWorkflowNode: req.nodeId, ...(req.modelResolution ? { modelResolution: req.modelResolution } : {}),
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
    // True when the helper's work may have started before this run's observation window: a reload re-run that found its
    // thread by spawn key, or a continued thread whose follow-up was already sent by an earlier attempt. The repoGuard
    // snapshots then measure the interval around the wait, not provably the whole execution.
    let threadReused = false;
    async function findOrSpawn(req: HelperRequest): Promise<string> {
      const found = await lookup(rt, req);
      if (found) threadReused = true;
      return found ?? spawn(req);
    }
    if (threadId) {
      // A re-run of the step after a reload must not send the task a second time: the send is recorded by the step key before it is made,
      // and a record whose follow-up BB shows as requested means it already went; a record without one (the process died in between) sends again.
      const sentKey = `workflow-send:${request.workflowRunId}:${request.stepKey}:${request.spawnKey}`;
      const earlier = await bb.storage.kv.get<{ at: number }>(sentKey);
      if (earlier && await followUpRequested(bb, threadId, earlier.at)) { sentAt = earlier.at; threadReused = true; }
      else {
        sentAt = Date.now();
        await bb.storage.kv.set(sentKey, { at: sentAt });
        let input: unknown = [{ type: "text", text: request.prompt, mentions: [] }];
        if (request.skills?.length) {
          const target = await skillThreadRoute(bb, threadId);
          const selection = target
            ? await nativeSkillSelection({ bb, projectId: target.projectId, provider: target.provider, route: target.route, skills: request.skills, prompt: request.prompt })
            : { parts: null, notes: [`selection_workspace_unverified: provider=${request.provider ?? DEFAULT_PROVIDER} skills=${request.skills.join(",")} — the continued thread's workspace is unreadable`] };
          for (const note of selection.notes) bb.log.warn(`workflow step ${request.stepKey}: ${note}`);
          if (selection.parts) input = selection.parts;
        }
        await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input } as never);
      }
    } else {
      const startFolder = await bestEffort(rt.ctx.bb.log, "workflow helper start folder", projectFolder(rt.ctx.bb, rt.projectId), null);
      const blockStore = bb.storage?.kv ?? { set: async () => undefined };
      try {
        threadId = await findOrSpawn(request);
        // A start that went through clears this machine's observed folder block for the provider.
        await noteProviderStartSuccess(blockStore, startFolder?.hostId ?? null, request.provider ?? "", startFolder?.path ?? null);
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const startLimit = !request.intoThread
          ? providerLimitNotice(msg) ?? (/\b(subscription|unauthori[sz]ed|invalid api key|auth|billing|quota|plan expired|account)\b/i.test(msg) ? msg.slice(0, 200) : null)
          : null;
        // The provider cannot start in this environment (its own session policy unenforceable, its server 500s the
        // MCP listing, or its subscription/auth/quota ended): one retry on the role's next provider, no PM involved,
        // and when subscription/quota ended the role follows its configured fallback with one owner item.
        if (!startLimit && !/capability_unproven|vk_required_session_policy_unenforceable|vk_required_session_policy_unsupported|thread_provisioning_failed|thread_command_failed|thread\.start failed|OpenCode[^\n]*\b500\b|\b500\b[^\n]*mcp/i.test(msg)) throw cause;
        const failed = request.provider ?? DEFAULT_PROVIDER;
        // An observed refusal in a ~/Documents folder on this machine is remembered: the pick stops offering it there
        // until a success or the block's TTL (provider.folder_block_ttl_ms, 6 h).
        if (!startLimit) await noteProviderStartFailure(blockStore, startFolder?.hostId ?? null, failed, startFolder?.path ?? null, msg);
        const again = await bestEffort(bb.log, "workflow helper model resolve", withResolvedModel({ ...request, provider: undefined as never, model: undefined as never, reasoning: undefined as never, serviceTier: undefined as never, resolved: undefined as never }, { avoidProvider: failed, reason: startLimit ? "provider_limit" : "provider_start_failure" }), null);
        if (!again || again.provider === failed) throw cause;
        bb.log.warn(`workflow step ${request.stepKey}: ${failed} could not start (${msg.slice(0, 160)}); rerunning on ${again.provider}/${again.model}`);
        const fallback = { ...request, ...again, provider: again.provider, model: again.model, reasoning: again.reasoning, serviceTier: request.serviceTier, spawnKey: `${request.spawnKey}:start` };
        if (startLimit) await bestEffort(bb.log, "workflow role switch", switchRoleOnLimit(request, failed, fallback, startLimit, await settingsOf(rt)), false);
        threadId = await findOrSpawn(fallback);
        await noteProviderStartSuccess(blockStore, startFolder?.hostId ?? null, fallback.provider ?? "", startFolder?.path ?? null);
        request = { ...request, provider: fallback.provider, model: fallback.model };
      }
    }
    tracked.push({ id: threadId, ...(sentAt !== undefined ? { since: sentAt } : {}), ...(request.model ? { model: request.model } : {}), ...(request.provider ? { provider: request.provider } : {}) });

    const wait = async (since?: number) => {
      try {
        await waitAndGuardThread({ bb, threadId: threadId!, label: `workflow_${request.nodeId}`, tracked, since,
          shouldStop: () => (rt.ctx.isDisposed() ? "plugin_stopped" : request.signal?.aborted ? "aborted" : null),
          givesUpOn: request.intoThread ? undefined : (notice) => providerLimitNotice(notice) !== null,
          checkTurn: request.checkTurn, trackChild: request.trackChild,
          usageCtx: { requestedProvider, requestedModel, answeredProvider: request.provider ?? null, answeredModel: request.model ?? null } });
      } catch (cause) {
        if (request.signal?.aborted) await bestEffort(bb.log, "workflow helper thread stop", bb.sdk.threads.stop({ threadId: threadId! }), undefined);
        if (cause instanceof Error && cause.name === "BudgetStopError") throw cause;
        throw new HelperFailure("thread_failed", cause instanceof Error ? cause.message : String(cause));
      }
    };
    const read = async () => {
      const raw = (await bb.sdk.threads.output({ threadId: threadId! })).output;
      return redactKnown(typeof raw === "string" ? raw : outputText(raw));
    };

    // The ZCode app cannot take the work now (busy, text not visible, needs the foreground, signed out): the machine's state, handled below as a limit.
    // So is a turn the provider ended with its limit notice as an error instead of an answer: opencode2 on a spent Gemini router retried
    // «HTTP 403 (reset after 2m)» and failed, and the closing graph's memory step failed with it (live phase, 2026-11-11).
    let zcodeRefusal: string | null = null;
    let waitRefusal: string | null = null;
    try {
      await wait(sentAt);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      zcodeRefusal = request.intoThread ? null : (isZcodeProvider(request.provider) ? zcodeEnvironmentError(message) : null);
      waitRefusal = request.intoThread ? null : zcodeRefusal
        ?? (message.includes("provider_error:") ? providerLimitNotice(message.replace(/^.*?provider_error:/, "").slice(0, 400)) : null)
        ?? providerLimitNotice(message.slice(0, 400))
        ?? (/\b(subscription (?:ended|expired|inactive|canceled)|invalid api key|unauthori[sz]ed|authentication failed|quota exceeded|billing)\b/i.test(message) ? message.slice(0, 200) : null);
      if (!waitRefusal) throw cause;
    }
    let text = waitRefusal ? "" : await read();
    // A provider out of plan or quota answers with its notice and does no work (insights-post critic on acp-cursor, 2026-10-09:
    // «Upgrade your plan to continue»). The step runs once more in a fresh thread on another provider instead of failing the run.
    // Any provider, Claude included: the resolver answers with the failed provider taken out of the offer (the peer of the other family).
    const limit = waitRefusal ?? providerLimitNotice(text) ?? (isZcodeProvider(request.provider) ? zcodeEnvironmentError(text.length <= 400 ? text : null) : null);
    // A specialist or the architect runs as a Claude Code agent profile: another provider would refuse it (409), so its limit fails the step.
    if (limit && !request.intoThread && (Boolean(spec.specialist) || request.role.startsWith("specialist") || request.role === "workflow-architect")) throw new HelperFailure("provider_limit", `the ${request.role} helper hit Claude's limit (${limit}); a specialist runs only on Claude Code, so it waits for the window to reset`);
    if (limit && !request.intoThread) {
      const failed = request.provider ?? DEFAULT_PROVIDER;
      noteProviderLimit(bb, failed, request.model ?? null, limit);
      const again = await bestEffort(bb.log, "workflow helper model resolve", withResolvedModel({ ...request, provider: undefined as never, model: undefined as never, reasoning: undefined as never, serviceTier: undefined as never, resolved: undefined as never }, { avoidProvider: failed, reason: "provider_limit" }), null);
      // Nothing else on offer (the answer is the failed provider again): the step fails with the limit notice, it does not run the same pair twice.
      if (!again || again.provider === failed) throw new HelperFailure("provider_limit", `${failed}/${request.model ?? ""} hit a provider limit (${limit}) and no other model family is on offer on this machine`);
      const fallback = { ...request, ...again, provider: again.provider, model: again.model, reasoning: again.reasoning, serviceTier: request.serviceTier, spawnKey: `${request.spawnKey}:limit` };
      rt.ctx.bb.log.warn(`workflow step ${request.stepKey}: ${request.provider}/${request.model} hit a provider limit (${limit}); rerunning on ${fallback.provider}/${fallback.model}`);
      if (!zcodeRefusal) await bestEffort(bb.log, "workflow role switch", switchRoleOnLimit(request, failed, fallback, limit, await settingsOf(rt)), false);
      request = { ...request, provider: fallback.provider, model: fallback.model };
      // A fresh thread starts with the prompt: its first turn is the one to wait for, as for the first spawn.
      sentAt = undefined;
      threadId = await findOrSpawn(fallback);
      tracked.push({ id: threadId, ...(fallback.model ? { model: fallback.model } : {}), ...(fallback.provider ? { provider: fallback.provider } : {}) });
      await wait();
      text = await read();
    }
    let output: Record<string, unknown> | null = null, problem = "", broken = false;
    for (let round = 0; round < 2 && !output; round += 1) {
      try {
        const parsed = parseAgentOutput(text, request.fields);
        // An agent that says it is blocked or could not do the task owes no artifact (the hand-off standard's honest exit).
        const issues = request.contract && !honestExit(parsed) ? contractProblems(request.contract, parsed) : null;
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
    let afterPoint: RepoGuardPoint = { files: null, snap: null };
    let guard = { changed: null as string[] | null, pmOwn: null as string[] | null, engineOwn: null as string[] | null, edited: null as string[] | null };
    if (checkoutPath && checkoutHostId && beforePoint.files) {
      afterPoint = await guardPoint();
      const editable = phaseId ? (file: string) => spec.editable(file) || phaseWritable(phaseId, spec.helper)(file) : spec.editable;
      guard = await repoWatcher.compare(beforePoint.files, afterPoint.files, editable);
      if (guard.edited?.length) throw new HelperFailure("repo_edited", `the ${request.role} helper edited repository files it may not touch: ${guard.edited.slice(0, 8).join(", ")}`);
    }
    if (!output) throw new HelperFailure(broken ? "artifact_invalid" : "output_invalid", broken ? `the ${request.role} helper's answer breaks the step's contract: ${problem}` : `the ${request.role} helper's final message could not be read: ${problem}`);
    // Read last, so the repair turn counts too. A thread whose usage cannot be read, or has no usage events, reports `unknown`:
    // the engine then holds the run to a time and step limit instead of letting a token or money budget pass unseen.
    // Every thread the step started counts (a provider-limit fallback leaves the first thread behind), each from its own start marker.
    const repoGuard: RepoGuardDetail | undefined = spec.readOnly && checkoutPath && checkoutHostId
      ? { checkout: { hostId: checkoutHostId, path: checkoutPath }, watchedFrom, reusedThread: threadReused, checkoutBinding: request.intoThread || threadReused ? "unverified" : "verified", before: beforePoint.snap, after: afterPoint.snap, ...guard }
      : undefined;
    const answered = request.provider && request.model ? { providerId: request.provider, model: request.model } : undefined; // differs from the requested model after a provider fallback
    const usage = await spentBy(bb, tracked, { requestedProvider, requestedModel, answeredProvider: request.provider ?? null, answeredModel: request.model ?? null });
    return { threadId: threadId!, output, text, usage, ...(repoGuard || answered ? { detail: { ...(repoGuard ? { repoGuard } : {}), ...(answered ? { answered } : {}) } } : {}) };
  }

  return { run };
}
export type WorkflowAgents = ReturnType<typeof createWorkflowAgents>;

// ---------------------------------------------------------------- the executor of an agent node

/** The data a node hands its helper: the mapped edge fields and the node's own `with`, and the item of its branch. */
export function agentRequest(ctx: StepContext<ChainRuntime>, node: Extract<GraphNode, { type: "agent" }>, options: { byReference?: boolean; plan?: PacketPlan; filesAt?: { hostId: string; path: string } } = {}): HelperRequest {
  const rt = ctx.runtime!;
  const fields = outputFields(ctx.workflow, node) as Field[];
  // The role may be taken from an input (`specialist:{{$inputs.agentId}}`: the scheduled agent's routine runs whichever agent the schedule names).
  const role = ctx.render(node.role);
  const spec = roleSpec(role);
  const via = ctx.input.via;
  const prior = via.mode === "same-session" || via.mode === "read-prior-session" ? { mode: via.mode, threadId: via.fromThreadId ?? null } : undefined;
  const method = roleMethod(spec.helper.startsWith("specialist:") ? "" : role);
  const title = ctx.render(node.title?.en ?? node.label ?? node.id);
  const intoThread = intoThreadOf(ctx, node);
  // One plan for the packet and for what the prompt's own `{{…}}` substitutions point at (the executor hands its plan in,
  // so the files it wrote are exactly the files the prompt references).
  const plan = options.plan ?? stepPacket(ctx, node, options.byReference !== false);
  const packet = plan.packet;
  const task = renderTask(ctx, node, plan);
  // The step's own `with` over the workflow's `$inputs`: a fragment's goal reaches its helper even where no edge or node maps it. A step that
  // continues a thread was given the workflow's inputs earlier in it.
  // The routine graph of a scheduled agent carries everything the agent needs in its first message already (its `brief` step): the inputs are not repeated.
  const routine = ctx.workflow.id === AGENT_ROUTINE;
  const inputs = routine || ctx.workflow.id === SPECIALIST_GRAPH ? {} : { ...(intoThread ? {} : ctx.inputs), ...ctx.input.with };
  // K7: the first step and every third remind the helper what the whole run is for.
  const goals = ctx.reground ? goalsBlock(ctx.goals) : undefined;
  const recallHits = !intoThread && rt?.ctx?.db && rt.projectId
    ? (() => { try { return confirmedWordHits(rt.ctx.db, rt.projectId, `${title} ${task}`.slice(0, 400), { limit: 4 }); } catch { return []; } })()
    : [];
  const recallBlock = recallHits.length ? `<project_memory>\n${recallHits.map((r) => `- [${r.kind}] ${r.content.slice(0, 260)}`).join("\n")}\n</project_memory>` : "";
  const savedPlan = ctx.form === "plan" ? formatSavedPlan(ctx, node) : "";
  const enrichedTask = [savedPlan, task, recallBlock].filter(Boolean).join("\n\n");
  const body = intoThread
    ? `Continue the workflow step "${node.id}". New material for you:\n\n${packet ?? JSON.stringify(inputs, null, 1).slice(0, 20_000)}\n\n${task}${goals ? `\n\n${goals}` : ""}\n\n${outputContract(fields)}`
    : agentPrompt({ workflow: ctx.workflow.id, node: node.id, title, role, mode: ctx.mode, ...(method.length ? { method: method.join("\n") } : {}), task: enrichedTask, inputs,
      ...(ctx.input.item !== undefined ? { item: ctx.input.item } : {}), handoff: via.handoff ?? null, ...(prior ? { prior } : {}), contract: outputContract(fields),
      readOnly: spec.readOnly, skills: [...(node.skills ?? []), ...(node.profile?.skills ?? [])], ...(goals ? { goals } : {}), ...(packet ? { packet } : {}), ...(node.authorized !== undefined ? { authorized: node.authorized } : {}) });
  return {
    rt, workflowRunId: ctx.runId, workflowId: ctx.workflow.id, stepKey: ctx.stepKey, nodeId: node.id, spawnKey: ctx.spawnKey, role, title, prompt: body, fields,
    ...nodeModelOf(ctx, node), ...planModelOverride(ctx, node), ...(ctx.form ? { form: ctx.form } : {}),
    ...(routine ? routineModel(ctx.inputs ?? {}) : {}),
    skills: [...new Set([...(node.skills ?? []), ...(node.profile?.skills ?? [])])], plugins: [...new Set(node.plugins ?? [])], mcp: [...new Set(node.mcp ?? [])], intoThread, signal: ctx.signal,
    ...(typeof ctx.inputs?.risk === "string" ? { risk: ctx.inputs.risk } : {}),
    ...(ctx.checkTurn ? { checkTurn: ctx.checkTurn } : {}),
    ...(ctx.trackChild ? { trackChild: ctx.trackChild } : {}),
    ...(node.produces?.length || node.gates?.length ? { contract: { id: node.id, produces: node.produces, gates: node.gates } } : {}),
    ...(plan.files.length ? { packetFiles: plan.files, ...(options.filesAt ? { packetFilesAt: options.filesAt } : {}) } : {}),
  };
}

export const agentUsesKeyedSpawn = (rt: ChainRuntime | undefined) => Boolean(rt && keyedSpawnSupported(rt.ctx.bb));
