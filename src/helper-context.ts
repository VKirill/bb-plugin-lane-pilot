export const HELPER_CONTEXT_MODES = ["inherit", "selected", "none"] as const;
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
  "acp-cursor": ["bbPlugins", "mcpServers"],
} as const;
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
  hostDaemonProtocolVersion: 216;
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
    hostDaemonProtocolVersion: 216,
    providerGroups: CORE_PROVIDER_GROUPS,
    instructionSwitches: CORE_INSTRUCTION_SWITCHES,
    mandatoryBbPlugins: [...MANDATORY_BB_PLUGINS],
    mandatoryMcpServers: [...MANDATORY_MCP_SERVERS],
  };
}
export const HELPER_SPAWN_ROLES = [
  "pm-reader", "plan-critic", "specialist-reviewer", "docs-maintainer",
  "onboarder", "memory-maintainer", "night-reviewer", "night-fixer", "gate-triage",
] as const;
export type HelperSpawnRole = (typeof HELPER_SPAWN_ROLES)[number];

export type HelperContextSettings = {
  mode: HelperContextMode;
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
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, settings: { mode: "inherit", skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] } };
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
    || row.hostDaemonProtocolVersion !== REQUIRED_SESSION_HOST_DAEMON_PROTOCOL
    || !advertisedMatrixMatch(row.providerGroups, CORE_PROVIDER_GROUPS)
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
}): { experimental_vkRequiredSessionPolicy: RequiredSessionPolicySpawn } | Record<string, never> {
  if (input.snapshot.mode === "inherit") return {};
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
): RequiredSessionPolicySpawn["policy"] {
  const requested = spawnPolicyBody(policy);
  for (const key of ["bbPlugins", "skills", "mcpServers", "nativePlugins"] as const) {
    const filter = requested[key];
    if (!filter) continue;
    if (groups.includes(key)) continue;
    if (filter.names.length) throw new Error(`helper_context_unsupported_provider_group:${key}`);
    delete requested[key];
  }
  for (const key of ["userInstructions", "projectInstructions", "claudeAiSync"] as const) {
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
  if (settings.mode === "inherit") return null;
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
