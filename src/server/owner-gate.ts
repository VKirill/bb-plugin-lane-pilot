import { getActivation, type LanePilotDatabase } from "../database";
import type { rpcContract } from "../contracts";
import { isProtectedSetting, pmThreadFor } from "./protected-settings";
import type { OwnerAsk } from "./owner-ask";
import type { ServerCore } from "./core";
import { anamnesisFor } from "../anamnesis/wiring";
import { anamnesisAccessOfRequest, type AnamnesisAccess } from "../anamnesis/access";

/**
 * Who may call the RPC methods and CLI commands of Lane Pilot (audit 2026-10-08 round 3 P0-1, round 4 P0-1, P0-4, P0-5).
 * BB's HTTP API has no login, so `curl` or `python` reaches `/api/v1/plugins/lane-pilot/rpc/<method>` and the shell guard
 * never sees it. A VK core marks every call of a plugin that declares `vk.rpcCallerPolicy` (`experimental_vkCaller`):
 *
 * - `owner-ui` (the Lane Pilot page in the owner's browser) and `owner-cli` WITH a verified proof (the core's owner login,
 *   evidence other than the client's own words): the owner. Everything passes.
 * - `unverified-owner`: the core cannot tell the owner from an agent that sent the same headers (`x-bb-vk-client: cli`). On a
 *   core without the owner login an `owner-cli` mark is this; it is never taken for the owner. Ordinary changes pass (a setting, a run control); what an agent must not do on this say-so — a
 *   protected setting (its own form), a schedule, the anamnesis, an agent profile, installs and self-repair controls — goes
 *   to the owner as a form in the PM chat.
 * - `agent-thread` (the `bb` CLI of an agent session, with the per-thread token): every change goes to the owner as a form; a
 *   yes lasts for that one call (same input) for ten minutes, then the agent calls again.
 * - `plugin`: another loaded plugin passes (not for the anamnesis).
 * - `unknown` (no marks: curl, python, node fetch): refused, no form.
 * - no mark at all (a core without the function): passes, as before. The plugin cannot tell the caller then; the shell
 *   guard and the form of the protected settings stay the only protection until the core is deployed.
 *
 * What a method is, is written once, in `RPC_CLASS`. A method that is not `read` goes through the gate; the table must name
 * every method of the contract (the type checker and a test fail on a new one that is not in it).
 */
export type RpcClass =
  /** Changes nothing; any caller. */
  | "read"
  /** Changes configuration, starts or stops work: the owner, an unverified owner; an agent through a form. */
  | "mutate"
  /** As `mutate`, but an unverified owner meets the form too: what runs on a machine, what widens an agent's reach, the owner's own data. */
  | "sensitive"
  /** The agents' own memory (`session_memory_write`, `session_lesson`): every caller, as before. */
  | "agent"
  /** `anamnesis`: judged by what the request does (anamnesis/access.ts). */
  | "anamnesis";

