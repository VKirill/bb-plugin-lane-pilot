import { GLOBAL_SETTINGS_PROJECT_ID, HELPER_CONTEXT_MODE_KEY } from "@lane-pilot/settings-catalog";
import {
  ACCESS_GROUPS,
  ACCESS_SWITCHES,
  CORE_PROVIDER_GROUPS,
  HELPER_ROLES,
  MANDATORY_BB_PLUGINS,
  MANDATORY_MCP_SERVERS,
  effectiveGroup,
  effectiveSwitch,
  parseHelperContextSettings,
  parseRoleAccess,
  roleAccessKey,
  type HelperRole,
  type RoleAccess,
} from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import { getSettingVersions, listSettingRows, loadProjectSettings } from "../../../storage";
import { PROVIDER_CAPABILITIES } from "@lane-pilot/models";

export type SettingOrigin = "global" | "project" | "section";
export type SettingLevel = "system" | "project" | "section";

export type HubCatalogPluginRow = { id?: string; name?: string; displayName?: string; enabled?: boolean };
export type HubCatalogSkillRow = { name?: string; description?: string; store?: string };

export type HubCatalogFetchResult = {
  pluginRows: HubCatalogPluginRow[];
  skillRows: HubCatalogSkillRow[];
  pluginsAvailable: boolean;
  pluginsError: string | null;
  skillsAvailable: boolean;
  skillsError: string | null;
};

type CatalogCacheEntry = {
  at: number;
  value: { pluginRows: HubCatalogPluginRow[]; skillRows: HubCatalogSkillRow[] };
};

const CATALOG_TTL_MS = 60_000;

/** Reads effective settings, per-scope origins, and `helper.access.<role>` overrides for a place. */
export async function readHelperAccessState(
  ctx: Pick<ServerCore, "db" | "listProjectSections" | "sectionChain">,
  input: { projectId: string; sectionId?: string },
) {
  const { projectId, sectionId } = input;
  const scopes = sectionId ? ctx.sectionChain(await ctx.listProjectSections(projectId), sectionId) : [];
  const bindingId = scopes.at(-1) ?? "";
  const settings = loadProjectSettings(ctx.db, projectId, scopes);
  const own = new Map(listSettingRows(ctx.db, projectId, bindingId).map((row) => [row.key, row]));
  const parsed = parseHelperContextSettings(settings);
  const versions = getSettingVersions(ctx.db, projectId, HELPER_ROLES.map(roleAccessKey), bindingId);
  const isGlobal = projectId === GLOBAL_SETTINGS_PROJECT_ID;
  const scopeRows: Array<[SettingOrigin, Set<string>]> = [
    ...(isGlobal ? [] : [["global", new Set(listSettingRows(ctx.db, GLOBAL_SETTINGS_PROJECT_ID, "").map((row) => row.key))] as ["global", Set<string>]]),
    [isGlobal ? "global" : "project", new Set(listSettingRows(ctx.db, projectId, "").map((row) => row.key))],
    ...scopes.map((binding) => ["section", new Set(listSettingRows(ctx.db, projectId, binding).map((row) => row.key))] as ["section", Set<string>]),
  ];
  const originIn = (rows: typeof scopeRows, key: string): SettingOrigin | null => {
    let found: SettingOrigin | null = null;
    for (const [name, keys] of rows) if (keys.has(key)) found = name;
    return found;
  };
  const originOf = (key: string) => originIn(scopeRows, key);
  const originBelow = (key: string) => (isGlobal ? null : originIn(scopeRows.slice(0, -1), key));
  const settingLevel = (key: string): SettingLevel | null => {
    const origin = originOf(key);
    if (!origin) return null;
    return origin === "global" ? "system" : origin;
  };

  const roleAccessMap: Partial<Record<HelperRole, RoleAccess>> = {};
  const roles = HELPER_ROLES.map((role) => {
    const key = roleAccessKey(role);
    const access = parseRoleAccess(settings[key]);
    roleAccessMap[role] = access;
    return {
      role,
      key,
      version: versions[key] ?? 0,
      value: own.get(key)?.value ?? null,
      inherited: !own.has(key) && settings[key] !== undefined,
      origin: originOf(key),
      originBelow: originBelow(key),
      groups: Object.fromEntries(ACCESS_GROUPS.map((group) => [group, effectiveGroup(role, group, access)])) as never,
      switches: Object.fromEntries(ACCESS_SWITCHES.map((sw) => [sw, effectiveSwitch(sw, access, role)])) as never,
    };
  });

  return {
    projectId,
    scopes,
    bindingId,
    settings,
    parsed,
    isGlobal,
    originOf,
    originBelow,
    settingLevel,
    roles,
    roleAccessMap,
  };
}

/** Invokes a possibly synchronous-throwing SDK call safely as a Promise. */
async function safeSdkCall<T>(fn: () => Promise<T>): Promise<T> {
  return await fn();
}

