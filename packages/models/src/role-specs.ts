/**
 * ONE table of the roles that have a provider/model selection (the owner's decision of 2026-10-27: the model belongs to the role, not to
 * the step). A row is a role whose provider, model, reasoning effort and service tier are saved together by one RPC
 * (`save_<role>_selection`) into the settings `<prefix>.*`; the council seats and the writer's fallback slots are the same idea with a
 * seat or a slot in the key. Everything that names these roles — the RPC handlers, the `NATIVE_*_KEYS` sets, the screen's picker rows and
 * the contracts — is derived from this table, so adding a role is one entry here.
 *
 * The table says nothing about what a helper loads (that is `ROLE_PROFILES` in the native-agent room) and nothing about the built-in
 * model of a role (that is `ROLE_TABLE` in role-models.ts). It only says which settings a selection owns and how it is saved.
 */

/** The seats of a council, in the order the council table shows them. */
export const COUNCIL_SEATS = ["product", "demand", "audience", "skeptic", "growth", "ux", "chair"] as const;
export type CouncilSeat = (typeof COUNCIL_SEATS)[number];

/** The writer's fallback slots, in the order the writer row shows them. */
export const WRITER_FALLBACK_SLOTS = [1, 2, 3] as const;
export type WriterFallbackSlot = (typeof WRITER_FALLBACK_SLOTS)[number];

const PAIR_KEYS = <const P extends string>(prefix: P) =>
  [`${prefix}.provider`, `${prefix}.model`, `${prefix}.reasoning_effort`, `${prefix}.service_tier`] as const;