export const RPC_CLASS = {
  // schedule board: reading is free; making a schedule, resuming one and running one now start what runs on a machine
  schedule_list: "read", schedule_get: "read", schedule_runs: "read", schedule_preview: "read", schedule_calendar: "read",
  schedule_upsert: "sensitive", schedule_resume: "sensitive", schedule_run_now: "sensitive",
  schedule_pause: "mutate", schedule_delete: "mutate", schedule_cancel_run: "mutate",
  // preferences, projects, screens
  get_preferences: "read", list_sections: "read", list_projects: "read", get_globals: "read", get_agent_inventory: "read",
  get_screen: "read", list_runs: "read", list_run_stages: "read", get_stage_result: "read", helper_access_view: "read", activation_context: "read",
  list_helper_threads: "read", get_run_card: "read", native_thread: "read", native_install_status: "read",
  set_locale: "mutate", remember_project: "mutate", save_globals: "mutate",
  // an agent profile is the PM's prompt, tools and MCP servers
  save_agent_profile: "sensitive",
  // settings: a protected key has its own form per value for every caller (protected-settings.ts)
  save_setting: "mutate", save_settings: "mutate", reset_project_settings: "mutate", save_writer_binding: "mutate", save_writer_selection: "mutate",
  save_memory_selection: "mutate", save_night_review_selection: "mutate", save_docs_selection: "mutate", save_project_life_selection: "mutate",
  save_pm_read_selection: "mutate", save_onboarding_selection: "mutate", save_plan_critique_selection: "mutate", save_specialist_selection: "mutate",
  save_writer_fallback_selection: "mutate", save_council_seat_selection: "mutate", save_code_critique_selection: "mutate", save_rules_analyzer: "mutate",
  workflow_model_override: "mutate",
  // runs, native sessions, deploy
  halt_run: "mutate", cancel_attempt: "mutate", retry_attempt: "mutate", resume_runs: "mutate", finish_run: "mutate", activate_pm: "mutate",
  prepare_native_session: "mutate",
  // the drain only holds new work back while a deploy runs; the push script calls it and an owner form there is not wanted
  deploy_drain: "mutate", deploy_status: "read",
  native_install_start: "sensitive",
  self_repair_status: "read", self_repair_configure: "sensitive", self_repair_tick: "sensitive", canary_status: "read",
  stack_detect: "read", stack_install: "sensitive", stack_connect: "sensitive", stack_rollback: "sensitive",
  workspace_provider_status: "read", workspace_provider_reset: "mutate",
  // statistics
  writer_brief_stats: "read", critic_stats: "read", writer_reuse_stats: "read", acceptance_stats: "read", token_usage: "read", token_usage_sync: "mutate",
  secret_issuance: "read",
  // councils, rules, memory
  list_councils: "read", get_council_defaults: "read", get_council: "read", get_routing_hint: "read", council_say: "mutate", council_stop: "mutate",
  list_rule_proposals: "read", rule_set_audience: "mutate", decide_rule_proposal: "mutate", start_rule_scan: "mutate",
  memory_records_list: "read", memory_record_delete: "mutate", docs_overview: "read",
  session_memory_project: "read", session_memory_search: "read", session_memory_core: "read",
  session_memory_write: "agent", session_lesson: "agent",
  // the owner's anamnesis
  anamnesis: "anamnesis",
  // workflows
  workflow_list: "read", workflow_get: "read", workflow_run_snapshot: "read", workflow_runs: "read", workflow_preflight: "read",
  workflow_draft_list: "read", workflow_draft_get: "read", workflow_step_executors: "read", workflow_model_catalog: "read", workflow_capabilities: "read",
  workflow_run: "mutate", workflow_rerun_node: "mutate", workflow_dry_run: "mutate", workflow_run_tests: "mutate",
  workflow_draft_create: "mutate", workflow_draft_patch: "mutate", workflow_draft_restore: "mutate", workflow_draft_test: "mutate", workflow_architect_start: "mutate",
  workflow_draft_publish: "sensitive",
} as const satisfies Record<keyof typeof rpcContract, RpcClass>;

const classOf = (method: string): RpcClass => (RPC_CLASS as Record<string, RpcClass>)[method] ?? "sensitive";

/** Every method that goes through the gate: what is not `read` and not the agents' own memory. */
export const OWNER_ONLY_RPC: ReadonlySet<string> = new Set(Object.entries(RPC_CLASS).filter(([, cls]) => cls !== "read" && cls !== "agent").map(([name]) => name));

export type VkCallerKind = "owner-ui" | "owner-cli" | "unverified-owner" | "agent-thread" | "plugin" | "unknown";
export type VkCaller = { kind: VkCallerKind; threadId?: string; pluginId?: string; evidence?: string };

const KINDS: readonly string[] = ["owner-ui", "owner-cli", "unverified-owner", "agent-thread", "plugin", "unknown"];
/** What a client says about itself in a header. An `owner-cli` mark with only this behind it is not the owner. */
const CLIENT_ASSERTED_EVIDENCE: ReadonlySet<string> = new Set(["cli-header", "browser-headers", "none"]);

/**
 * The mark a VK core put on the call context, or undefined (a core without the function). `owner-cli` counts as the owner
 * only when the core proved it (an evidence other than the client's own header); otherwise it is read as `unverified-owner`,
 * so the plugin works on the current core and on one with the owner login.
 */
export function readVkCaller(rpcCtx: unknown): VkCaller | undefined {
  if (typeof rpcCtx !== "object" || rpcCtx === null) return undefined;
  const raw = (rpcCtx as { experimental_vkCaller?: unknown }).experimental_vkCaller;
  if (typeof raw !== "object" || raw === null) return undefined;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string") return undefined;
  if (!KINDS.includes(kind)) return { kind: "unknown" };
  const caller = raw as VkCaller;
  // Only the CLI mark is the forgeable one (`x-bb-vk-client: cli`, a line any curl writes). A real browser mark (`owner-ui`: same-origin
  // fetch metadata behind the host proxy, which cuts a forged Origin) keeps the Lane Pilot page working while there is no owner login.
  if (caller.kind === "owner-cli" && (typeof caller.evidence !== "string" || CLIENT_ASSERTED_EVIDENCE.has(caller.evidence))) {
    return { ...caller, kind: "unverified-owner" };
  }
  return caller;
}