/** Fetches BB plugins and hub skills (`listSkills(null)`, falling back to the project's first environment if empty/missing). */
export async function fetchHubCatalog(
  ctx: Pick<ServerCore, "bb" | "log">,
  projectId: string,
  isGlobal: boolean,
  opts?: { logPrefix?: string },
): Promise<HubCatalogFetchResult> {
  const { bb } = ctx;
  const prefix = opts?.logPrefix ?? "helper_access_view";
  let pluginsAvailable = true;
  let pluginsError: string | null = null;
  const pluginsPromise = safeSdkCall(() =>
    typeof bb.sdk.plugins?.list === "function"
      ? (bb.sdk.plugins.list() as Promise<unknown>)
      : Promise.reject(new Error("plugins API unavailable")),
  ).catch((cause) => {
    pluginsAvailable = false;
    pluginsError = cause instanceof Error ? cause.message : String(cause);
    ctx.log(`${prefix} plugins: ${pluginsError}`);
    return [];
  });

  const listedProjects = isGlobal && typeof bb.sdk.projects?.list === "function"
    ? await safeSdkCall(() => bb.sdk.projects.list() as Promise<unknown>).catch(() => [])
    : [];
  const projectRows = (Array.isArray(listedProjects)
    ? listedProjects
    : ((listedProjects as { projects?: unknown[] })?.projects ?? [])) as Array<{ id?: string }>;
  const catalogProject = isGlobal ? projectRows.find((p) => p?.id)?.id ?? projectId : projectId;

  let skillsAvailable = true;
  let skillsError: string | null = null;
  let skills: unknown = null;
  if (typeof bb.sdk.skills?.list !== "function") {
    skillsAvailable = false;
    skillsError = "skills API unavailable";
  } else {
    const listSkills = (environmentId: string | null) =>
      safeSdkCall(() => bb.sdk.skills.list({ projectId: catalogProject, environmentId } as never) as Promise<unknown>);
    skills = await listSkills(null).catch((cause) => {
      skillsError = cause instanceof Error ? cause.message : String(cause);
      if (prefix !== "[loadout]") ctx.log(`${prefix} skills: ${skillsError}`);
      return null;
    });
    if (!skills) {
      const envs = typeof bb.sdk.environments?.list === "function"
        ? await safeSdkCall(() => bb.sdk.environments.list({ projectId: catalogProject } as never) as Promise<unknown>).catch(() => [])
        : [];
      const env = (Array.isArray(envs) ? envs : ((envs as { environments?: unknown[] })?.environments ?? [])) as Array<{ id?: string }>;
      if (env[0]?.id) {
        skills = await listSkills(env[0].id).catch((cause) => {
          skillsError = cause instanceof Error ? cause.message : String(cause);
          if (prefix !== "[loadout]") ctx.log(`${prefix} skills (env): ${skillsError}`);
          return null;
        });
      }
    }
    if (!skills) skillsAvailable = false;
  }

  const skillRows = (Array.isArray(skills)
    ? skills
    : ((skills as { skills?: unknown[] } | null)?.skills ?? [])) as HubCatalogSkillRow[];
  const plugins = await pluginsPromise;
  const pluginRows = (Array.isArray(plugins)
    ? plugins
    : ((plugins as { plugins?: unknown[] } | null)?.plugins ?? [])) as HubCatalogPluginRow[];

  return { pluginRows, skillRows, pluginsAvailable, pluginsError, skillsAvailable, skillsError };
}

/** Builds the `helper_access_view` RPC handler with a per-instance 60s catalog cache. */
export function createHelperAccessView(
  ctx: Pick<ServerCore, "bb" | "db" | "listProjectSections" | "sectionChain" | "log">,
) {
  const catalogCache = new Map<string, CatalogCacheEntry>();

  const loadCatalog = async (projectId: string, isGlobal: boolean) => {
    const cached = catalogCache.get(projectId);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const { pluginRows, skillRows } = await fetchHubCatalog(ctx, projectId, isGlobal);
    const value = { pluginRows, skillRows };
    if (pluginRows.length || skillRows.length) catalogCache.set(projectId, { at: Date.now(), value });
    return value;
  };

  return async ({ projectId, sectionId }: { projectId: string; sectionId?: string }) => {
    const state = await readHelperAccessState(ctx, { projectId, sectionId });
    const { pluginRows, skillRows } = await loadCatalog(projectId, state.isGlobal);
    return {
      mode: state.parsed.ok ? state.parsed.settings.mode : "invalid",
      modeOrigin: state.originOf(HELPER_CONTEXT_MODE_KEY),
      roles: state.roles,
      catalog: {
        bbPlugins: pluginRows
          .filter((p) => typeof p.id === "string")
          .map((p) => ({ id: p.id!, name: p.displayName ?? p.name ?? p.id! }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        skills: [...new Map(
          skillRows
            .filter((k) => typeof k.name === "string")
            .map((k) => [
              k.name!,
              {
                name: k.name!,
                description: (k.description ?? "").slice(0, 200),
                store: typeof k.store === "string" && k.store ? k.store : "общие BB",
              },
            ]),
        ).values()].sort((a, b) => a.name.localeCompare(b.name)),
        // Where the list looked (SMA m_sw_skills): an empty list names the places, not silence.
        skillsLooked: ["общие навыки BB", `навыки проекта «${projectId}»`],
      },
      mandatory: { bbPlugins: [...MANDATORY_BB_PLUGINS], mcpServers: [...MANDATORY_MCP_SERVERS] },
      providers: Object.fromEntries(
        Object.entries(CORE_PROVIDER_GROUPS)
          .filter(([id]) => !PROVIDER_CAPABILITIES[id]?.notStarted)
          .map(([id, groups]) => [id, [...groups]]),
      ),
    };
  };
}
