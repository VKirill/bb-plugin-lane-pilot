import type { LanePilotDatabase } from "../database";
import { isProtectedSetting, pmThreadFor } from "./protected-settings";
import type { OwnerAsk } from "./owner-ask";

/**
 * Who may call the RPC methods that change Lane Pilot's configuration or run state (audit 2026-10-08 round 3, P0 item 1).
 * BB's HTTP API has no login, so `curl` or `python` reaches `/api/v1/plugins/lane-pilot/rpc/<method>` and the shell guard
 * never sees it. A VK core marks every call of a plugin that declares `vk.rpcCallerPolicy` (`experimental_vkCaller`):
 *
 * - `owner-ui`, `owner-cli`, `plugin`: pass.
 * - `agent-thread` (the bb CLI in an agent session, carries the per-thread token): the owner's form in the PM chat; a yes
 *   lasts for that one call (same input) for ten minutes, then the agent calls again.
 * - `unknown` (no marks: curl, python, node fetch): refused, no form.
 * - no mark at all (a core without the function): passes, as before. The plugin cannot tell the caller then; the shell
 *   guard and the form of the protected settings stay the only protection until the core is deployed.
 *
 * `owner-ui` and `owner-cli` are client-asserted marks: they stop scripts that carry none and the bb CLI inside an agent
 * session, not a client that forges them on purpose. The protected settings keep their own form per value.
 * Read-only methods and the agents' own memory methods (`session_memory_*`, `session_lesson`) are not here.
 */
export const OWNER_ONLY_RPC: ReadonlySet<string> = new Set([
  // configuration: every save_*, reset_* and set_* method
  "set_locale", "save_globals", "save_agent_profile", "save_setting", "save_settings", "reset_project_settings", "save_writer_binding",
  "save_writer_selection", "save_memory_selection", "save_night_review_selection", "save_docs_selection", "save_project_life_selection",
  "save_pm_read_selection", "save_onboarding_selection", "save_plan_critique_selection", "save_specialist_selection",
  "save_writer_fallback_selection", "save_council_seat_selection", "save_code_critique_selection", "save_rules_analyzer",
  "workflow_model_override", "workflow_draft_publish",
  // runs, repair, deploy, host
  "self_repair_configure", "self_repair_tick", "deploy_drain", "workspace_provider_reset", "halt_run", "cancel_attempt", "retry_attempt",
  "resume_runs", "finish_run", "activate_pm", "native_install_start", "stack_install", "stack_connect", "stack_rollback",
  // rules, memory records, councils (the owner's voice)
  "decide_rule_proposal", "rule_set_audience", "memory_record_delete", "council_say", "council_stop",
]);

export type VkCallerKind = "owner-ui" | "owner-cli" | "agent-thread" | "plugin" | "unknown";
export type VkCaller = { kind: VkCallerKind; threadId?: string; pluginId?: string; evidence?: string };

const KINDS: readonly string[] = ["owner-ui", "owner-cli", "agent-thread", "plugin", "unknown"];

/** The mark a VK core put on the call context, or undefined (a core without the function). */
export function readVkCaller(rpcCtx: unknown): VkCaller | undefined {
  if (typeof rpcCtx !== "object" || rpcCtx === null) return undefined;
  const raw = (rpcCtx as { experimental_vkCaller?: unknown }).experimental_vkCaller;
  if (typeof raw !== "object" || raw === null) return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string") return undefined;
  return KINDS.includes(kind) ? (raw as VkCaller) : { kind: "unknown" };
}

export const APPROVAL_TTL_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 60 * 60_000;
const REASK_AFTER_MS = 60 * 60_000;
const PROTECTED_AWARE: ReadonlySet<string> = new Set(["save_setting", "save_settings", "reset_project_settings"]);

export type OwnerGateVerdict = { ok: true } | { ok: false; message: string };

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v)) ?? "null";

/** The setting keys a settings call touches, to leave the protected ones to their own form. */
function settingKeys(method: string, input: unknown): string[] {
  const body = (input ?? {}) as { key?: unknown; keys?: unknown; changes?: unknown };
  if (method === "save_setting") return typeof body.key === "string" ? [body.key] : [];
  if (method === "reset_project_settings") return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
  return Array.isArray(body.changes) ? body.changes.map((c) => (c as { key?: unknown })?.key).filter((k): k is string => typeof k === "string") : [];
}