/**
 * The caller of a CLI command. The CLI call also says which thread it runs in (`threadId`, from the client's environment):
 * a command with a thread is an agent's, whatever the headers claim, unless the core proved the owner. A claim of a thread
 * can only lower what the call may do.
 */
export function readCliCaller(cliCtx: unknown): VkCaller | undefined {
  const mark = readVkCaller(cliCtx);
  if (!mark) return undefined;
  const threadId = typeof (cliCtx as { threadId?: unknown }).threadId === "string" ? (cliCtx as { threadId: string }).threadId : undefined;
  if (mark.kind === "agent-thread") return mark.threadId || !threadId ? mark : { ...mark, threadId };
  if (threadId && (mark.kind === "unverified-owner" || mark.kind === "unknown")) return { kind: "agent-thread", threadId, evidence: mark.evidence ?? "cli-thread" };
  return mark;
}

export const APPROVAL_TTL_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 60 * 60_000;
const REASK_AFTER_MS = 60 * 60_000;
/** The part of an exact call the owner is shown. A schedule's command has to be read in full, so this is generous. */
const SHOWN_MAX = 3000;
const PROTECTED_AWARE: ReadonlySet<string> = new Set(["save_setting", "save_settings", "reset_project_settings"]);

export type OwnerGateVerdict = { ok: true } | { ok: false; message: string };
/**
 * The gate keeping a caller out. It is the gate working, not a fault: the RPC log calls it `refused`, not `failed`, so the
 * self-repair watcher does not open a repair thread for every script that probes a gated method.
 */
export class OwnerGateRefusal extends Error {
  readonly refused = true;
}
const OK: OwnerGateVerdict = { ok: true };
const refused = (message: string): OwnerGateVerdict => ({ ok: false, message });
/** What a caller with no identity is told: the way in that works, and that an agent asks in its chat. */
const unknownMessage = (label: string): string =>
  `Refused: ${label} came with no identity (a bare HTTP call). Use the Lane Pilot page in BB or \`bb\` (\`bb plugin rpc call lane-pilot …\`, \`bb lane-pilot …\`); an agent runs it from its own session, and a form to the owner appears in the PM chat by itself when it is needed.`;

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v)) ?? "null";

/** The setting keys a settings call touches, to leave the protected ones to their own form. */
function settingKeys(method: string, input: unknown): string[] {
  const body = (input ?? {}) as { key?: unknown; keys?: unknown; changes?: unknown };
  if (method === "save_setting") return typeof body.key === "string" ? [body.key] : [];
  if (method === "reset_project_settings") return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
  return Array.isArray(body.changes) ? body.changes.map((c) => (c as { key?: unknown })?.key).filter((k): k is string => typeof k === "string") : [];
}

/** The project a call is about, to open the form in its PM chat. */
function projectOf(input: unknown): string {
  const body = (input ?? {}) as { projectId?: unknown; definition?: { projectId?: unknown } };
  if (typeof body.projectId === "string" && body.projectId) return body.projectId;
  const nested = body.definition?.projectId;
  return typeof nested === "string" && nested ? nested : "*";
}

export type OwnerGateDeps = {
  db: LanePilotDatabase;
  ownerAsk: OwnerAsk | undefined;
  log: (message: string) => void;
  /** Null when this thread may read the owner's anamnesis; otherwise why not (writers, helpers and stage threads never may). */
  denyThread?: (threadId: string | undefined) => Promise<string | null>;
};

