export const HELPER_CONTEXT_MODES = ["roles", "inherit", "selected", "none"] as const;
export type HelperContextMode = (typeof HELPER_CONTEXT_MODES)[number];
export type VkCapability = "none" | "dynamic" | "required";

export type VkNameFilter = { mode: "allow" | "deny"; names: string[] };

export type VkSessionPolicy = {
  bbPlugins?: VkNameFilter;
  skills?: VkNameFilter;
  mcpServers?: VkNameFilter;
  nativePlugins?: VkNameFilter;
  userInstructions?: boolean;
  projectInstructions?: boolean;
  claudeAiSync?: boolean;
  required?: boolean;
};

export const REQUIRED_SESSION_HANDSHAKE_VERSION = 1;
export const REQUIRED_SESSION_HOST_DAEMON_PROTOCOL = 216;
export const MANDATORY_BB_PLUGINS = ["environment-project-checkout", "project-folders"] as const;
export const MANDATORY_MCP_SERVERS = ["bb-bridge"] as const;
export const REQUIRED_SESSION_COMPONENTS = [...MANDATORY_BB_PLUGINS, ...MANDATORY_MCP_SERVERS] as const;
export const CORE_PROVIDER_GROUPS = {
  "claude-code": ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
  codex: ["bbPlugins", "skills", "mcpServers", "nativePlugins"],
  "acp-opencode": ["bbPlugins", "skills", "mcpServers"],
  "acp-cursor": ["bbPlugins", "skills", "mcpServers"],
} as const;
/** Cores before 0.44.0-vk.15 could not narrow BB skills for Cursor. */
const LEGACY_CURSOR_GROUPS = ["bbPlugins", "mcpServers"] as const;
export const CORE_INSTRUCTION_SWITCHES = {
  "claude-code": ["userInstructions", "projectInstructions", "claudeAiSync"],
  codex: ["userInstructions", "projectInstructions"],
  "acp-opencode": ["userInstructions", "projectInstructions"],
  "acp-cursor": ["userInstructions"],
} as const;
export type RequiredSessionAdvertisement = {
  version: 1;
  persist: true;
  requiredMarker: true;
  snapshotDigest: true;
  parentCeiling: true;
  bridgeHandshakeVersion: 1;
  /** The archived protocol-216 core; the VK core advertises markerStorage instead. */
  hostDaemonProtocolVersion?: 216;
  /** Since 2026-10-02 the VK core keeps the required markers in thread plugin metadata, with no protocol bump. */
  markerStorage?: "thread-plugin-metadata";
  providerGroups: { [K in keyof typeof CORE_PROVIDER_GROUPS]: readonly string[] };
  instructionSwitches: { [K in keyof typeof CORE_INSTRUCTION_SWITCHES]: readonly string[] };
  mandatoryBbPlugins: readonly string[];
  mandatoryMcpServers: readonly string[];
};

export function coreRequiredSessionAdvertisement(): RequiredSessionAdvertisement {
  return {
    version: 1,
    persist: true,
    requiredMarker: true,
    snapshotDigest: true,
    parentCeiling: true,
    bridgeHandshakeVersion: 1,
    markerStorage: "thread-plugin-metadata",
    providerGroups: CORE_PROVIDER_GROUPS,
    instructionSwitches: CORE_INSTRUCTION_SWITCHES,
    mandatoryBbPlugins: [...MANDATORY_BB_PLUGINS],
    mandatoryMcpServers: [...MANDATORY_MCP_SERVERS],
  };
}
/**
 * What each kind of helper loads when the project uses the default «by role» context: only what the job
 * needs, so a writer or a docs maintainer does not carry 40-odd BB plugins and 500 skill descriptions in its
 * prompt. The mandatory core resources (project checkout, Project Folders, bb-bridge) are always added.
 */
export type HelperRole =
  | "writer" | "code-repair" | "night-fixer"
  | "plan-critic" | "code-critic" | "specialist-reviewer" | "night-reviewer" | "gate-triage" | "pm-reader"
  | "docs-maintainer" | "onboarder" | "memory-maintainer" | "project-life"
  | "browser-qa" | "errand" | "council-seat" | "rules-analyzer"
  | "specialist:design-lead" | "specialist:copy-lead" | "specialist:seo-specialist" | "specialist:tavily";

