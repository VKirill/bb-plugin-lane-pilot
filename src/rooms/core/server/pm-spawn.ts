import type { PrototypeConfig } from "../../contracts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { RunBudgetExceeded, type RunBudget } from "@lane-pilot/resilience";
import { isZcodeProvider } from "@lane-pilot/models";
import { spawnKeyed } from "./thread-keys";
import { stringAt } from "./values";
import { noteZcodeThread, reserveZcodeSlot } from "./zcode-slot";

/**
 * The PM agents the machine's guard (~/.agents/hooks/guard_shell.py: PM_AGENTS, lane-pilot-pm) reads the rules of: it keys
 * on the agent_type of the session, so a PM started with no such agent has no guard and a write it tries goes through.
 */
const GUARDED_PM_AGENTS = new Set(["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator", "lane-pilot-pm"]);

export const pmHasGuard = (mainAgent: unknown): boolean => typeof mainAgent === "string" && GUARDED_PM_AGENTS.has(mainAgent);

export function pmPrompt(runId: string, config: PrototypeConfig, managedWorkspace = false, native = false, guarded = false): string {
  if (native) {
    return [
      "You are the Lane Pilot PM in the selected role.",
      `Run id: ${runId}. Stay in this thread's current workspace.`,
      "Wait for the user's task. Do not write code, run write probes, or dispatch a writer until the user asks.",
    ].join("\n");
  }
  return [
    "You are the Lane Pilot PM. Do not write production code yourself.",
    managedWorkspace
      ? `Run id: ${runId}. This run is bound to the current BB-managed worktree; use the current workspace and do not target the base checkout at ${config.writerWorkspacePath}.`
      : `Run id: ${runId}. The production fixture is ${config.writerWorkspacePath}.`,
    "First use Bash only for read probes: `pwd`, `ls -la`, and `cat fixture/README.md` if available.",
    ...(guarded ? ["Then demonstrate the guard by attempting a production write with Write or Bash redirection; report the denial."] : []),
    "Delegate the safe fixture task with `lane_pilot_dispatch_writer`; it returns a runId and attemptId immediately, before the writer completes.",
    "Call `lane_pilot_wait_writer` with that runId (timeoutSec at most 240). If state is still running, call it again with the same runId. Return the final receipt to the user verbatim. Do not attempt to activate another PM.",
  ].join("\n");
}

export function providerSupportsServiceTier(provider: {
  capabilities?: { supportsServiceTier?: boolean };
  supportsServiceTier?: boolean;
  serviceTiers?: ReadonlyArray<{ id?: string } | string>;
} | null | undefined): boolean {
  if (!provider) return false;
  if (provider.capabilities?.supportsServiceTier === false || provider.supportsServiceTier === false) {
    return false;
  }
  if (provider.capabilities?.supportsServiceTier === true || provider.supportsServiceTier === true) {
    return true;
  }
  if (Array.isArray(provider.serviceTiers) && provider.serviceTiers.length > 0) {
    return true;
  }
  return false;
}

const PROVIDER_LIST_TTL_MS = 60_000;

type ProviderList = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>;

const providerListByApi = new WeakMap<BbPluginApi, Map<string, { at: number; list: ProviderList }>>();

/**
 * Whether the provider takes a service tier: true or false when the provider list names it, null when the list could not
 * be read or does not name the provider. Best-effort: a failed lookup must not stop a spawn (the sdk throws synchronously
 * when a method is not available, so the call sits inside the try). The list is cached per host for a minute.
 */
