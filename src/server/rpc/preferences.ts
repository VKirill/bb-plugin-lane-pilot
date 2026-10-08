import { applyResourceMode, collectAgentInventory } from "../../agent-inventory";
import { compileEffectiveMainAgent, compileMainAgentProfile } from "../../agent-profile";
import { detectRequiredSessionPolicyCapability } from "../../helper-context";
import { LP_AGENT_OVERRIDES_KEY, LP_DEFAULTS_KEY, packStoredDefaults, parseDefaultsRevision, parseLanePilotDefaults } from "../../lp-defaults";
import { userVisibleProjects } from "../../project-scope";
import { mapListedQaHosts } from "../../qa-host";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function preferencesRpc(ctx: ServerCore, services: Services) {
  const { bb, host, listProjectSections, ownedAgents, serializedKv } = ctx;
  return {
    get_preferences: async ({ suggestedLocale }) => {
      const storedLocale = await bb.storage.kv.get<string>("preferences:locale");
      const lastProjectId = await bb.storage.kv.get<string>("preferences:lastProjectId");
      const preference: "auto" | "en" | "ru" = storedLocale === "ru" || storedLocale === "en" ? storedLocale : "auto";
      const resolvedLocale: "en" | "ru" = preference === "auto" ? suggestedLocale : preference;
      if (storedLocale !== preference) await bb.storage.kv.set("preferences:locale", preference);
      return { locale: resolvedLocale, preference, lastProjectId: lastProjectId ?? null };
    },
    set_locale: async ({ locale: preference, suggestedLocale }) => {
      await bb.storage.kv.set("preferences:locale", preference);
      const locale = preference === "auto" ? suggestedLocale : preference;
      return { locale, preference };
    },
    remember_project: async ({ projectId }) => {
      await bb.storage.kv.set("preferences:lastProjectId", projectId);
      return { ok: true as const };
    },
    list_sections: async ({ projectId }) => ({
      sections: (await listProjectSections(projectId)).map((row) => ({ id:row.id, parentId:row.parentId, name:row.name, path:row.path, kind:row.kind })),
    }),
    list_projects: async () => {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: projects.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
        })),
        lastProjectId: await bb.storage.kv.get<string>("preferences:lastProjectId") ?? null,
      };
    },
    get_globals: async () => {
      const raw = await bb.storage.kv.get(LP_DEFAULTS_KEY);
      let hosts: Array<{ id: string; name: string; status: string; connected: boolean }> = [];
      try {
        const listed = await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
        hosts = mapListedQaHosts(listed ?? []);
      } catch {
        hosts = [];
      }
      return {
        defaults: parseLanePilotDefaults(raw),
        revision: parseDefaultsRevision(raw),
        agents: await services.listedAgentProfiles(),
        hosts,
        requiredSessionPolicy: detectRequiredSessionPolicyCapability((bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {}) ? "required" : "none",
      };
    },
    get_agent_inventory: async ({ projectId, hostId }) => {
      let resolvedProject = projectId ?? await bb.storage.kv.get<string>("preferences:lastProjectId") ?? null;
      if (!resolvedProject) {
        try {
          const listed = await bb.sdk.projects.list({ includePersonal: true });
          resolvedProject = userVisibleProjects(listed.map((row) => ({
            id: row.id,
            name: row.name,
            kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
          })))[0]?.id ?? null;
        } catch {
          resolvedProject = null;
        }
      }
      let resolvedHost = hostId;
      if (!resolvedHost) {
        try {
          const listed = await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.();
          const hosts = mapListedQaHosts(listed ?? []);
          resolvedHost = hosts.find((row) => row.connected)?.id ?? hosts[0]?.id ?? null;
        } catch {
          resolvedHost = null;
        }
      }
      return collectAgentInventory({
        projectId: resolvedProject,
        listSkills: resolvedProject
          ? async (id) => {
            const listed = await bb.sdk.skills.list({ projectId: id, environmentId: null });
            return listed.skills.map((skill) => ({ name: skill.name, pluginId: skill.pluginId }));
          }
          : undefined,
        listMcp: resolvedHost
          ? async () => {
            const machine = await host.call("session_inventory", { cwd: null }, { hostId: resolvedHost });
            return machine.mcpServers;
          }
          : undefined,
      });
    },
    save_globals: async ({ defaults, expectedRevision }) => serializedKv(async () => {
      const raw = await bb.storage.kv.get(LP_DEFAULTS_KEY);
      const revision = parseDefaultsRevision(raw);
      if (revision !== expectedRevision) {
        return { ok: false, revision, defaults: parseLanePilotDefaults(raw) };
      }
      const next = parseLanePilotDefaults(defaults);
      const nextRevision = revision + 1;
      await bb.storage.kv.set(LP_DEFAULTS_KEY, packStoredDefaults(next, nextRevision));
      return { ok: true, revision: nextRevision, defaults: next };
    }),
    save_agent_profile: async ({ id, prompt, description, expectedSourceHash, tools, disallowedTools, skills, mcpServers, resourceModes }) => serializedKv(async () => {
      const owned = await ownedAgents();
      if (owned[id]?.compiledCorrupt) return { ok: false, id, sourceHash: "" };
      const previous = owned[id]?.compiled;
      let currentHash = "";
      try { currentHash = compileEffectiveMainAgent(id, owned[id]).sourceHash; } catch { currentHash = previous?.sourceHash ?? ""; }
      if (expectedSourceHash !== currentHash && expectedSourceHash !== (previous?.sourceHash ?? "")) {
        return { ok: false, id, sourceHash: currentHash };
      }
      let compiled;
      try {
        const nextTools = applyResourceMode(resourceModes?.tools, tools, previous?.tools);
        const nextDisallowed = applyResourceMode(resourceModes?.disallowedTools, disallowedTools, previous?.disallowedTools);
        const nextSkills = applyResourceMode(resourceModes?.skills, skills, previous?.skills);
        const nextMcp = applyResourceMode(resourceModes?.mcpServers, mcpServers, previous?.mcpServers);
        compiled = compileMainAgentProfile(id, {
          prompt,
          description: description ?? previous?.description,
          ...(nextTools !== undefined ? { tools: nextTools } : {}),
          ...(nextDisallowed !== undefined ? { disallowedTools: nextDisallowed } : {}),
          ...(nextSkills !== undefined ? { skills: nextSkills } : {}),
          ...(nextMcp !== undefined ? { mcpServers: nextMcp } : {}),
        });
      } catch {
        return { ok: false, id, sourceHash: currentHash };
      }
      owned[id] = { prompt, ...(description ? { description } : {}), compiled };
      await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, owned);
      return { ok: true, id, sourceHash: compiled.sourceHash };
    }),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "get_preferences" | "set_locale" | "remember_project" | "list_sections" | "list_projects" | "get_globals" | "get_agent_inventory" | "save_globals" | "save_agent_profile">;
}