export function createOwnerGate(deps: OwnerGateDeps) {
  const approved = new Map<string, number>();
  const open = new Map<string, number>();
  const quietUntil = new Map<string, number>();

  /** The verdict for a caller that a table class does not settle on its own. */
  function judge(label: string, cls: "mutate" | "sensitive", input: unknown, caller: VkCaller, now: number, protectedKeys: boolean): OwnerGateVerdict {
    switch (caller.kind) {
      case "owner-ui": case "owner-cli": case "plugin":
        return OK;
      case "unverified-owner":
        if (cls === "mutate" || protectedKeys) return OK;
        return form(label, input, caller, now, "unverified");
      case "agent-thread":
        deps.log(`Lane Pilot: ${label} from an agent-thread caller${caller.threadId ? ` (thread ${caller.threadId})` : ""}`);
        // A protected setting has its own form tied to the value; a second one for the same change would only repeat it.
        if (protectedKeys) return OK;
        return form(label, input, caller, now, "agent");
      default:
        deps.log(`Lane Pilot: ${label} refused for a ${caller.kind} caller`);
        return refused(unknownMessage(label));
    }
  }

  async function check(method: string, input: unknown, rpcCtx: unknown, now = Date.now()): Promise<OwnerGateVerdict> {
    const cls = classOf(method);
    if (cls === "read" || cls === "agent") return OK;
    const caller = readVkCaller(rpcCtx);
    if (caller === undefined) return OK;
    if (cls === "anamnesis") {
      return checkAnamnesis(anamnesisAccessOfRequest((input as { request?: unknown } | undefined)?.request), method, input, caller, now);
    }
    const protectedKeys = PROTECTED_AWARE.has(method) && settingKeys(method, input).some(isProtectedSetting);
    return judge(method, cls, input, caller, now, protectedKeys);
  }

  /** A command line (`bb lane-pilot schedule …`) judged as the RPC method it is the twin of. */
  async function checkCli(method: keyof typeof RPC_CLASS, input: unknown, cliCtx: unknown, now = Date.now()): Promise<OwnerGateVerdict> {
    const cls = classOf(method);
    if (cls === "read" || cls === "agent") return OK;
    const caller = readCliCaller(cliCtx);
    if (caller === undefined) return OK;
    if (cls === "anamnesis") throw new Error("use checkAnamnesisCli");
    return judge(`bb lane-pilot ${method}`, cls, input, caller, now, false);
  }

  /**
   * The anamnesis: reading what is not marked sensitive is for the owner and for an ordinary or PM chat (never a writer, helper
   * or stage thread); reading sensitive records is for the verified owner, an unverified one through a form, and never for an
   * agent; every change is the verified owner's, an unverified owner's or an agent's through a form. What would widen what agents
   * see or send out (public, confirmed, sensitive to Jev) is the owner's alone: an agent is refused outright.
   */
  async function checkAnamnesis(access: AnamnesisAccess, label: string, input: unknown, caller: VkCaller, now: number): Promise<OwnerGateVerdict> {
    switch (caller.kind) {
      case "owner-ui": case "owner-cli":
        return OK;
      case "plugin":
        return access === "read" ? OK : refused(`Refused: ${label} changes or shows the owner's sensitive records; another plugin may only read the rest.`);
      case "unverified-owner":
        return access === "read" ? OK : form(`${label}`, input, caller, now, "unverified");
      case "agent-thread": {
        const denied = await deps.denyThread?.(caller.threadId);
        if (denied) return refused(`Refused: ${denied}`);
        if (access === "read") return OK;
        if (access === "sensitive-read") return refused("Refused: sensitive records of the owner's anamnesis are not shown to an agent. Do not ask for a form: tell the owner what you need; they read the record themselves in the Lane Pilot page or their own terminal and give you what is fit to share.");
        if (access === "write-owner") return refused(`Refused: ${label} makes records public or confirmed, or lets sensitive text go to Jev; only the owner does that, not an agent. Tell the owner what to run in their own terminal; no form will come for it.`);
        deps.log(`Lane Pilot: ${label} from an agent-thread caller${caller.threadId ? ` (thread ${caller.threadId})` : ""}`);
        return form(label, input, caller, now, "agent");
      }
      default:
        deps.log(`Lane Pilot: ${label} refused for a ${caller.kind} caller`);
        return refused(unknownMessage(label));
    }
  }

  async function checkAnamnesisCli(access: AnamnesisAccess, input: unknown, cliCtx: unknown, now = Date.now()): Promise<OwnerGateVerdict> {
    const caller = readCliCaller(cliCtx);
    if (caller === undefined) return OK;
    return checkAnamnesis(access, "bb lane-pilot anamnesis", input, caller, now);
  }

  /** Puts the exact call to the owner in a PM chat; a yes lets that one call through for ten minutes. */
  function form(label: string, input: unknown, caller: VkCaller, now: number, who: "agent" | "unverified"): OwnerGateVerdict {
    const id = `${label}|${stable(input)}`;
    if ((approved.get(id) ?? 0) > now) { approved.delete(id); return OK; }
    return refused(ask(label, input, projectOf(input), caller.threadId, id, now, who));
  }

  function ask(label: string, input: unknown, projectId: string, callerThreadId: string | undefined, id: string, now: number, who: "agent" | "unverified"): string {
    const head = who === "agent"
      ? `${label} changes Lane Pilot's configuration or what it runs, and only the owner does that.`
      : `${label} needs the owner's confirmation: this call cannot be told from an agent's.`;
    if ((open.get(id) ?? -Infinity) + ASK_TIMEOUT_MS + 60_000 > now) return `${head} A question is open in the PM chat; answer it there, then call again.`;
    if ((quietUntil.get(id) ?? 0) > now) return `${head} The owner declined this call a short while ago; do not try to work around it.`;
    // The project's PM chat; else the chat the call came from; else the latest PM chat.
    const threadId = (projectId !== "*" ? getActivation(deps.db, projectId)?.pm_thread_id : undefined) ?? callerThreadId ?? pmThreadFor(deps.db, projectId);
    if (!threadId || !deps.ownerAsk) return `${head} No PM chat is open to ask in: open the project's PM chat in BB, then call again.`;
    const text = stable(input);
    const shown = text.length > SHOWN_MAX ? `${text.slice(0, SHOWN_MAX)} … (+${text.length - SHOWN_MAX} more characters)` : text;
    open.set(id, now);
    void deps.ownerAsk.askInBackground(threadId, {
      source: "secret",
      question: `Allow ${who === "agent" ? "an agent to call" : "this call of"} ${label}?`,
      detail: [`${label} ${shown}`, "", who === "agent"
        ? "This changes how Lane Pilot is configured, what it runs or what it knows about you. If you did not ask for it, say no."
        : "BB cannot tell whether this came from you or from an agent that sent the same headers. If you did not just do this yourself, say no.",
        `A yes is for this exact call only and lasts ${APPROVAL_TTL_MS / 60_000} minutes: call it again.`].join("\n"),
      options: ["Allow this call", "Do not allow"],
      allowText: false,
    }, (answer) => {
      open.delete(id);
      if (answer.outcome === "answered" && answer.choice?.id === "1") {
        approved.set(id, Date.now() + APPROVAL_TTL_MS);
        deps.log(`Lane Pilot: the owner allowed ${label} (project ${projectId})`);
      } else quietUntil.set(id, Date.now() + REASK_AFTER_MS);
    }, { timeoutMs: ASK_TIMEOUT_MS }).then((shownForm) => {
      if (!shownForm) open.delete(id);
    }).catch(() => open.delete(id));
    return `${head} The owner was asked in the PM chat; once they allow it, call again.`;
  }

  return { check, checkCli, checkAnamnesisCli };
}