type RoleProfile = { bbPlugins: string[]; skills: string[]; mcpServers: string[] };
const CODER: RoleProfile = { bbPlugins: [], skills: ["writer-practices", "karpathy-guidelines"], mcpServers: ["gitnexus", "metamcp"] };
const READER: RoleProfile = { bbPlugins: [], skills: [], mcpServers: ["gitnexus"] };
// Env Catalog (J1): the roles that need an account or key get its tools. A writer does not: its checks get the secrets the
// contract declares (verification[].secrets) from the server, by name. A browser check gets it only for a case that names
// a login (qa-thread.ts, extraAccess).
export const ROLE_PROFILES: Record<HelperRole, RoleProfile> = {
  "writer": CODER,
  "code-repair": CODER,
  "night-fixer": CODER,
  "plan-critic": READER,
  "code-critic": READER,
  "specialist-reviewer": READER,
  "night-reviewer": READER,
  "gate-triage": READER,
  "pm-reader": READER,
  "docs-maintainer": { bbPlugins: [], skills: ["docs-maintain", "docs-methodology"], mcpServers: ["gitnexus"] },
  "onboarder": { bbPlugins: [], skills: ["project-life"], mcpServers: ["gitnexus"] },
  // It returns one JSON array and runs no tools; the memory skills told it to call CLIs (instructions audit 2026-10-03).
  "memory-maintainer": { bbPlugins: [], skills: [], mcpServers: [] },
  "project-life": { bbPlugins: [], skills: ["project-life"], mcpServers: ["gitnexus"] },
  "browser-qa": { bbPlugins: ["browser-automation"], skills: ["browser-automation"], mcpServers: [] },
  // A PM's errand outside the code: a console, a mailbox, a recording. The browser on the browser machine, the fast
  // jev-ultrafast loop (computer-use) and Env Catalog for the accounts it needs; no code skills.
  "errand": { bbPlugins: ["browser-automation", "env-catalog"], skills: ["browser-automation", "computer-use", "env-catalog"], mcpServers: [] },
  "council-seat": { bbPlugins: [], skills: [], mcpServers: [] },
  "rules-analyzer": { bbPlugins: [], skills: [], mcpServers: [] },
  "specialist:design-lead": { bbPlugins: ["env-catalog"], skills: ["env-catalog", "ui-ux-pro-max", "project-design", "project-onboard", "web-design", "design-taste", "impeccable-ui", "page-prototype"], mcpServers: ["metamcp"] },
  "specialist:copy-lead": { bbPlugins: ["env-catalog"], skills: ["env-catalog", "copy-project-life", "site-copy-audience", "site-copy-headlines", "site-copy-ux", "copy-research", "tavily", "page-prototype", "ru-text", "ru-check", "ru-score"], mcpServers: [] },
  "specialist:seo-specialist": { bbPlugins: ["env-catalog"], skills: ["env-catalog", "seo-project-life", "seo-drmax-orchestrator", "cocoon-chainsmith", "drmax-cocoon-engine-x4", "drmax-brandcore", "drmax-text-humanization", "ai-detect", "drmax-signalforge", "drmax-latent-intent", "drmax-market-scoped", "google", "yandex", "seo-tools", "page-prototype", "ru-text", "ru-check", "ru-score"], mcpServers: [] },
  "specialist:tavily": { bbPlugins: ["env-catalog"], skills: ["env-catalog", "tavily"], mcpServers: [] },
};

export const HELPER_ROLES = Object.keys(ROLE_PROFILES) as HelperRole[];
export const ACCESS_GROUPS = ["bbPlugins", "skills", "mcpServers", "nativePlugins"] as const;
export type AccessGroup = (typeof ACCESS_GROUPS)[number];
export const ACCESS_SWITCHES = ["userInstructions", "projectInstructions"] as const;
export type AccessSwitch = (typeof ACCESS_SWITCHES)[number];

/**
 * An owner's change to one role, stored per role as `helper.access.<role>` (project or section scope).
 * A group set to "role" (or absent) keeps the role profile; "all" stops narrowing it; "allow" is an exact
 * list (the mandatory core resources are always added).
 */
export type RoleAccessGroup = { mode: "role" | "all" | "allow"; names?: string[] };
export type RoleAccess = Partial<Record<AccessGroup, RoleAccessGroup>> & Partial<Record<AccessSwitch, "role" | "include" | "leave_out">>;
export const roleAccessKey = (role: HelperRole) => `helper.access.${role}`;

