import type { PrototypeConfig } from "../../contracts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { RunBudgetExceeded, type RunBudget } from "@lane-pilot/resilience";
import { spawnKeyed } from "./thread-keys";

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

/**
 * Every thread Lane Pilot starts (PM, writers, helpers) runs with full access. BB honours the mode only when it is
 * marked explicit; otherwise the project's remembered mode (often accept-edits) makes agents stop for approval.
 */

export function fullAccessSpawn(bb: BbPluginApi, args: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]) {
  enforceRunChildBudget(bb, args);
  return (async () => {
    const hostId = args.environment?.type === "host" && typeof args.environment.hostId === "string" ? args.environment.hostId : undefined;
    const supportsTier = await providerSupportsTier(bb, args.providerId, hostId);
    // An unknown tier support sends only a tier the caller configured: "fast" is honoured, "default" is not guessed.
    const sendTier = supportsTier === true || (supportsTier === null && args.serviceTier === "fast");

    const quiet = quietHelper(args);
    const { serviceTier: _incomingTier, ...restQuiet } = quiet;
    let executionInputSources = restQuiet.executionInputSources ? { ...restQuiet.executionInputSources } : undefined;
    if (executionInputSources) {
      const { serviceTier: _dropped, ...restSources } = executionInputSources;
      executionInputSources = restSources;
    }

    const requestedTier: "default" | "fast" = args.serviceTier === "fast" ? "fast" : "default";
    const full = {
      ...restQuiet,
      ...(sendTier ? { serviceTier: requestedTier } : {}),
      permissionMode: "full" as const,
      executionInputSources: {
        ...executionInputSources,
        permissionMode: "explicit" as const,
        ...(sendTier ? { serviceTier: "explicit" as const } : {}),
      },
    } as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0] & Record<string, unknown>;
    // With the VK thread keys the spawn is idempotent: a lost answer repeated returns the same thread (thread-keys.ts).
    return spawnKeyed(bb, full, () => bb.sdk.threads.spawn(full)) as ReturnType<BbPluginApi["sdk"]["threads"]["spawn"]>;
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

/** Children the PM itself waits for or talks to; every other helper is watched by Lane Pilot. */
const LOUD_ROLES = new Set(["pm", "errand", "specialist", "self-repair"]);

/**
 * A helper Lane Pilot watches itself (writers, critiques, readers, memory, docs…) is a quiet child: its finished
 * turn does not wake the PM. Before this BB sent the whole output of each finished helper into the PM as a new turn —
 * 52 in one SelfyStudio chat — and an owner message that arrived in the same turn went unanswered (2026-10-03).
 * Needs VK core `quiet-child` (runtime vk.16); older core stores the key and ignores it.
 */
export function quietHelper<T extends { parentThreadId?: string | null; pluginMetadata?: Record<string, unknown> }>(args: T): T {
  const role = args.pluginMetadata?.role;
  if (!args.parentThreadId || !args.pluginMetadata || (typeof role === "string" && LOUD_ROLES.has(role))) return args;
  return { ...args, pluginMetadata: { ...args.pluginMetadata, experimental_vkQuietChild: true } };
}