export type OwnerGate = ReturnType<typeof createOwnerGate>;

const gates = new WeakMap<object, OwnerGate>();
/** The one gate of a plugin instance, shared by the RPC handlers and the CLI commands (one set of open questions and yeses). */
export function ownerGateFor(ctx: ServerCore): OwnerGate {
  let gate = gates.get(ctx);
  if (!gate) {
    gate = createOwnerGate({ db: ctx.db, ownerAsk: ctx.ownerAsk, log: ctx.log, denyThread: (threadId) => anamnesisFor(ctx).deny(threadId) });
    gates.set(ctx, gate);
  }
  return gate;
}

/** The handlers with every method that is not a plain read behind the gate; the rest are the same functions. */
export function guardRpc<T extends Record<string, (...args: never[]) => unknown>>(handlers: T, gate: OwnerGate): T {
  const wrapped: Record<string, unknown> = { ...handlers };
  for (const name of Object.keys(handlers)) {
    const cls = classOf(name);
    if (cls === "read" || cls === "agent") continue;
    const handler = handlers[name] as (input: unknown, rpcCtx?: unknown) => unknown;
    wrapped[name] = async (input: unknown, rpcCtx?: unknown) => {
      const verdict = await gate.check(name, input, rpcCtx);
      if (!verdict.ok) throw new OwnerGateRefusal(verdict.message);
      return handler(input, rpcCtx);
    };
  }
  return wrapped as T;
}