async function providerSupportsTier(bb: BbPluginApi, providerId: string | undefined, hostId: string | undefined): Promise<boolean | null> {
  if (!providerId || typeof bb.sdk?.providers?.list !== "function") return null;
  let cache = providerListByApi.get(bb);
  if (!cache) {
    cache = new Map();
    providerListByApi.set(bb, cache);
  }
  const key = hostId ?? "";
  const now = Date.now();
  let entry = cache.get(key);
  if (!entry || now - entry.at > PROVIDER_LIST_TTL_MS) {
    try {
      const list = await bb.sdk.providers.list(hostId ? { hostId } : undefined);
      if (!Array.isArray(list)) throw new Error("providers.list did not return a list");
      entry = { at: now, list };
      cache.set(key, entry);
    } catch (cause) {
      bb.log.warn(`Lane Pilot: providers.list failed, the spawn of ${providerId} goes without a service tier: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    }
  }
  const provider = entry.list.find((row) => row.id === providerId);
  return provider ? providerSupportsServiceTier(provider) : null;
}

/** OpenCode v2's agent for every thread Lane Pilot starts on it (Lane Stack's `profiles/opencode/agents/lane-pilot.md`): its rules,
 * and Lane Stack's opencode-lane hooks act only in a session whose agent is a `lane-` one (the service is shared, so no env marker reaches them). */
export const OPENCODE_LANE_AGENT = "lane-pilot";
const laneAgentByApi = new WeakMap<BbPluginApi, Map<string, { at: number; models: unknown[] }>>();

/**
 * The `agent` session option an opencode2 thread starts with, when its model's catalog on the host lists Lane Pilot's agent (Lane
 * Stack installed there). Nothing for another provider, a caller that chose its options, a host without the agent (BB refuses a value
 * the model does not list) or a catalog that cannot be read: the thread then runs on OpenCode's default agent, and the log says so.
 */
async function laneAgentOption(bb: BbPluginApi, args: { providerId?: string; model?: string; environment?: { environmentId?: unknown } } & Record<string, unknown>, hostId: string | undefined): Promise<{ sessionOptions?: Record<string, string> }> {
  if (args.providerId !== "opencode2" || args.sessionOptions !== undefined) return {};
  let cache = laneAgentByApi.get(bb);
  if (!cache) { cache = new Map(); laneAgentByApi.set(bb, cache); }
  // OpenCode reads its agents from the thread's folder: an existing environment names it, otherwise the host's catalog stands in.
  const environmentId = !hostId && typeof args.environment?.environmentId === "string" ? args.environment.environmentId : undefined;
  const key = hostId ?? (environmentId ? `env:${environmentId}` : "");
  let entry = cache.get(key);
  try {
    if (!entry || Date.now() - entry.at > PROVIDER_LIST_TTL_MS) {
      const listed = await bb.sdk.providers.models(hostId ? { providerId: "opencode2", hostId } : environmentId ? { providerId: "opencode2", environmentId } : { providerId: "opencode2" });
      entry = { at: Date.now(), models: Array.isArray(listed?.models) ? listed.models : [] };
      cache.set(key, entry);
    }
  } catch (cause) {
    bb.log.warn(`Lane Pilot: the opencode2 catalog could not be read, the thread starts on OpenCode's default agent: ${cause instanceof Error ? cause.message : String(cause)}`);
    return {};
  }
  const model = entry.models.find((row) => (row as { id?: unknown }).id === args.model) ?? entry.models[0];
  const options = (model as { sessionOptions?: unknown } | undefined)?.sessionOptions;
  const agent = Array.isArray(options) ? options.find((option) => (option as { id?: unknown })?.id === "agent") as { values?: unknown } | undefined : undefined;
  if (Array.isArray(agent?.values) && agent.values.some((value) => (value as { id?: unknown })?.id === OPENCODE_LANE_AGENT)) {
    return { sessionOptions: { agent: OPENCODE_LANE_AGENT } };
  }
  bb.log.warn(`Lane Pilot: OpenCode on ${hostId ?? "the default host"} has no ${OPENCODE_LANE_AGENT} agent (Lane Stack not installed there); the thread starts on OpenCode's default agent without the lane guard`);
  return {};
}

/**
 * Every thread Lane Pilot starts (PM, writers, helpers) runs with full access. BB honours the mode only when it is
 * marked explicit; otherwise the project's remembered mode (often accept-edits) makes agents stop for approval.
 */

export function fullAccessSpawn(bb: BbPluginApi, args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) {
  enforceRunChildBudget(bb, args);
  return (async () => {
    const hostId = args.environment?.type === "host" && typeof args.environment.hostId === "string" ? args.environment.hostId : undefined;
    const [supportsTier, laneAgent] = await Promise.all([
      providerSupportsTier(bb, args.providerId, hostId),
      laneAgentOption(bb, args as unknown as Parameters<typeof laneAgentOption>[1], hostId),
    ]);
    // A tier the caller named is sent whatever the lookup says, unless the list shows the provider has no tiers.
    // With no named tier and an unknown support, nothing is guessed.
    const namedTier = args.serviceTier === "default" || args.serviceTier === "fast";
    const sendTier = supportsTier === true || (supportsTier === null && namedTier);

    const quiet = quietHelper(args, graphStepLookupByApi.get(bb));
    const { serviceTier: _incomingTier, ...restQuiet } = quiet;
    let executionInputSources = restQuiet.executionInputSources ? { ...restQuiet.executionInputSources } : undefined;
    if (executionInputSources) {
      const { serviceTier: _dropped, ...restSources } = executionInputSources;
      executionInputSources = restSources;
    }

    const requestedTier: "default" | "fast" = args.serviceTier === "fast" ? "fast" : "default";
    const full = {
      ...restQuiet,
      ...laneAgent,
      ...(sendTier ? { serviceTier: requestedTier } : {}),
      permissionMode: "full" as const,
      executionInputSources: {
        ...executionInputSources,
        permissionMode: "explicit" as const,
        ...(sendTier ? { serviceTier: "explicit" as const } : {}),
      },
    } as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0] & Record<string, unknown>;
    // With the VK thread keys the spawn is idempotent: a lost answer repeated returns the same thread (thread-keys.ts).
    // ZCode runs a few tasks at once: a spawn takes its slot before it starts, and the thread holds it until BB says it is idle (zcode-slot.ts).
    // All slots taken is the bridge's own «ZCode is busy», a free environment failure: the task goes to another model.
    const release = isZcodeProvider(args.providerId) ? reserveZcodeSlot(bb) : () => undefined;
    if (!release) throw new Error("ZCode is busy: all its parallel slots are taken by Lane Pilot tasks");
    try {
      const spawned = await spawnKeyed(bb, full, () => bb.sdk.threads.spawn(full));
      if (isZcodeProvider(args.providerId)) noteZcodeThread(bb, stringAt(spawned, "id"));
      return spawned as Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>>;
    } finally { release(); }
  })();
}

type ChildBudgetLookup = (runId: string) => RunBudget | null;

const childBudgetByApi = new WeakMap<BbPluginApi, ChildBudgetLookup>();

/** Plugin start binds this so every run-bound helper spawn shares the run's budget. */
export function bindRunChildBudget(bb: BbPluginApi, budgetFor: ChildBudgetLookup): void {
  childBudgetByApi.set(bb, budgetFor);
}

function enforceRunChildBudget(bb: BbPluginApi, args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]): void {
  const meta = args.pluginMetadata;
  if (!meta || typeof meta !== "object") return;
  const runId = meta.lanePilotRunId;
  const role = meta.role;
  if (typeof runId !== "string" || !runId || role === "pm") return;
  const budget = childBudgetByApi.get(bb)?.(runId);
  if (!budget) return;
  const check = budget.check();
  if (!check.ok) throw new RunBudgetExceeded(check);
  const reserved = budget.reserveChild();
  if (!reserved.ok) throw new RunBudgetExceeded(reserved);
}

