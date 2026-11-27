import { MACHINE_AFFINITY_ANY } from "@lane-pilot/contracts";
import { consistentProvider, resolveRoleModel } from "@lane-pilot/models";
import { GLOBAL_SETTINGS_PROJECT_ID, LP_DEFAULTS_KEY, ONBOARDING_MODEL_KEY, ONBOARDING_PROVIDER_KEY, parseLanePilotDefaults, QA_HOST_KEY, WRITER_MODEL_KEY, WRITER_PROVIDER_KEY } from "@lane-pilot/settings-catalog";
import {
  HELPER_ROLES,
  MANDATORY_BB_PLUGINS,
  MANDATORY_MCP_SERVERS,
  bundledAgents,
  canonicalSkillName,
  effectiveGroup,
  effectiveSwitch,
  employeeView,
  isEmployeeSpecialist,
  type AgentLoadoutOutput,
  type HelperContextMode,
  type HelperRole,
  type LoadoutRole,
  type RoleAccess,
} from "../../../contracts";
import {
  EMPLOYEES,
  isCustomAgentId,
  type ServerCore,
} from "../../../contracts/server";
import {
  NATIVE_LP_BRIDGE_ARCHITECT_TOOLS,
  NATIVE_LP_BRIDGE_LEAD_TOOLS,
  NATIVE_LP_BRIDGE_PM_TOOLS,
  NATIVE_LP_BRIDGE_SPECIALIST_TOOLS,
} from "../../../native-agent";
import { STANDALONE_SPECIALIST_SKILL_PACKS, specialistProfileAccess } from "../../../native-agent/server";
import { mapListedQaHosts } from "../../../platform/server";
import { loadPrototypeConfig } from "../../../storage";
import { fetchHubCatalog, readHelperAccessState } from "./access-view";

type StoredAgentRow = Awaited<ReturnType<ServerCore["ownedAgents"]>>[string];

type LoadoutItem = LoadoutRole["items"][number];
type LoadoutItemType = LoadoutItem["type"];
type LoadoutItemFrom = LoadoutItem["from"];
type LoadoutModel = LoadoutRole["model"];
type LoadoutModelFrom = LoadoutModel["from"];

const WRITER_ROLES = new Set(["writer", "code-repair", "night-fixer"]);
const MANDATORY_BB_PLUGIN_SET = new Set<string>(MANDATORY_BB_PLUGINS);
const MANDATORY_MCP_SET = new Set<string>(MANDATORY_MCP_SERVERS);
const PM_ROLE_ID = "dev-orchestrator";

export type AgentLoadoutInput = {
  projectId?: string;
  sectionId?: string;
  role?: string;
};

type McpProbeResult = { available: boolean; servers: Set<string> };

