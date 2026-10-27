/**
 * ONE table «role -> model» for every agent step of every graph (the owner's decision of 2026-10-27, Maslov's method: the model belongs
 * to the role, not to the step). A step names a role; the role names the model. No per-step override, no node-level model, no presets.
 *
 * Where a role's model comes from, first hit wins:
 *  1. the owner's row of the table: the setting `role_model.<role>` = `{ model, reasoning_effort? }` (project, section or global level);
 *  2. a stage selection the owner set before the table existed (`pm_read`, `plan_critique`, `code_critique`, `night_review`,
 *     `specialist`, `errand`, `workflow.debugger`): it keeps working for the roles listed in LEGACY_STAGES, so nothing set earlier is lost;
 *  3. the built-in default below.
 * The writer of a task is NOT in this table: it stays the pick of Jev from the writers' anamnesis (model-profiles.ts).
 *
 * The options of the table are the Claude, GPT, Gemini Flash (through 9router) and ZCode GLM-5.3-Flash models the machines offer, nothing else.
 */
import { belowTier, modelTier, type ModelTier } from "./model-tiers";
import { offeredOnHost, type ModelCatalog } from "./model-catalog";

export type ModelFamily = "claude" | "gpt" | "google" | "glm";
export type RoleModelOption = {
  id: string; providerId: string; label: string; family: ModelFamily; tier: ModelTier;
  /** The effort the model runs on when the owner picks it for a row without naming one (the model's own catalog default; the row's effort may not exist for it). */
  defaultEffort?: string;
  /** The efforts the model has when they are fewer than the table's list (ZCode: low, high, max); a row naming another is not valid. */
  efforts?: readonly string[];
  /** Matched by its full id only: a model of another provider whose name ends in the same words (`zai-coding-plan/glm-5.3-flash`) is not this option. */
  exactOnly?: boolean;
};

export const ROLE_MODEL_OPTIONS: readonly RoleModelOption[] = [
  { id: "claude-fable-5-1", providerId: "claude-code", label: "Claude Fable 5.1", family: "claude", tier: "strong" },
  { id: "claude-opus-5-5", providerId: "claude-code", label: "Claude Opus 5.5", family: "claude", tier: "strong" },
  { id: "claude-sonnet-5-5", providerId: "claude-code", label: "Claude Sonnet 5.5", family: "claude", tier: "standard" },
  { id: "claude-haiku-5-5", providerId: "claude-code", label: "Claude Haiku 5.5", family: "claude", tier: "light" },
  { id: "gpt-6.1-sol", providerId: "codex", label: "GPT-6.1 Sol", family: "gpt", tier: "strong" },
  { id: "gpt-6.1-terra", providerId: "codex", label: "GPT-6.1 Terra", family: "gpt", tier: "standard" },
  { id: "gpt-6-astra", providerId: "codex", label: "GPT-6 Astra", family: "gpt", tier: "strong" },
  { id: "gpt-6-luna", providerId: "codex", label: "GPT-6 Luna", family: "gpt", tier: "light" },
  // The owner's near-free Gemini subscription through 9router (OpenCode v2 provider `opencode2`, 2026-10-27): the judges' default. The «high» is
  // in the model's name; the reasoning effort stays the catalog default «medium» (what the writer profile and the harness editor run on).
  { id: "router9/ag/gemini-3.8-flash-high", providerId: "opencode2", label: "Gemini 3.8 Flash (9router)", family: "google", tier: "standard", defaultEffort: "medium" },
  // The owner's ZCode app on the Mac mini (BB provider `zcode`, zcbridge): GLM-5.3-Flash, free 15:00-01:00 UTC. Never a default of a row. It is offered only
  // where packages/models/src/zcode.ts says it can work (the Mac mini, the free window unless `zcode.window` = always, no other ZCode task running); else the row's default runs.
  { id: "glm-5.3-flash", providerId: "zcode", label: "ZCode · GLM-5.3-Flash", family: "glm", tier: "light", defaultEffort: "high", efforts: ["low", "high", "max"], exactOnly: true },
];
/** The reasoning efforts the table offers (the narrower the model's own list, the fewer the picker shows). */
export const ROLE_MODEL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The option with exactly this id (what a stored `role_model.<role>` must name). */
export const roleModelOption = (model: string): RoleModelOption | undefined => ROLE_MODEL_OPTIONS.find((row) => row.id === model);
/** The option a model name stands for: its own id, else the id after the last slash (`openai/gpt-6.1-sol` is `gpt-6.1-sol`). */
const optionOfName = (model: string): RoleModelOption | undefined => {
  const short = roleModelOption(model.slice(model.lastIndexOf("/") + 1));
  return roleModelOption(model) ?? (short?.exactOnly ? undefined : short);
};