/** Whether a run, and the step of it when one is named, exist in the workflow journal. */
type GraphStepLookup = (runId: string, stepKey?: string) => boolean;

const graphStepLookupByApi = new WeakMap<BbPluginApi, GraphStepLookup>();

/** Plugin start binds this so a graph marker counts only when it points at a real run and step (`lane_pilot_wf_run`, `lane_pilot_wf_step`). */
export function bindGraphStepLookup(bb: BbPluginApi, exists: GraphStepLookup): void {
  graphStepLookupByApi.set(bb, exists);
}

/**
 * The plugin metadata that ties a helper thread to the graph step that spawned it (the keys `workflow-agent.ts` writes for an agent node):
 * a thread with `lanePilotWorkflowRunId` ran inside a graph, which is what the daily graph-coverage line and the quiet-helper rule read.
 * Spread it into the `pluginMetadata` of a spawn made by a wrapper executor; with no step given it adds nothing.
 */
export function graphStepMetadata(step: { runId: string; stepKey?: string | undefined; nodeId?: string | undefined } | null | undefined): Record<string, string> {
  if (!step?.runId) return {};
  return { lanePilotWorkflowRunId: step.runId, ...(step.stepKey ? { lanePilotWorkflowStep: step.stepKey } : {}), ...(step.nodeId ? { lanePilotWorkflowNode: step.nodeId } : {}) };
}

/** Children the PM itself waits for or talks to; every other helper is watched by Lane Pilot. */
const LOUD_ROLES = new Set(["pm", "errand", "specialist", "self-repair"]);

/**
 * A helper Lane Pilot watches itself (writers, critiques, readers, memory, docs…) is a quiet child: its finished
 * turn does not wake the PM. Before this BB sent the whole output of each finished helper into the PM as a new turn —
 * 52 in one SelfyStudio chat — and an owner message that arrived in the same turn went unanswered (2026-10-03).
 * Needs VK core `quiet-child` (runtime vk.16); older core stores the key and ignores it.
 * A step of a graph run is always quiet, even for a loud role: the run's own end notice tells the PM, so an errand or
 * specialist step must not wake the PM chat a second time.
 */
export function quietHelper<T extends { parentThreadId?: string | null; pluginMetadata?: Record<string, unknown> }>(args: T, stepExists?: GraphStepLookup): T {
  const role = args.pluginMetadata?.role;
  const graphRun = args.pluginMetadata?.lanePilotWorkflowRunId;
  const graphStep = args.pluginMetadata?.lanePilotWorkflowStep;
  // The marker is a claim, not proof: with a journal lookup bound it must name a run (and a step) that exist, or the helper is not «inside a graph».
  const inGraph = typeof graphRun === "string" && graphRun !== ""
    && (!stepExists || stepExists(graphRun, typeof graphStep === "string" && graphStep !== "" ? graphStep : undefined));
  if (!args.parentThreadId || !args.pluginMetadata || (typeof role === "string" && LOUD_ROLES.has(role) && !inGraph)) return args;
  return { ...args, pluginMetadata: { ...args.pluginMetadata, experimental_vkQuietChild: true } };
}