/** Resolves effective loadout (model, skills, plugins, MCP, instructions, tools) per role at the selected scope. */
export async function agentLoadout(
  ctx: Pick<
    ServerCore,
    "bb" | "db" | "host" | "log" | "ownedAgents" | "effectiveProjectSettings" | "listProjectSections" | "sectionChain"
  >,
  input: AgentLoadoutInput = {},
): Promise<AgentLoadoutOutput> {
  const projectId = input.projectId ?? GLOBAL_SETTINGS_PROJECT_ID;
  const accessState = await readHelperAccessState(ctx, { projectId, sectionId: input.sectionId });
  const effective = (await ctx.effectiveProjectSettings(projectId, accessState.scopes)).values;
  const defaults = parseLanePilotDefaults(await ctx.bb.storage.kv.get(LP_DEFAULTS_KEY).catch(() => null));
  const protoConfig = accessState.isGlobal ? null : loadPrototypeConfig(ctx.db, projectId);
  const owned = await ctx.ownedAgents();

  const contextMode: HelperContextMode = accessState.parsed.ok ? accessState.parsed.settings.mode : "roles";
  const catalog = await fetchHubCatalog(ctx, projectId, accessState.isGlobal, { logPrefix: "[loadout]" });

  if (!catalog.skillsAvailable) {
    ctx.log(`[loadout] hub skills unavailable: ${catalog.skillsError ?? "unknown error"}`);
  }

  const hubSkillNames = new Set(
    catalog.skillRows
      .map((row) => (typeof row.name === "string" ? row.name.trim() : ""))
      .filter((name) => name.length > 0),
  );
  const hubSkills = catalog.skillsAvailable ? hubSkillNames.size : -1;

  const enabledPlugins = new Set(
    catalog.pluginRows
      .filter((row) => typeof row.id === "string" && row.id.trim().length > 0 && row.enabled !== false)
      .map((row) => row.id!.trim()),
  );

  const hosts = await listConnectedHosts(ctx);
  const mcpProbeCache = new Map<string | null, Promise<McpProbeResult>>();
  const probeMcp = (machine: string | null): Promise<McpProbeResult> => {
    const key = machine ?? null;
    let pending = mcpProbeCache.get(key);
    if (!pending) {
      pending = fetchHostMcpInventory(ctx, hosts, key);
      mcpProbeCache.set(key, pending);
    }
    return pending;
  };

  const resolveModel = (roleId: string, ownedRow?: StoredAgentRow): LoadoutModel => {
    if (roleId === PM_ROLE_ID) {
      if (protoConfig?.pmProviderId && protoConfig.pmModel) {
        return { provider: protoConfig.pmProviderId, model: protoConfig.pmModel, from: "project" };
      }
      return { provider: null, model: null, from: "builtin" };
    }
    if (WRITER_ROLES.has(roleId)) {
      const provider = nonEmpty(effective[WRITER_PROVIDER_KEY]) ?? protoConfig?.writerProviderId ?? null;
      const model = nonEmpty(effective[WRITER_MODEL_KEY]) ?? protoConfig?.writerModel ?? null;
      const level = accessState.settingLevel(WRITER_MODEL_KEY) ?? accessState.settingLevel(WRITER_PROVIDER_KEY);
      const from: LoadoutModelFrom = level
        ? level
        : defaults.writerProviderId || defaults.writerModel
          ? "system"
          : protoConfig?.writerModel
            ? "project"
            : "builtin";
      return { provider, model, from };
    }
    if (roleId === "workspace-provisioner") {
      return { provider: null, model: null, from: "builtin" };
    }
    if (roleId === "onboarder") {
      const provider = nonEmpty(effective[ONBOARDING_PROVIDER_KEY]);
      const model = nonEmpty(effective[ONBOARDING_MODEL_KEY]);
      if (provider && model) {
        return { provider, model, from: accessState.settingLevel(ONBOARDING_MODEL_KEY) ?? "legacy" };
      }
      return { provider: null, model: null, from: "builtin" };
    }
    if (ownedRow?.meta?.model) {
      return {
        provider: consistentProvider(null, ownedRow.meta.model),
        model: ownedRow.meta.model,
        from: "system",
      };
    }
    const chosen = resolveRoleModel(roleId, effective);
    const from: LoadoutModelFrom = chosen.source === "table"
      ? (chosen.sourceKey ? accessState.settingLevel(chosen.sourceKey) ?? "system" : "system")
      : chosen.source === "stage"
        ? "legacy"
        : "builtin";
    return { provider: chosen.providerId, model: chosen.model, from };
  };

  const checkMissing = async (
    items: Array<Omit<LoadoutItem, "missing">>,
    machine: string | null,
  ): Promise<{ items: LoadoutItem[]; mcpInventoryMissing: boolean }> => {
    const hasCheckableMcp = items.some((item) => item.type === "mcp" && !MANDATORY_MCP_SET.has(item.name));
    const mcp = hasCheckableMcp ? await probeMcp(machine) : { available: true, servers: new Set<string>() };
    const checked = items.map((item): LoadoutItem => {
      if (item.type === "skill") {
        return { ...item, missing: catalog.skillsAvailable ? !hubSkillNames.has(item.name) : false };
      }
      if (item.type === "plugin") {
        return { ...item, missing: catalog.pluginsAvailable ? !enabledPlugins.has(item.name) : false };
      }
      if (item.type === "mcp") {
        if (MANDATORY_MCP_SET.has(item.name)) return { ...item, missing: false };
        return { ...item, missing: mcp.available ? !mcp.servers.has(item.name) : false };
      }
      return { ...item, missing: false };
    });
    return { items: checked, mcpInventoryMissing: hasCheckableMcp && !mcp.available };
  };

  const buildHelperItems = (
    helperRole: HelperRole,
    opts?: {
      employeeId?: string;
      ownedRow?: StoredAgentRow;
      extraTools?: readonly string[];
      extraToolsFrom?: LoadoutItemFrom;
    },
  ): { rawItems: Array<Omit<LoadoutItem, "missing">>; notes: string[] } => {
    const rawItems: Array<Omit<LoadoutItem, "missing">> = [];
    const seen = new Set<string>();
    const notes: string[] = [];
    const add = (type: LoadoutItemType, name: string, from: LoadoutItemFrom) => {
      const normalized = type === "skill" ? canonicalSkillName(name) : name;
      if (!normalized) return;
      const key = `${type}:${normalized}`;
      if (seen.has(key)) return;
      seen.add(key);
      rawItems.push({ type, name: normalized, from });
    };

    const access: RoleAccess = accessState.roleAccessMap[helperRole] ?? {};

    if (contextMode === "none") {
      for (const name of MANDATORY_BB_PLUGINS) add("plugin", name, "required");
      for (const name of MANDATORY_MCP_SERVERS) add("mcp", name, "required");
      notes.push("контекст помощников отключён (none)");
    } else if (contextMode === "selected") {
      const selected = accessState.parsed.ok ? accessState.parsed.settings : null;
      for (const name of selected?.bbPlugins ?? []) add("plugin", name, "owner");
      for (const name of MANDATORY_BB_PLUGINS) add("plugin", name, "required");
      for (const name of selected?.nativePlugins ?? []) add("plugin", name, "owner");
      for (const name of selected?.skills ?? []) add("skill", name, "owner");
      for (const name of selected?.mcpServers ?? []) add("mcp", name, "owner");
      for (const name of MANDATORY_MCP_SERVERS) add("mcp", name, "required");
      notes.push("общий выбранный список (selected)");
    } else {
      // mode === "roles" (default) or "inherit" (shows role baseline + note that parent context is inherited)
      const bbPluginsGroup = effectiveGroup(helperRole, "bbPlugins", access);
      if (bbPluginsGroup.names === null) {
        notes.push("плагины BB: весь каталог (владелец: all)");
        for (const name of MANDATORY_BB_PLUGINS) add("plugin", name, "required");
      } else if (bbPluginsGroup.source === "owner") {
        for (const name of access.bbPlugins?.names ?? []) add("plugin", name, "owner");
        for (const name of MANDATORY_BB_PLUGINS) add("plugin", name, "required");
      } else {
        for (const name of bbPluginsGroup.names) {
          if (!MANDATORY_BB_PLUGIN_SET.has(name)) add("plugin", name, "profile");
        }
        for (const name of MANDATORY_BB_PLUGINS) add("plugin", name, "required");
      }

      const nativePluginsGroup = effectiveGroup(helperRole, "nativePlugins", access);
      if (nativePluginsGroup.names === null) {
        notes.push("нативные плагины: все (владелец: all)");
      } else {
        for (const name of nativePluginsGroup.names) {
          add("plugin", name, nativePluginsGroup.source === "owner" ? "owner" : "profile");
        }
      }

      const skillsGroup = effectiveGroup(helperRole, "skills", access);
      if (skillsGroup.names === null) {
        notes.push("скиллы: весь каталог (владелец: all)");
      } else if (skillsGroup.source === "owner") {
        for (const name of access.skills?.names ?? []) add("skill", name, "owner");
      } else {
        for (const name of skillsGroup.names) add("skill", name, "profile");
        if (opts?.employeeId) {
          const emp = Object.hasOwn(EMPLOYEES, opts.employeeId) ? EMPLOYEES[opts.employeeId] : undefined;
          for (const name of emp?.coreSkills ?? []) add("skill", name, "employee");
          for (const name of opts.ownedRow?.meta?.coreSkills ?? []) add("skill", name, "employee");
          for (const name of opts.ownedRow?.compiled?.skills ?? []) {
            add("skill", name, isEmployeeSpecialist(opts.employeeId) ? "employee" : "owner");
          }
          const pack = STANDALONE_SPECIALIST_SKILL_PACKS[opts.employeeId] ?? [];
          for (const name of pack) add("skill", name, "domain_pack");
          if (pack.length > 0) notes.push("в шаге графа пакета нет");
        }
      }

      const mcpGroup = effectiveGroup(helperRole, "mcpServers", access);
      if (mcpGroup.names === null) {
        notes.push("MCP: весь каталог (владелец: all)");
        for (const name of MANDATORY_MCP_SERVERS) add("mcp", name, "required");
      } else if (mcpGroup.source === "owner") {
        for (const name of access.mcpServers?.names ?? []) add("mcp", name, "owner");
        for (const name of MANDATORY_MCP_SERVERS) add("mcp", name, "required");
      } else {
        for (const name of mcpGroup.names) {
          if (!MANDATORY_MCP_SET.has(name)) add("mcp", name, "profile");
        }
        if (opts?.employeeId) {
          const extra = specialistProfileAccess(opts.employeeId, opts.ownedRow, { openEnded: true });
          for (const name of extra.mcpServers ?? []) add("mcp", name, "owner");
        }
        for (const name of MANDATORY_MCP_SERVERS) add("mcp", name, "required");
      }

      if (contextMode === "inherit") {
        notes.push("наследует контекст родителя (не сужается)");
      }
    }

    const userInst = effectiveSwitch("userInstructions", access, helperRole);
    if (userInst.include) add("instructions", "userInstructions", userInst.source === "owner" ? "owner" : "profile");
    const projInst = effectiveSwitch("projectInstructions", access, helperRole);
    if (projInst.include) add("instructions", "projectInstructions", projInst.source === "owner" ? "owner" : "profile");

    for (const tool of opts?.extraTools ?? []) {
      add("tool", tool, opts?.extraToolsFrom ?? "profile");
    }

    return { rawItems, notes };
  };

  const builtRoles: LoadoutRole[] = [];

  // 1. Pipeline roles from ROLE_PROFILES (non-employee entries).
  for (const helperRole of HELPER_ROLES) {
    if (helperRole.startsWith("specialist:") && isEmployeeSpecialist(helperRole.slice("specialist:".length))) {
      continue;
    }
    const extraTools = helperRole === "lead"
      ? NATIVE_LP_BRIDGE_LEAD_TOOLS
      : helperRole === "workflow-architect"
        ? NATIVE_LP_BRIDGE_ARCHITECT_TOOLS
        : undefined;
    const machine = helperRole === "browser-qa"
      ? (nonEmpty(effective[QA_HOST_KEY]) ?? "mac-mini")
      : null;
    const { rawItems, notes } = buildHelperItems(helperRole, { extraTools, extraToolsFrom: "profile" });
    const { items, mcpInventoryMissing } = await checkMissing(rawItems, machine);
    if (mcpInventoryMissing) notes.push("инвентарь MCP недоступен");
    builtRoles.push({
      role: helperRole,
      kind: "pipeline",
      model: resolveModel(helperRole),
      items,
      contextMode,
      machine,
      note: notes.length ? notes.join("; ") : null,
    });
  }

  // 2. Built-in employees from EMPLOYEES.
  for (const empId of Object.keys(EMPLOYEES)) {
    const ownedRow = owned[empId]?.compiledCorrupt ? undefined : owned[empId];
    const helperRole = (`specialist:${empId}`) as HelperRole;
    const affinity = employeeView(empId, ownedRow?.meta).machineAffinity;
    const machine = affinity === MACHINE_AFFINITY_ANY ? null : affinity;
    const { rawItems, notes } = buildHelperItems(helperRole, {
      employeeId: empId,
      ownedRow,
      extraTools: NATIVE_LP_BRIDGE_SPECIALIST_TOOLS,
      extraToolsFrom: "employee",
    });
    const { items, mcpInventoryMissing } = await checkMissing(rawItems, machine);
    if (mcpInventoryMissing) notes.push("инвентарь MCP недоступен");
    builtRoles.push({
      role: empId,
      kind: "specialist",
      model: resolveModel(empId, ownedRow),
      items,
      contextMode,
      machine,
      note: notes.length ? notes.join("; ") : null,
    });
  }

  // 3. Owner-defined custom agents from agents:v1.
  for (const [customId, ownedRow] of Object.entries(owned)) {
    if (!isCustomAgentId(customId) || ownedRow.compiledCorrupt) continue;
    const helperRole = (`specialist:${customId}`) as HelperRole;
    const affinity = employeeView(customId, ownedRow.meta, ownedRow.compiled?.skills).machineAffinity;
    const machine = affinity === MACHINE_AFFINITY_ANY ? null : affinity;
    const customTools = [
      ...(ownedRow.compiled?.tools ?? []),
      ...NATIVE_LP_BRIDGE_SPECIALIST_TOOLS,
    ];
    const { rawItems, notes } = buildHelperItems(helperRole, {
      employeeId: customId,
      ownedRow,
      extraTools: customTools,
      extraToolsFrom: "owner",
    });
    const { items, mcpInventoryMissing } = await checkMissing(rawItems, machine);
    if (mcpInventoryMissing) notes.push("инвентарь MCP недоступен");
    builtRoles.push({
      role: customId,
      kind: "custom",
      model: resolveModel(customId, ownedRow),
      items,
      contextMode,
      machine,
      note: notes.length ? notes.join("; ") : null,
    });
  }

  // 4. PM coordinator (not narrowed by helper context policies).
  const pmBundled = (bundledAgents as Record<string, { skills?: string[] }>)[PM_ROLE_ID];
  const pmRawItems: Array<Omit<LoadoutItem, "missing">> = [
    ...MANDATORY_BB_PLUGINS.map((name) => ({ type: "plugin" as const, name, from: "required" as const })),
    { type: "plugin", name: "lane-pilot", from: "profile" },
    ...(pmBundled?.skills ?? []).map((name) => ({
      type: "skill" as const,
      name: canonicalSkillName(name),
      from: "profile" as const,
    })),
    ...MANDATORY_MCP_SERVERS.map((name) => ({ type: "mcp" as const, name, from: "required" as const })),
    { type: "mcp", name: "gitnexus", from: "profile" },
    { type: "mcp", name: "metamcp", from: "profile" },
    { type: "instructions", name: "LANE_PILOT_PM_SESSION", from: "profile" },
    { type: "instructions", name: "pmRunInstructions", from: "profile" },
    { type: "instructions", name: "userInstructions", from: "catalog" },
    { type: "instructions", name: "projectInstructions", from: "catalog" },
    ...NATIVE_LP_BRIDGE_PM_TOOLS.map((name) => ({ type: "tool" as const, name, from: "profile" as const })),
  ];
  const pmChecked = await checkMissing(pmRawItems, null);
  builtRoles.push({
    role: PM_ROLE_ID,
    kind: "pm",
    model: resolveModel(PM_ROLE_ID),
    items: pmChecked.items,
    contextMode,
    machine: null,
    note: "плюс весь каталог BB",
  });

  if (input.role !== undefined) {
    const target = input.role;
    const filtered = builtRoles.filter((entry) => {
      if (entry.role === target) return true;
      if (target === "pm" && entry.kind === "pm") return true;
      if (target.startsWith("specialist:") && entry.kind === "specialist" && entry.role === target.slice("specialist:".length)) {
        return true;
      }
      return false;
    });
    return { roles: filtered, hubSkills };
  }

  return { roles: builtRoles, hubSkills };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

type ConnectedHost = { id: string; name: string; connected: boolean };

async function listConnectedHosts(ctx: Pick<ServerCore, "bb">): Promise<ConnectedHost[]> {
  try {
    const listed = await (ctx.bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
    return mapListedQaHosts(listed ?? []).filter((host) => host.connected);
  } catch {
    return [];
  }
}

async function fetchHostMcpInventory(
  ctx: Pick<ServerCore, "host">,
  hosts: ConnectedHost[],
  machine: string | null,
): Promise<McpProbeResult> {
  if (!hosts.length || typeof ctx.host?.call !== "function") {
    return { available: false, servers: new Set() };
  }
  const preferred = machine
    ? hosts.find((host) => host.id === machine || host.name.toLowerCase().replace(/\s+/g, "-") === machine.toLowerCase()) ?? hosts[0]!
    : hosts[0]!;
  try {
    const result = await ctx.host.call("session_inventory", { cwd: null }, { hostId: preferred.id });
    const servers = new Set((result?.mcpServers ?? []).map((row) => row.name));
    return { available: true, servers };
  } catch {
    return { available: false, servers: new Set() };
  }
}