/** The family of a model: its option's, else read off the name (a legacy stage selection may name any model); null when neither. */
export function modelFamily(model: string | null | undefined): ModelFamily | null {
  if (!model) return null;
  const known = optionOfName(model);
  if (known) return known.family;
  if (/claude|opus|sonnet|haiku/i.test(model)) return "claude";
  if (/gpt-|\bo\d\b|codex/i.test(model)) return "gpt";
  if (/gemini|router9\/ag\//i.test(model)) return "google";
  if (/glm/i.test(model)) return "glm";
  return null;
}

export type RoleDefault = { model: string; effort: string; why: string };
export type RoleRow = {
  id: string;
  /** The built-in model. The `why` is the reason for the pick: it is shown in the table and kept here as the one place it is written. */
  default: RoleDefault;
  /** The least a model of this role may be when it was inherited (a legacy selection): a lighter one is raised to the default. The table's own pick is kept. */
  least?: ModelTier;
  /**
   * For a row whose default is a Gemini (the 9router subscription may be absent from the machine or spent): the model it runs on then, the
   * strongest other-family model it ran on before. The resolver tries it right after the default, before the PM chat's model.
   */
  fallback?: { model: string; effort: string };
  /** The settings prefixes of the stage selections the role keeps reading, in order. */
  legacy?: readonly string[];
};

/**
 * Why each default (Maslov: the judge comes from another family than the author; the author is Claude, so the judges are not Claude):
 *  - authors (analyst, planner, architect, specialists): Claude Opus 5.5 high, the strongest author we have; they write the documents and plans;
 *  - the reviews (plan-critic, specialist-reviewer, code-critic, which the phase wave review lp.review also runs, and the failure triager):
 *    Gemini 3.8 Flash through 9router (owner's decision of 2026-10-27: a near-free subscription with many accounts, while Claude's weekly
 *    window is at 98%, so Claude and GPT limits go to the authors). When the machine does not offer it, or its usage source says spent, or a
 *    call hits its limit, the review takes `fallback`, the GPT model it ran on before;
 *  - the judges that stay on GPT (auditor, debugger, council chair): GPT-6.1 Sol high, the strongest model of the other family; it
 *    reads what the Claude authors wrote and finds what they cannot see in their own work. The debugger is a judge of causes, not an author;
 *  - cheap judgments (pm-reader, memory, project-life, errand, browser-qa): the small models, picked by what the job is;
 *  - upkeep authors (docs-maintainer: Luna, a text job with a code checker behind it; repairer: Opus, the engineer who fixes Lane Pilot itself).
 */
const GEMINI_FLASH = "router9/ag/gemini-3.8-flash-high";
export const ROLE_TABLE: readonly RoleRow[] = [
  { id: "analyst", default: { model: "claude-opus-5-5", effort: "high", why: "Reads the goal and the project and writes the analysis the plan stands on; an author, so Claude." } },
  { id: "planner", default: { model: "claude-opus-5-5", effort: "high", why: "Writes the phase plans every task is cut from; the strongest author." }, least: "strong" },
  { id: "workflow-architect", default: { model: "claude-opus-5-5", effort: "high", why: "Designs a graph from a conversation with the owner; an author." } },
  { id: "specialist", default: { model: "claude-opus-5-5", effort: "high", why: "Design, copy, SEO, video, research and the owner's own agents (unless an agent names its own model); they write text and design." }, legacy: ["specialist"] },
  { id: "plan-critic", default: { model: GEMINI_FLASH, effort: "medium", why: "Judges the planner's plan; another family than its Claude author, on the near-free Gemini subscription so Claude and GPT limits go to the authors. Without it: GPT-6.1 Sol." }, fallback: { model: "gpt-6.1-sol", effort: "high" }, legacy: ["plan_critique"] },
  { id: "specialist-reviewer", default: { model: GEMINI_FLASH, effort: "medium", why: "A second, domain-minded look at the plan before the work starts: a judge, another family than the planner, on the near-free Gemini subscription. Without it: GPT-6.1 Sol." }, fallback: { model: "gpt-6.1-sol", effort: "high" }, legacy: ["specialist"] },
  { id: "code-critic", default: { model: GEMINI_FLASH, effort: "medium", why: "Judges the writer's diff and every dimension of a wave review (lp.review), on the near-free Gemini subscription; when the writer is a Gemini model it runs on GPT-6.1 Sol instead (cross-family rule), and so it does when Gemini is not offered or is spent." }, fallback: { model: "gpt-6.1-sol", effort: "high" }, least: "standard", legacy: ["code_critique"] },
  { id: "auditor", default: { model: "gpt-6.1-sol", effort: "high", why: "Audits the finished work against the goal; another family than the Claude authors." }, least: "standard", legacy: ["code_critique", "night_review"] },
  { id: "debugger", default: { model: "gpt-6.1-sol", effort: "high", why: "Finds the cause of a failure by reading logs and code: a judge of causes, strong at terminal-heavy work." }, least: "standard", legacy: ["workflow.debugger", "specialist"] },
  { id: "council", default: { model: "gpt-6.1-sol", effort: "high", why: "The chair weighs the seats' opinions: a judge, not an author." } },
  { id: "pm-reader", default: { model: "claude-haiku-5-5", effort: "low", why: "Reads long files and pulls out what the PM asked for: cheap, fast extraction." }, legacy: ["pm_read"] },
  { id: "rules-analyzer", default: { model: "gpt-6-luna", effort: "high", why: "Reads a project's failed writer attempts at night and writes the project rules that would have prevented them (and rewrites a rule that did not work). Luna with high effort set aside failures that were not the writers' where a stronger author wrote a rule that sent writers outside their paths; it is also the cheap one for a job that runs every night." } },
  { id: "triager", default: { model: GEMINI_FLASH, effort: "medium", why: "Sorts a failed gate into its class: a cheap judgment on the failure of a writer's work, on the near-free Gemini subscription. Without it: Luna with high effort, which reads a log as well as a Haiku." }, fallback: { model: "gpt-6-luna", effort: "high" } },
  { id: "memory", default: { model: "claude-haiku-5-5", effort: "medium", why: "Distils notes and facts into the memory: a small, careful text job." }, legacy: ["memory"] },
  { id: "project-life", default: { model: "claude-haiku-5-5", effort: "medium", why: "Keeps PROGRESS and CHANGELOG up to date from what happened: short factual text." }, legacy: ["project_life"] },
  { id: "errand", default: { model: "claude-sonnet-5-5", effort: "medium", why: "Runs a script, a send or a check as told: tool use, no deep thinking." }, legacy: ["errand"] },
  { id: "browser-qa", default: { model: "claude-sonnet-5-5", effort: "medium", why: "Drives a browser and reports what it sees: fast, steady tool use." } },
  { id: "docs-maintainer", default: { model: "gpt-6-luna", effort: "high", why: "Writes and refreshes the repository docs overnight from the code diff, many pages, each held to cited lines and then checked by code and Jev; Luna is cheap and, at high effort, careful enough for a text job with a hard checker behind it (a docs.* selection set before the table keeps working until the table gets its own row)." }, legacy: ["docs"] },
  { id: "repairer", default: { model: "claude-opus-5-5", effort: "high", why: "The self-repair engineer: reads logs and the hub's data, finds the cause of Lane Pilot's own fault, fixes the code and adds the test that fails without the fix; an author of code, so the strongest author we have." } },
];

export const ROLE_IDS: readonly string[] = ROLE_TABLE.map((row) => row.id);
export const ROLE_MODEL_KEY_PREFIX = "role_model.";
export const roleModelKey = (role: string): string => `${ROLE_MODEL_KEY_PREFIX}${role}`;

/** Role names a graph or a helper uses for the same job as a table row. Anything not listed and not a row is the analyst's job (as roleSpec reads it). */
const ALIASES: Record<string, string> = {
  "gate-triage": "triager", "memory-maintainer": "memory", "council-seat": "council", "night-reviewer": "auditor",
  worker: "analyst",
};

/** The row of the table a role belongs to. */
export function roleRowOf(role: string): string {
  if (role.startsWith("specialist:")) return "specialist";
  if (ROLE_IDS.includes(role)) return role;
  return ALIASES[role] ?? "analyst";
}
export const roleRow = (role: string): RoleRow => ROLE_TABLE.find((row) => row.id === roleRowOf(role))!;

/** The effort a legacy stage runs on when it sets none (what the stage ran on before the table). */
const STAGE_EFFORT: Record<string, string> = { pm_read: "low", plan_critique: "medium", code_critique: "medium", night_review: "high", specialist: "high" };

export type RoleModelSource = "table" | "stage" | "default";
export type RoleModel = {
  providerId: string; model: string; effort: string; source: RoleModelSource;
  /** The setting the value comes from (`role_model.<role>`, `pm_read.model`...); null for the built-in default. */
  sourceKey: string | null;
  /** True when a legacy selection was passed over because it is below the role's least tier. */
  escalated?: boolean;
};

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The owner's row for a role when it is a valid pick of the table (a model of the six, an effort of the list, or none); else null. */
export function tableRowAt(settings: Record<string, unknown>, rowId: string): { option: RoleModelOption; effort: string | null } | null {
  const raw = settings[roleModelKey(rowId)];
  if (!isRecord(raw)) return null;
  const option = roleModelOption(text(raw.model) ?? "");
  if (!option) return null;
  const effort = text(raw.reasoning_effort);
  return { option, effort: effort && (ROLE_MODEL_EFFORTS as readonly string[]).includes(effort) && (!option.efforts || option.efforts.includes(effort)) ? effort : null };
}

/** Why a stored `role_model.<role>` value is not valid, or null (empty is valid: no row). */
export function roleModelProblem(key: string, value: unknown): string | null {
  const row = key.slice(ROLE_MODEL_KEY_PREFIX.length);
  if (!ROLE_IDS.includes(row)) return `role: one of ${ROLE_IDS.join(", ")}`;
  if (value === undefined || value === null || value === "") return null;
  if (!isRecord(value)) return "{model, reasoning_effort?}";
  const effort = value.reasoning_effort;
  const option = roleModelOption(text(value.model) ?? "");
  if (!option) return `model: one of ${ROLE_MODEL_OPTIONS.map((row) => row.id).join(", ")}`;
  if (typeof effort === "string" && option.efforts && !option.efforts.includes(effort)) return `reasoning_effort for ${option.id}: one of ${option.efforts.join(", ")}`;
  if (effort !== undefined && !(typeof effort === "string" && (ROLE_MODEL_EFFORTS as readonly string[]).includes(effort))) return `reasoning_effort: one of ${ROLE_MODEL_EFFORTS.join(", ")}`;
  if (!Object.keys(value).every((name) => name === "model" || name === "reasoning_effort")) return "{model, reasoning_effort?}";
  return null;
}

/** The built-in default of a row as a resolved model. */
export function roleDefaultModel(rowId: string): RoleModel {
  const row = ROLE_TABLE.find((item) => item.id === rowId) ?? ROLE_TABLE[0]!;
  const option = roleModelOption(row.default.model)!;
  return { providerId: option.providerId, model: option.id, effort: row.default.effort, source: "default", sourceKey: null };
}

/**
 * Whether the machine the helpers run on offers a table model. `offeredOnHost` answers unknown (null) for a model the catalog does not list
 * at all, which is right for Claude and GPT (every machine has their native providers) but wrong for a Gemini through 9router: a machine that
 * is not set up for it simply does not list it. For such an option a connected machine whose catalog lacks the model does not offer it (false),
 * so the review takes its fallback instead of failing inside the spawn. A cold catalog, an unknown or disconnected machine stay unknown.
 */
export function offeredForRole(catalog: ModelCatalog, providerId: string, model: string, hostId: string | null | undefined): boolean | null {
  const listed = offeredOnHost(catalog, providerId, model, hostId);
  if (listed !== null || !hostId || !catalog.providers.length) return listed;
  const option = optionOfName(model);
  if (!option || option.providerId === "claude-code" || option.providerId === "codex") return null;
  return catalog.hosts.find((row) => row.id === hostId)?.connected ? false : null;
}

/** What a row runs on when its default (a Gemini) is not available: its `fallback`, null for a row that has none. */
export function roleFallbackModel(rowId: string): RoleModel | null {
  const row = ROLE_TABLE.find((item) => item.id === rowId);
  const option = row?.fallback ? roleModelOption(row.fallback.model) : undefined;
  return row?.fallback && option ? { providerId: option.providerId, model: option.id, effort: row.fallback.effort, source: "default", sourceKey: null } : null;
}

/**
 * The provider a model runs on, so a provider and a model are never sent as a pair that cannot exist (a GPT model on claude-code).
 * A provider the caller named stands, except that the two native providers cannot serve the other family's model of the table
 * (`claude-code` + `gpt-6.1-sol` is `codex`). With no provider: the model's own row of the table, else what the catalog says
 * (`catalogProvider`, only when it names one), else the family of the name, else null (the caller's default).
 */
export function consistentProvider(providerId: string | null | undefined, model: string, catalogProvider?: (model: string) => string | null | undefined): string | null {
  const option = optionOfName(model);
  const given = providerId?.trim() || null;
  if (given && !(option && option.providerId !== given && (given === "claude-code" || given === "codex"))) return given;
  if (option) return option.providerId;
  const listed = catalogProvider?.(model);
  if (listed) return listed;
  const family = modelFamily(model);
  return family === "claude" ? "claude-code" : family === "gpt" ? "codex" : null;
}

/**
 * The effort of the owner's pick that names none: the row's default when the pick is the row's default model; else the model's own default
 * (a Gemini: medium), else, for a row whose default is a Gemini, the effort of the model it falls back to (high); else the row's.
 */
function pickedEffort(row: RoleRow, option: RoleModelOption): string {
  if (option.id === row.default.model) return row.default.effort;
  return option.defaultEffort ?? row.fallback?.effort ?? row.default.effort;
}

/**
 * The model of a role from the settings alone (no machine consulted): table row, else legacy stage selection, else the default.
 * A legacy selection below the role's least tier is passed over for the default, as the inherited model of a deciding role always was.
 */
export function resolveRoleModel(role: string, settings: Record<string, unknown>): RoleModel {
  const row = roleRow(role);
  const own = tableRowAt(settings, row.id);
  if (own) return { providerId: own.option.providerId, model: own.option.id, effort: own.effort ?? pickedEffort(row, own.option), source: "table", sourceKey: roleModelKey(row.id) };
  let escalated = false;
  for (const stage of row.legacy ?? []) {
    const providerId = text(settings[`${stage}.provider`]), model = text(settings[`${stage}.model`]);
    if (!providerId || !model) continue;
    if (row.least && belowTier(modelTier(model), row.least)) { escalated = true; continue; }
    return { providerId, model, effort: text(settings[`${stage}.reasoning_effort`]) ?? STAGE_EFFORT[stage] ?? row.default.effort, source: "stage", sourceKey: `${stage}.model` };
  }
  return escalated ? { ...roleDefaultModel(row.id), escalated } : roleDefaultModel(row.id);
}

/** The same strength in the other family: Opus <-> Sol, Sonnet <-> Terra, Haiku <-> Luna. */
const PEER: Record<string, string> = {
  "claude-fable-5-1": "gpt-6-astra", "claude-opus-5-5": "gpt-6.1-sol", "claude-sonnet-5-5": "gpt-6.1-terra", "claude-haiku-5-5": "gpt-6-luna",
  "gpt-6-astra": "claude-fable-5-1", "gpt-6.1-sol": "claude-opus-5-5", "gpt-6.1-terra": "claude-sonnet-5-5", "gpt-6-luna": "claude-haiku-5-5",
};
/**
 * The peers of a Gemini or a GLM (the third family), strongest first: GPT-6.1 Sol, then Claude Opus. A Gemini has no equal in the other two, so it is
 * not paired by strength: its judge-peer is the strongest model of another family that is on offer.
 */
const GOOGLE_PEERS: readonly string[] = ["gpt-6.1-sol", "claude-opus-5-5"];

/**
 * The models a pick can hand over to when a rule needs another family, best first. With two families the answer is the one peer of the table
 * (Claude <-> GPT, same strength). With three: a Claude or GPT model keeps its peer in the other of the two (the pairs of the table do not
 * change); a Gemini takes the strongest available model that is not of its author's family: with `authorFamily` given, the peers of that
 * family come last (and are still returned: when nothing else is offered the caller keeps the judge going and says it is not independent).
 */
export function crossFamilyPeers(model: string, authorFamily?: ModelFamily | null): Array<{ providerId: string; model: string }> {
  const own = optionOfName(model);
  const ids = ["google", "glm"].includes(modelFamily(model) ?? "") ? GOOGLE_PEERS : (own && PEER[own.id] ? [PEER[own.id]!] : []);
  const peers = ids.flatMap((id) => { const option = roleModelOption(id); return option ? [{ providerId: option.providerId, model: option.id }] : []; });
  return authorFamily ? [...peers.filter((peer) => modelFamily(peer.model) !== authorFamily), ...peers.filter((peer) => modelFamily(peer.model) === authorFamily)] : peers;
}
/** The first peer of the table (Opus <-> Sol, Gemini -> Sol), or null. */
export const crossFamilyPeer = (model: string): { providerId: string; model: string } | null => crossFamilyPeers(model)[0] ?? null;

/**
 * The cross-family rule for a judge of someone's work: when the author's model is of the judge's own family, the judge takes its peer in
 * another family (`usable` says which are on offer: the first usable peer, else the first one, so the caller can see it is not offered).
 * Unknown families (a Composer writer, no writer yet) leave the judge as the table has it. Returns the pair and whether it changed.
 */
export function judgeAgainstAuthor(judge: { providerId: string; model: string }, author: { providerId: string; model: string } | null, usable?: (providerId: string, model: string) => boolean): { providerId: string; model: string; changed: boolean } {
  const kept = { providerId: judge.providerId, model: judge.model, changed: false };
  if (!author) return kept;
  const family = modelFamily(judge.model);
  if (!family || family !== modelFamily(author.model)) return kept;
  const peers = crossFamilyPeers(judge.model);
  const peer = (usable ? peers.find((row) => usable(row.providerId, row.model)) : undefined) ?? peers[0];
  return peer ? { ...peer, changed: true } : kept;
}

/** A provider window that is nearly spent: how full it is and which window (`weekly`, `5-hour`). */
export type SpentWindow = { percent: number; window: string };
/** Whether the provider a pair runs on has a window at or above the owner's threshold; null/undefined when it has room or nothing is known. */
export type SpentProbe = (providerId: string, model: string) => SpentWindow | null | undefined;
/** The issue a helper's result carries when its provider's limit moved it to the other family. */
export const USAGE_MOVED_ISSUE = "usage_moved";
/** The issue a judge carries when that move put it into the family of the work it judges (allowed: the limit is the stronger reason). */
export const SAME_FAMILY_JUDGE_BY_LIMIT = "same_family_judge_by_limit";

/**
 * A pair whose provider is nearly spent takes its peer in another family (Opus <-> Sol, Sonnet <-> Terra, Haiku <-> Luna, Fable <-> Astra,
 * a Gemini -> Sol, else Opus), when the machine offers the peer (`usable`) and the peer's own provider is not spent as well. `authorFamily`
 * (a judge's author) puts the peers of other families first; `preferred` (a row's fallback) goes ahead of them for a Gemini. Null when it stays: no limit hit, no peer, the peer not on offer or also spent
 * (then the original is kept, the limit is only an ordering).
 */
export function peerOffSpent(pick: { providerId: string; model: string }, spent: SpentProbe | undefined, usable?: (providerId: string, model: string) => boolean, authorFamily?: ModelFamily | null, preferred?: { providerId: string; model: string } | null): { providerId: string; model: string; issue: string } | null {
  const hit = spent?.(pick.providerId, pick.model);
  if (!hit) return null;
  // A Gemini of a row that names its fallback (the triager: Luna) goes there first, before the general peers.
  const first = preferred && modelFamily(pick.model) === "google" && modelFamily(preferred.model) !== authorFamily ? [preferred] : [];
  const peer = [...first, ...crossFamilyPeers(pick.model, authorFamily)].find((row) => (!usable || usable(row.providerId, row.model)) && !spent?.(row.providerId, row.model));
  if (!peer) return null;
  return { ...peer, issue: `${USAGE_MOVED_ISSUE}: ${pick.providerId} ${hit.window} ${Math.round(hit.percent)}% → ${peer.providerId}/${peer.model}` };
}
