import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  HELPER_ROLES,
  detectVkCapability,
  parseHelperContextSettings,
  parseRequiredSessionPolicyCapability,
  requiredSessionPolicySpawnBinding,
  type HelperPolicySnapshot,
  type HelperRole,
} from "../../contracts";
import { unwrapBbApi } from "./lp-service-tier";

const KNOWN_ROLES: ReadonlySet<string> = new Set(HELPER_ROLES);

/**
 * Internal subthread/helper role aliases mapped to their canonical clean session profile
 * without expanding the owner-facing HELPER_ROLES settings table.
 * Generic checkout-reading subthreads fall back to `analyst` (in CHAIN_CHECKOUT_READERS)
 * so project `AGENTS.md` (`projectInstructions`) stays enabled while extraneous global
 * skills, personal `userInstructions`, and plugins are stripped.
 */
const SUBTHREAD_ROLE_ALIASES: Readonly<Record<string, HelperRole>> = {
  "self-repair": "code-repair",
  repairer: "code-repair",
  "wall-repair": "code-repair",
  "emergency-writer": "writer",
  worker: "writer",
  engineer: "writer",
  "docs-nightly": "docs-maintainer",
  docs: "docs-maintainer",
  "project-life-maintainer": "project-life",
  memory: "memory-maintainer",
  council: "council-seat",
  "wall-analysis": "wall-hunter",
  triager: "gate-triage",
  critic: "code-critic",
  "bench-source": "workspace-provisioner",
  "sub-agent": "analyst",
};

const DEFAULT_ROLES_SNAPSHOT: HelperPolicySnapshot = {
  schemaVersion: 1,
  mode: "roles",
  settings: {
    mode: "roles",
    skills: [],
    mcpServers: [],
    bbPlugins: [],
    nativePlugins: [],
  },
  parentRequired: false,
  parentPolicy: null,
  policy: null,
};

type ProjectSettingsReader = (projectId: string) => Record<string, unknown>;
const projectSettingsByApi = new WeakMap<BbPluginApi, ProjectSettingsReader>();

export function bindSubthreadProjectSettings(bb: BbPluginApi, reader: ProjectSettingsReader): void {
  projectSettingsByApi.set(unwrapBbApi(bb), reader);
}

/**
 * Resolves the clean session profile role for any non-PM helper/subthread spawn.
 * Top-level or child PM orchestrators (`pm`, `bench-pm`) keep their orchestrator context.
 */
export function resolveCleanSubthreadRole(
  role: string | null | undefined,
  hasParent: boolean,
  specialistName?: string | null,
): HelperRole | null {
  if (role === "pm" || role === "bench-pm") return null;
  if (role === "specialist") {
    const cleanSpec = typeof specialistName === "string" ? specialistName.trim() : "";
    return cleanSpec ? (`specialist:${cleanSpec}` as HelperRole) : "specialist-reviewer";
  }
  if (typeof role === "string" && role.length > 0) {
    if (KNOWN_ROLES.has(role)) return role as HelperRole;
    if (role in SUBTHREAD_ROLE_ALIASES) return SUBTHREAD_ROLE_ALIASES[role]!;
    if (role.startsWith("specialist:")) return role as HelperRole;
    return "analyst";
  }
  return hasParent ? "analyst" : null;
}

/**
 * Guarantees that every subthread/helper spawned through `fullAccessSpawn` starts as a clean session
 * without extraneous global skills or plugins whenever the project uses the default `"roles"` mode
 * and the caller did not already supply an explicit session policy or `helperMode === "inherit"`.
 */
export function cleanSubthreadPolicyField(
  bb: BbPluginApi,
  args: {
    projectId?: string | null;
    parentThreadId?: string | null;
    providerId?: string;
    pluginMetadata?: Record<string, unknown>;
    experimental_vkRequiredSessionPolicy?: unknown;
  } & Record<string, unknown>,
): Record<string, unknown> {
  if (args.experimental_vkRequiredSessionPolicy !== undefined) return {};
  const meta = args.pluginMetadata;
  if (meta?.helperMode && meta.helperMode !== "roles") return {};
  const unwrapped = unwrapBbApi(bb);
  if (typeof args.projectId === "string" && args.projectId) {
    const reader = projectSettingsByApi.get(unwrapped);
    if (reader) {
      const parsed = parseHelperContextSettings(reader(args.projectId));
      if (!parsed.ok || parsed.settings.mode !== "roles") return {};
    }
  }
  const rawRole = typeof meta?.role === "string" ? meta.role : null;
  const specialistName = typeof meta?.specialist === "string" ? meta.specialist : null;
  const resolvedRole = resolveCleanSubthreadRole(rawRole, Boolean(args.parentThreadId), specialistName);
  if (!resolvedRole || !args.providerId) return {};
  const rawBb = unwrapped as {
    agents?: { experimental_vkSessionPolicy?: unknown; experimental_vkRequiredSessionPolicy?: unknown };
    log?: { warn?: (message: string) => void };
  };
  const agents = rawBb.agents ?? {};
  const capability = detectVkCapability(agents);
  if (capability !== "required") return {};
  const advertised = parseRequiredSessionPolicyCapability(agents);
  if (!advertised) return {};
  const reader = typeof args.projectId === "string" && args.projectId ? projectSettingsByApi.get(unwrapped) : undefined;
  const parsedProject = reader ? parseHelperContextSettings(reader(args.projectId!)) : null;
  const snapshot: HelperPolicySnapshot =
    parsedProject && parsedProject.ok && parsedProject.settings.mode === "roles"
      ? { ...DEFAULT_ROLES_SNAPSHOT, settings: parsedProject.settings }
      : DEFAULT_ROLES_SNAPSHOT;
  return requiredSessionPolicySpawnBinding({
    capability,
    advertised,
    snapshot,
    providerId: args.providerId,
    role: resolvedRole,
    warn: (providerId, reason) => {
      rawBb.log?.warn?.(`Lane Pilot clean subthread policy skipped on ${providerId} (${resolvedRole}): ${reason}`);
    },
  });
}
