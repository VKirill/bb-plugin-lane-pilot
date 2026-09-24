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

export const REQUIRED_SESSION_COMPONENTS = ["environment-project-checkout", "bb-bridge"] as const;
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

export function detectVkCapability(agents: {
  experimental_vkSessionPolicy?: unknown;
  experimental_vkRequiredSessionPolicy?: unknown;
}): VkCapability {
  if (typeof agents.experimental_vkRequiredSessionPolicy === "function") return "required";
  if (typeof agents.experimental_vkSessionPolicy === "function") return "dynamic";
  return "none";
}

export function helperContextToPolicy(settings: HelperContextSettings): VkSessionPolicy | null {
  if (settings.mode === "inherit") return null;
  const names = settings.mode === "none"
    ? { skills: [] as string[], mcpServers: [] as string[], bbPlugins: [] as string[], nativePlugins: [] as string[] }
    : settings;
  return {
    skills: { mode: "allow", names: names.skills },
    mcpServers: { mode: "allow", names: names.mcpServers },
    bbPlugins: { mode: "allow", names: names.bbPlugins },
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