const SEAT_KEYS = <const S extends string>(seat: S) =>
  [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`] as const;
const SLOT_KEYS = <const N extends number>(slot: N) =>
  [`writer.fallback${slot}.provider`, `writer.fallback${slot}.model`, `writer.fallback${slot}.reasoning_effort`] as const;

export const COUNCIL_KEYS = COUNCIL_SEATS.flatMap((seat) => [...SEAT_KEYS(seat)]);
export const WRITER_FALLBACK_KEYS = WRITER_FALLBACK_SLOTS.flatMap((slot) => [...SLOT_KEYS(slot)]);

/** How the catalog a selection is judged against is found. */
export type RoleSelectionHost =
  /** The project's own writer host (`selectionCatalogHost(projectId)`). */
  | "project"
  /** The writer binding the project resolves to (`resolveProjectWriterHost`). */
  | "writer-binding"
  /** The host of the thread the writer pick is made for (`selectionCatalogHost(projectId, threadId, selectedBinding)`). */
  | "thread";

/** Whether the reasoning effort may fall back to the model's catalog default (the writer) or must be one the model supports. */
export type RoleSelectionEffort = "compatible" | "exact";

/** How the service tier is chosen: the writer takes the provider's nearest tier, a role takes the owner's or the provider default. */
export type RoleSelectionTier = "compatible" | "default";

/**
 * A role with a provider/model selection. `kind` says which shape the settings take:
 *  - `pair`: the four keys `<prefix>.provider`, `.model`, `.reasoning_effort`, `.service_tier`;
 *  - `council`: `<seat>` × provider, model, effort (no tier);
 *  - `fallback`: `<slot>` × provider, model, effort (no tier).
 */
export type RoleSpec = {
  kind: "pair" | "council" | "fallback";
  /** The role's id: the settings prefix and the RPC's name part. */
  id: string;
  /** The RPC that saves the selection. */
  rpc: `save_${string}_selection`;
  /** The settings keys the selection owns, in the order the handler saves them. */
  keys: readonly string[];
  /** The access role whose row of the team table carries this selection, when it has one. */
  accessRole?: string;
  /** The row of the table «role -> model» the selection feeds, when it has one. */
  tableRole?: string;
  /** The screen's picker id (the `SelectionId` of the team row). */
  selectionId?: string;
  /** The settings prefix of a `pair` role. */
  prefix?: string;
  /** The word in the message `save_setting` answers when the keys are written directly. */
  atomicLabel?: string;
  /** The effort the screen shows when the role has none of its own. */
  defaultEffort?: string;
  /** Whether the role falls back to the writer's effort when it has none of its own. */
  effortFromWriter?: boolean;
  /** How the catalog host is found. */
  host?: RoleSelectionHost;
  /** Whether the effort may fall back to the catalog default. */
  effort?: RoleSelectionEffort;
  /** How the service tier is chosen. */
  tier?: RoleSelectionTier;
  /** Whether a refusal is logged (the writer: the page shows it once, the log holds the reason). */
  log?: boolean;
  /** Whether the catalog host's validation is rebuilt as `[key, message]` (the writer). */
  remapValidation?: boolean;
  /** The seats of a `council` role. */
  seats?: readonly string[];
  /** The slots of a `fallback` role. */
  slots?: readonly number[];
};

/**
 * The table. Keep the rows in the order the roles appear in the settings screen: the writer first, then the roles of the work itself,
 * then the council and the writer's fallbacks.
 */
const ROLE_SPEC_ROWS = [
  {
    kind: "pair", id: "writer", prefix: "writer", rpc: "save_writer_selection", accessRole: "writer",
    host: "thread", effort: "compatible", tier: "compatible", log: true, remapValidation: true,
    keys: PAIR_KEYS("writer"),
  },
  {
    kind: "pair", id: "memory", prefix: "memory", rpc: "save_memory_selection", accessRole: "memory-maintainer", tableRole: "memory", selectionId: "memory",
    atomicLabel: "memory", host: "writer-binding", defaultEffort: "none", effortFromWriter: true,
    keys: PAIR_KEYS("memory"),
  },
  {
    kind: "pair", id: "night_review", prefix: "night_review", rpc: "save_night_review_selection", tableRole: "auditor", selectionId: "night",
    atomicLabel: "night-review", host: "project", defaultEffort: "high",
    keys: PAIR_KEYS("night_review"),
  },
  {
    kind: "pair", id: "docs", prefix: "docs", rpc: "save_docs_selection", accessRole: "docs-maintainer", tableRole: "docs-maintainer", selectionId: "docs",
    atomicLabel: "docs", host: "project", defaultEffort: "high",
    keys: PAIR_KEYS("docs"),
  },
  {
    kind: "pair", id: "project_life", prefix: "project_life", rpc: "save_project_life_selection", accessRole: "project-life", tableRole: "project-life", selectionId: "projectLife",
    atomicLabel: "project-life", host: "project", defaultEffort: "high",
    keys: PAIR_KEYS("project_life"),
  },
  {
    kind: "pair", id: "onboarding", prefix: "onboarding", rpc: "save_onboarding_selection", accessRole: "onboarder", selectionId: "onboarding",
    atomicLabel: "onboarding", host: "project", defaultEffort: "medium",
    keys: PAIR_KEYS("onboarding"),
  },
  {
    kind: "pair", id: "pm_read", prefix: "pm_read", rpc: "save_pm_read_selection", accessRole: "pm-reader", tableRole: "pm-reader", selectionId: "pmRead",
    atomicLabel: "PM-read", host: "project", defaultEffort: "low",
    keys: PAIR_KEYS("pm_read"),
  },
  {
    kind: "pair", id: "plan_critique", prefix: "plan_critique", rpc: "save_plan_critique_selection", accessRole: "plan-critic", tableRole: "plan-critic", selectionId: "planCritique",
    atomicLabel: "plan-critique", host: "project", defaultEffort: "medium", effortFromWriter: true,
    keys: PAIR_KEYS("plan_critique"),
  },
  {
    kind: "pair", id: "code_critique", prefix: "code_critique", rpc: "save_code_critique_selection", accessRole: "code-critic", tableRole: "code-critic", selectionId: "codeCritique",
    atomicLabel: "code-critique", host: "project", defaultEffort: "medium", effortFromWriter: true,
    keys: PAIR_KEYS("code_critique"),
  },
  {
    kind: "pair", id: "specialist", prefix: "specialist", rpc: "save_specialist_selection", accessRole: "specialist-reviewer", tableRole: "specialist", selectionId: "specialist",
    atomicLabel: "specialist", host: "project", defaultEffort: "high",
    keys: PAIR_KEYS("specialist"),
  },
  {
    kind: "council", id: "council", rpc: "save_council_seat_selection", accessRole: "council-seat",
    keys: COUNCIL_KEYS, seats: COUNCIL_SEATS,
  },
  {
    kind: "fallback", id: "writer_fallback", rpc: "save_writer_fallback_selection", accessRole: "writer",
    keys: WRITER_FALLBACK_KEYS, slots: WRITER_FALLBACK_SLOTS,
  },
] as const satisfies readonly RoleSpec[];

/** The table. Its literal rows are the source of the RPC names and the picker ids below. */
export const ROLE_SPECS: readonly RoleSpec[] = ROLE_SPEC_ROWS;

/** The `pair` rows: the roles whose four keys are one provider/model/effort/tier group. */
export const PAIR_ROLE_SPECS: readonly RoleSpec[] = ROLE_SPECS.filter((spec) => spec.kind === "pair");

/** The RPC names of the table, in table order. */
export type RoleSelectionRpc = (typeof ROLE_SPEC_ROWS)[number]["rpc"];
/** The RPC names of the `pair` rows (the council seats and the writer fallbacks have their own contracts). */
export type PairRoleSelectionRpc = Exclude<RoleSelectionRpc, "save_council_seat_selection" | "save_writer_fallback_selection">;

type SelectionIdOf<S> = S extends { selectionId: infer Id extends string } ? Id : never;
/** The screen picker ids the table names (the team row's `SelectionId`). */
export type RoleSelectionId = SelectionIdOf<(typeof ROLE_SPEC_ROWS)[number]>;

/** The row of a role id, when the table has it. */
export function roleSpec(id: string): RoleSpec | undefined {
  return ROLE_SPECS.find((spec) => spec.id === id);
}

/** The settings key of one suffix of a `pair` role (`provider`, `model`, `reasoning_effort`, `service_tier`). */
export function roleSpecKey(id: string, suffix: "provider" | "model" | "reasoning_effort" | "service_tier"): string {
  const spec = roleSpec(id);
  if (!spec || spec.kind !== "pair" || !spec.prefix) throw new Error(`role "${id}" has no ${suffix} key`);
  return `${spec.prefix}.${suffix}`;
}

/** Every setting key a selection owns, in table order. */
export const ROLE_SELECTION_KEYS: readonly string[] = ROLE_SPECS.flatMap((spec) => [...spec.keys]);

/** The message `save_setting` answers when a role's keys are written directly. */
export function roleAtomicMessage(id: string): string | null {
  const spec = roleSpec(id);
  return spec?.atomicLabel ? `use atomic ${spec.atomicLabel} provider/model selection` : null;
}