export function parseRoleAccess(raw: unknown): RoleAccess {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const out: RoleAccess = {};
  for (const group of ACCESS_GROUPS) {
    const g = row[group];
    if (!g || typeof g !== "object") continue;
    const mode = (g as { mode?: unknown }).mode;
    if (mode !== "role" && mode !== "all" && mode !== "allow") continue;
    const names = (g as { names?: unknown }).names;
    out[group] = mode === "allow"
      ? { mode, names: Array.isArray(names) ? [...new Set(names.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim()))].slice(0, 300) : [] }
      : { mode };
  }
  for (const sw of ACCESS_SWITCHES) {
    const v = row[sw];
    if (v === "role" || v === "include" || v === "leave_out") out[sw] = v;
  }
  return out;
}

export function roleAccessFromSettings(input: Record<string, unknown>): Partial<Record<HelperRole, RoleAccess>> {
  const out: Partial<Record<HelperRole, RoleAccess>> = {};
  for (const role of HELPER_ROLES) {
    const access = parseRoleAccess(input[roleAccessKey(role)]);
    if (Object.keys(access).length) out[role] = access;
  }
  return out;
}

/** What one group of a role effectively loads: a list (mandatory included) or null for «everything BB has». */
export function effectiveGroup(role: HelperRole, group: AccessGroup, access: RoleAccess = {}): { names: string[] | null; source: "role" | "owner" } {
  const own = access[group];
  const mandatory = group === "bbPlugins" ? MANDATORY_BB_PLUGINS : group === "mcpServers" ? MANDATORY_MCP_SERVERS : [];
  if (own?.mode === "all") return { names: null, source: "owner" };
  if (own?.mode === "allow") return { names: withMandatory(own.names ?? [], mandatory), source: "owner" };
  const profile = ROLE_PROFILES[role];
  const base = group === "nativePlugins" ? [] : profile[group];
  return { names: withMandatory(base, mandatory), source: "role" };
}

export function effectiveSwitch(sw: AccessSwitch, access: RoleAccess = {}): { include: boolean; source: "role" | "owner" } {
  const own = access[sw];
  if (own === "include") return { include: true, source: "owner" };
  if (own === "leave_out") return { include: false, source: "owner" };
  // Role default: the user's personal instructions are left out, the project's stay.
  return { include: sw === "projectInstructions", source: "role" };
}

export function roleProfilePolicy(role: HelperRole, access: RoleAccess = {}): VkSessionPolicy {
  const policy: VkSessionPolicy = { claudeAiSync: false, required: true };
  for (const group of ACCESS_GROUPS) {
    const { names } = effectiveGroup(role, group, access);
    if (names) policy[group] = { mode: "allow", names };
  }
  if (!effectiveSwitch("userInstructions", access).include) policy.userInstructions = false;
  if (!effectiveSwitch("projectInstructions", access).include) policy.projectInstructions = false;
  return policy;
}

export const HELPER_SPAWN_ROLES = [
  "pm-reader", "plan-critic", "specialist-reviewer", "docs-maintainer",
  "onboarder", "memory-maintainer", "night-reviewer", "night-fixer", "gate-triage",
] as const;
export type HelperSpawnRole = (typeof HELPER_SPAWN_ROLES)[number];

export type HelperContextSettings = {
  mode: HelperContextMode;
  /** Owner changes per role, used by the «by role» mode; frozen into a run's snapshot with the rest. */
  roleAccess?: Partial<Record<HelperRole, RoleAccess>>;
  skills: string[];
  mcpServers: string[];
  bbPlugins: string[];
  nativePlugins: string[];
};

export type HelperPolicySnapshot = {
  schemaVersion: 1;
  mode: HelperContextMode;
  settings: HelperContextSettings;
  parentRequired: boolean;
  parentPolicy: VkSessionPolicy | null;
  policy: VkSessionPolicy | null;
};

export type HelperDispatchDecision =
  | { ok: true; enforcement: "inherit-parent"; required: boolean; residualFailOpen: false; policy: VkSessionPolicy | null; snapshot: HelperPolicySnapshot }
  | { ok: false; reason: string };