export function createOwnerGate(deps: { db: LanePilotDatabase; ownerAsk: OwnerAsk | undefined; log: (message: string) => void }) {
  const approved = new Map<string, number>();
  const open = new Map<string, number>();
  const quietUntil = new Map<string, number>();

  function check(method: string, input: unknown, rpcCtx: unknown, now = Date.now()): OwnerGateVerdict {
    if (!OWNER_ONLY_RPC.has(method)) return { ok: true };
    const caller = readVkCaller(rpcCtx);
    if (caller === undefined) return { ok: true };
    if (caller.kind === "owner-ui" || caller.kind === "owner-cli" || caller.kind === "plugin") return { ok: true };
    deps.log(`Lane Pilot: rpc ${method} from a ${caller.kind} caller${caller.threadId ? ` (thread ${caller.threadId})` : ""}`);
    if (caller.kind !== "agent-thread") {
      return { ok: false, message: `Refused: ${method} is available only from the Lane Pilot page in BB and the owner's bb CLI.` };
    }
    // A protected setting has its own form tied to the value; a second one for the same change would only repeat it.
    if (PROTECTED_AWARE.has(method) && settingKeys(method, input).some(isProtectedSetting)) return { ok: true };

    const body = (input ?? {}) as { projectId?: unknown };
    const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : "*";
    const id = `${method}|${stable(input)}`;
    if ((approved.get(id) ?? 0) > now) { approved.delete(id); return { ok: true }; }
    return { ok: false, message: ask(method, input, projectId, caller.threadId, id, now) };
  }

  function ask(method: string, input: unknown, projectId: string, callerThreadId: string | undefined, id: string, now: number): string {
    const head = `${method} changes Lane Pilot's configuration or runs, and only the owner does that.`;
    if ((open.get(id) ?? -Infinity) + ASK_TIMEOUT_MS + 60_000 > now) return `${head} A question is open in the PM chat; answer it there, then call again.`;
    if ((quietUntil.get(id) ?? 0) > now) return `${head} The owner declined this call a short while ago; do not try to work around it.`;
    const threadId = pmThreadFor(deps.db, projectId) ?? callerThreadId;
    if (!threadId || !deps.ownerAsk) return `${head} No PM chat is open to ask in: open the project's PM chat in BB, then call again.`;
    const shown = stable(input).slice(0, 600);
    open.set(id, now);
    void deps.ownerAsk.askInBackground(threadId, {
      source: "secret",
      question: `Allow an agent to call ${method}?`,
      detail: [`${method} ${shown}`, "", "This changes how Lane Pilot is configured or what it runs. If you did not ask for it, say no.",
        `A yes is for this exact call only and lasts ${APPROVAL_TTL_MS / 60_000} minutes: the agent calls it again.`].join("\n"),
      options: ["Allow this call", "Do not allow"],
      allowText: false,
    }, (answer) => {
      open.delete(id);
      if (answer.outcome === "answered" && answer.choice?.id === "1") {
        approved.set(id, Date.now() + APPROVAL_TTL_MS);
        deps.log(`Lane Pilot: the owner allowed ${method} for an agent (project ${projectId})`);
      } else quietUntil.set(id, Date.now() + REASK_AFTER_MS);
    }, { timeoutMs: ASK_TIMEOUT_MS }).then((shownForm) => {
      if (!shownForm) open.delete(id);
    }).catch(() => open.delete(id));
    return `${head} The owner was asked in the PM chat; once they allow it, call again.`;
  }

  return { check };
}

export type OwnerGate = ReturnType<typeof createOwnerGate>;

/** The handlers with the owner-only methods behind the gate; the rest are the same functions. */
export function guardOwnerOnlyRpc<T extends Record<string, (...args: never[]) => unknown>>(handlers: T, gate: OwnerGate): T {
  const wrapped: Record<string, unknown> = { ...handlers };
  for (const name of Object.keys(handlers)) {
    if (!OWNER_ONLY_RPC.has(name)) continue;
    const handler = handlers[name] as (input: unknown, rpcCtx?: unknown) => unknown;
    wrapped[name] = async (input: unknown, rpcCtx?: unknown) => {
      const verdict = gate.check(name, input, rpcCtx);
      if (!verdict.ok) throw new Error(verdict.message);
      return handler(input, rpcCtx);
    };
  }
  return wrapped as T;
}