function csvNames(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

export function parseHelperContextSettings(input: Record<string, unknown>):
  { ok: true; settings: HelperContextSettings } | { ok: false; reason: "helper_context_mode_invalid" } {
  const raw = input["helper.context_mode"];
  // The default: every helper gets the profile of its role.
  if (raw === undefined || raw === null || raw === "" || raw === "roles") {
    return { ok: true, settings: { mode: "roles", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [], roleAccess: roleAccessFromSettings(input) } };
  }
  if (raw !== "selected" && raw !== "none" && raw !== "inherit") {
    return { ok: false, reason: "helper_context_mode_invalid" };
  }
  return {
    ok: true,
    settings: {
      mode: raw,
      skills: csvNames(input["helper.skills"]),
      mcpServers: csvNames(input["helper.mcp_servers"]),
      bbPlugins: csvNames(input["helper.bb_plugins"]),
      nativePlugins: csvNames(input["helper.native_plugins"]),
    },
  };
}

export type RequiredSessionPolicySpawn = {
  version: 1;
  policy: {
    bbPlugins?: VkNameFilter;
    skills?: VkNameFilter;
    mcpServers?: VkNameFilter;
    nativePlugins?: VkNameFilter;
    userInstructions?: boolean;
    projectInstructions?: boolean;
    claudeAiSync?: boolean;
  };
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameStringSet(actual: unknown, expected: readonly string[]): boolean {
  if (!isStringArray(actual) || actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((item, index) => item === right[index]);
}

function advertisedMatrixMatch(
  raw: unknown,
  expected: Record<string, readonly string[]>,
): raw is Record<string, string[]> {
  if (!raw || typeof raw !== "object") return false;
  const row = raw as Record<string, unknown>;
  const keys = Object.keys(expected);
  if (Object.keys(row).length !== keys.length) return false;
  return keys.every((key) => sameStringSet(row[key], expected[key]!));
}

export function parseRequiredSessionPolicyCapability(agents: {
  experimental_vkRequiredSessionPolicy?: unknown;
}): RequiredSessionAdvertisement | null {
  if (typeof agents.experimental_vkRequiredSessionPolicy !== "function") return null;
  const advertised = (agents.experimental_vkRequiredSessionPolicy as () => unknown)();
  if (!advertised || typeof advertised !== "object") return null;
  const row = advertised as Record<string, unknown>;
  if (row.version !== 1
    || row.persist !== true
    || row.requiredMarker !== true
    || row.snapshotDigest !== true
    || row.parentCeiling !== true
    || row.bridgeHandshakeVersion !== REQUIRED_SESSION_HANDSHAKE_VERSION
    || (row.hostDaemonProtocolVersion !== REQUIRED_SESSION_HOST_DAEMON_PROTOCOL && row.markerStorage !== "thread-plugin-metadata")
    || !(advertisedMatrixMatch(row.providerGroups, CORE_PROVIDER_GROUPS)
      || advertisedMatrixMatch(row.providerGroups, { ...CORE_PROVIDER_GROUPS, "acp-cursor": LEGACY_CURSOR_GROUPS }))
    || !advertisedMatrixMatch(row.instructionSwitches, CORE_INSTRUCTION_SWITCHES)
    || !isStringArray(row.mandatoryBbPlugins)
    || !MANDATORY_BB_PLUGINS.every((name) => (row.mandatoryBbPlugins as string[]).includes(name))
    || !isStringArray(row.mandatoryMcpServers)
    || !MANDATORY_MCP_SERVERS.every((name) => (row.mandatoryMcpServers as string[]).includes(name))) {
    return null;
  }
  return advertised as RequiredSessionAdvertisement;
}

export function detectRequiredSessionPolicyCapability(agents: {
  experimental_vkRequiredSessionPolicy?: unknown;
}): boolean {
  return parseRequiredSessionPolicyCapability(agents) != null;
}

export function detectVkCapability(agents: {
  experimental_vkSessionPolicy?: unknown;
  experimental_vkRequiredSessionPolicy?: unknown;
}): VkCapability {
  if (detectRequiredSessionPolicyCapability(agents)) return "required";
  if (typeof agents.experimental_vkSessionPolicy === "function") return "dynamic";
  return "none";
}

function spawnPolicyBody(policy: VkSessionPolicy): RequiredSessionPolicySpawn["policy"] {
  return {
    ...(policy.bbPlugins ? { bbPlugins: policy.bbPlugins } : {}),
    ...(policy.skills ? { skills: policy.skills } : {}),
    ...(policy.mcpServers ? { mcpServers: policy.mcpServers } : {}),
    ...(policy.nativePlugins ? { nativePlugins: policy.nativePlugins } : {}),
    ...(policy.userInstructions !== undefined ? { userInstructions: policy.userInstructions } : {}),
    ...(policy.projectInstructions !== undefined ? { projectInstructions: policy.projectInstructions } : {}),
    ...(policy.claudeAiSync !== undefined ? { claudeAiSync: policy.claudeAiSync } : {}),
  };
}

export function requiredSessionPolicySpawnBinding(input: {
  capability: VkCapability;
  snapshot: HelperPolicySnapshot;
  advertised?: RequiredSessionAdvertisement | null;
  providerId?: string;
  role?: HelperRole;
}): { experimental_vkRequiredSessionPolicy: RequiredSessionPolicySpawn } | Record<string, never> {
  if (input.snapshot.mode === "inherit") return {};
  if (input.snapshot.mode === "roles") {
    // By role is a default, not a demand: a core without required policies, an unknown role or provider
    // runs the helper with BB's ordinary context instead of refusing it.
    if (!input.role || input.capability !== "required" || !input.advertised || !input.providerId) return {};
    const groups = input.advertised.providerGroups[input.providerId as keyof typeof CORE_PROVIDER_GROUPS];
    const switches = input.advertised.instructionSwitches[input.providerId as keyof typeof CORE_INSTRUCTION_SWITCHES];
    if (!groups || !switches) return {};
    return { experimental_vkRequiredSessionPolicy: { version: 1, policy: spawnPolicyForProvider(roleProfilePolicy(input.role, input.snapshot.settings.roleAccess?.[input.role]), groups, switches, true) } };
  }
  if (input.capability !== "required" || !input.advertised) {
    throw new Error("helper_context_required_api_unavailable");
  }
  if (!input.providerId) throw new Error("helper_context_provider_required");
  const groups = input.advertised.providerGroups[input.providerId as keyof typeof CORE_PROVIDER_GROUPS];
  const switches = input.advertised.instructionSwitches[input.providerId as keyof typeof CORE_INSTRUCTION_SWITCHES];
  if (!groups || !switches) throw new Error(`helper_context_unsupported_provider:${input.providerId}`);
  const policy = spawnPolicyForProvider(input.snapshot.policy ?? {}, groups, switches);
  return {
    experimental_vkRequiredSessionPolicy: {
      version: 1,
      policy,
    },
  };
}

function spawnPolicyForProvider(
  policy: VkSessionPolicy,
  groups: readonly string[],
  switches: readonly string[],
  lenient = false,
): RequiredSessionPolicySpawn["policy"] {
  const requested = spawnPolicyBody(policy);
  for (const key of ["bbPlugins", "skills", "mcpServers", "nativePlugins"] as const) {
    const filter = requested[key];
    if (!filter) continue;
    if (groups.includes(key)) continue;
    // A role profile leaves out what the provider cannot narrow; an explicit owner choice refuses instead.
    if (filter.names.length && !lenient) throw new Error(`helper_context_unsupported_provider_group:${key}`);
    delete requested[key];
  }
  for (const key of ["userInstructions", "projectInstructions", "claudeAiSync"] as const) {
    if (requested[key] !== undefined && !switches.includes(key) && lenient) { delete requested[key]; continue; }
    if (requested[key] !== undefined && !switches.includes(key)) {
      throw new Error(`helper_context_unsupported_instruction_switch:${key}`);
    }
  }
  return requested;
}

function withMandatory(names: string[], mandatory: readonly string[]): string[] {
  return [...new Set([...mandatory, ...names])];
}

export function helperContextToPolicy(settings: HelperContextSettings): VkSessionPolicy | null {
  // Inherit has no project-wide list; by role is decided per helper at spawn (roleProfilePolicy).
  if (settings.mode === "inherit" || settings.mode === "roles") return null;
  const names = settings.mode === "none"
    ? { skills: [] as string[], mcpServers: [] as string[], bbPlugins: [] as string[], nativePlugins: [] as string[] }
    : settings;
  return {
    skills: { mode: "allow", names: names.skills },
    mcpServers: { mode: "allow", names: withMandatory(names.mcpServers, MANDATORY_MCP_SERVERS) },
    bbPlugins: { mode: "allow", names: withMandatory(names.bbPlugins, MANDATORY_BB_PLUGINS) },
    nativePlugins: { mode: "allow", names: names.nativePlugins },
    required: true,
  };
}

export function intersectPolicy(parent: VkSessionPolicy | null, child: VkSessionPolicy | null): VkSessionPolicy | null {
  if (parent == null) return child;
  if (child == null) return { ...parent, required: parent.required === true };
  return {
    skills: intersectFilter(parent.skills, child.skills),
    mcpServers: intersectFilter(parent.mcpServers, child.mcpServers),
    bbPlugins: intersectFilter(parent.bbPlugins, child.bbPlugins),
    nativePlugins: intersectFilter(parent.nativePlugins, child.nativePlugins),
    userInstructions: (parent.userInstructions ?? true) && (child.userInstructions ?? true),
    projectInstructions: (parent.projectInstructions ?? true) && (child.projectInstructions ?? true),
    claudeAiSync: (parent.claudeAiSync ?? true) && (child.claudeAiSync ?? true),
    required: parent.required === true || child.required === true,
  };
}

function intersectFilter(parent: VkNameFilter | undefined, child: VkNameFilter | undefined): VkNameFilter | undefined {
  if (!parent) return child;
  if (!child) return parent;
  if (parent.mode === "allow" && child.mode === "allow") {
    const allowed = new Set(parent.names);
    return { mode: "allow", names: child.names.filter((name) => allowed.has(name)) };
  }
  if (parent.mode === "allow") {
    const allowed = new Set(parent.names);
    return { mode: "allow", names: parent.names.filter((name) => child.mode === "deny" ? !child.names.includes(name) : allowed.has(name)) };
  }
  const denied = new Set([...parent.names, ...(child.mode === "deny" ? child.names : [])]);
  if (child.mode === "allow") return { mode: "allow", names: child.names.filter((name) => !denied.has(name)) };
  return { mode: "deny", names: [...denied] };
}

export function decideHelperDispatch(input: {
  settings: HelperContextSettings;
  capability: VkCapability;
  parentPolicy?: VkSessionPolicy | null;
  parentRequired?: boolean;
  snapshot?: HelperPolicySnapshot | null;
}): HelperDispatchDecision {
  const parentPolicy = input.snapshot?.parentPolicy ?? input.parentPolicy ?? null;
  const parentRequired = input.snapshot?.parentRequired ?? (input.parentRequired === true || parentPolicy?.required === true);
  const settings = input.snapshot?.settings ?? input.settings;
  const child = helperContextToPolicy(settings);
  const policy = settings.mode === "inherit" ? (parentPolicy ? { ...parentPolicy, required: parentRequired } : null) : intersectPolicy(parentPolicy, child);

  if (settings.mode === "roles") {
    return {
      ok: true,
      enforcement: "inherit-parent",
      required: input.capability === "required",
      residualFailOpen: false,
      policy: null,
      snapshot: input.snapshot ?? { schemaVersion: 1, mode: "roles", settings, parentRequired, parentPolicy, policy: null },
    };
  }

  if (settings.mode === "inherit") {
    if (parentRequired && input.capability !== "required") {
      return { ok: false, reason: "helper_context_parent_ceiling_unenforced" };
    }
    return {
      ok: true,
      enforcement: "inherit-parent",
      required: parentRequired,
      residualFailOpen: false,
      policy,
      snapshot: input.snapshot ?? { schemaVersion: 1, mode: "inherit", settings, parentRequired, parentPolicy, policy },
    };
  }

  if (input.capability !== "required") {
    return { ok: false, reason: "helper_context_required_api_unavailable" };
  }
  return {
    ok: true,
    enforcement: "inherit-parent",
    required: true,
    residualFailOpen: false,
    policy,
    snapshot: input.snapshot ?? { schemaVersion: 1, mode: settings.mode, settings, parentRequired, parentPolicy, policy },
  };
}

export function isHelperSpawnRole(role: unknown): role is HelperSpawnRole {
  return typeof role === "string" && (HELPER_SPAWN_ROLES as readonly string[]).includes(role);
}
