import { MAIN_AGENT_PROFILE_IDS, compileEffectiveMainAgent, compileMainAgentProfile } from "../../native-agent/agent-profile";
import { loadPrototypeConfig } from "../../storage/database";
import { GLOBAL_SETTINGS_PROJECT_ID, LP_DEFAULTS_KEY, parseLanePilotDefaults } from "@lane-pilot/settings-catalog";
import { resolveWriterBinding } from "../../native-agent/project-binding";
import type { ProjectSourceBinding } from "../../native-agent/project-binding";
import { mapListedQaHosts } from "../../qa/qa-host";
import { stringAt } from "../../core/server/values";
import type { ServerCore } from "../../core/server/core";

export function createWriterHost(ctx: ServerCore) {
  const { bb, db, host, ownedAgents, writerBindingKey } = ctx;

  async function resolveProjectWriterHost(args: {
    projectId: string;
    threadId?: string | null;
    selected?: { hostId: string; path: string } | null;
  }) {
    if (args.projectId === GLOBAL_SETTINGS_PROJECT_ID) {
      // Global settings are not tied to a folder; any connected machine lists the model catalog.
      const hosts = mapListedQaHosts(await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.().catch(() => []) ?? []);
      const preferred = parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)).qaHostId;
      const host = hosts.find((row) => row.connected && row.id === preferred) ?? hosts.find((row) => row.connected);
      return host
        ? { status: "resolved" as const, hostId: host.id, path: "", source: "explicit_override" as const }
        : { status: "catalog_unavailable" as const, reason: "no connected machine" };
    }
    let project: { sources?: ProjectSourceBinding[] } | null = null;
    const getProject = bb.sdk.projects?.get;
    const legacyAbsent = typeof getProject !== "function";
    if (!legacyAbsent) {
      try {
        project = await getProject({ projectId: args.projectId }) as { sources?: ProjectSourceBinding[] } | null;
      } catch (cause) {
        return {
          status: "catalog_unavailable" as const,
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    }
    const sources = (Array.isArray(project?.sources) ? project.sources : []) as ProjectSourceBinding[];
    const config = loadPrototypeConfig(db, args.projectId);
    let session: { environmentId?: string | null; projectId?: string | null } | undefined;
    let environment: { id: string; hostId: string; path: string | null; status: string; projectId?: string | null } | null = null;
    if (args.threadId) {
      const thread = await bb.sdk.threads.get({ threadId: args.threadId }).catch(() => null);
      if (thread && stringAt(thread, "projectId") === args.projectId) {
        const environmentId = stringAt(thread, "environmentId");
        session = { environmentId, projectId: stringAt(thread, "projectId") };
        if (environmentId) {
          const env = await bb.sdk.environments.get({ environmentId }).catch(() => null);
          if (env) {
            environment = {
              id: stringAt(env, "id") ?? environmentId,
              hostId: stringAt(env, "hostId") ?? "",
              path: stringAt(env, "path"),
              status: stringAt(env, "status") ?? "",
              projectId: stringAt(env, "projectId"),
            };
          }
        }
      }
    }
    const resolveWith = (selected: { hostId: string; path: string } | null) => resolveWriterBinding({
      projectId: args.projectId,
      sources,
      session,
      environment,
      explicit: config ? { hostId: config.hostId, path: config.writerWorkspacePath } : undefined,
      selected,
    });
    const resolved = resolveWith(args.selected ?? null);
    if (resolved.status !== "ambiguous" || args.selected) return resolved;
    // The machine and folder the user picked on the settings page settle an ambiguous project.
    const stored = await bb.storage.kv.get(writerBindingKey(args.projectId)) as { hostId?: unknown; path?: unknown } | null;
    if (typeof stored?.hostId !== "string" || typeof stored.path !== "string") return resolved;
    const chosen = resolveWith({ hostId: stored.hostId, path: stored.path });
    return chosen.status === "resolved" ? chosen : resolved;
  }

  async function selectionCatalogHost(projectId: string, threadId?: string | null, selected?: { hostId: string; path: string } | null) {
    const binding = await resolveProjectWriterHost({ projectId, threadId, selected });
    if (binding.status === "catalog_unavailable") {
      return { ok: false as const, validation: { code: "catalog_unavailable" as const, key: "project.sources", params: ["project.sources", binding.reason] } };
    }
    if (binding.status === "setup_required") {
      return { ok: false as const, validation: { code: "setup_required" as const, key: "project.sources", params: ["project.sources", "project_folders_source_required"] } };
    }
    if (binding.status === "ambiguous") {
      return { ok: false as const, validation: { code: "writer_binding_ambiguous" as const, key: "project.sources", params: ["project.sources", "select_existing_project_binding"] } };
    }
    if (binding.status === "offline") {
      return { ok: false as const, validation: { code: "writer_host_offline" as const, key: "project.sources", params: ["project.sources", binding.hostId] } };
    }
    return { ok: true as const, hostId: binding.hostId };
  }

  async function listedAgentProfiles() {
    const owned = await ownedAgents();
    const ids = [...new Set([...MAIN_AGENT_PROFILE_IDS, ...Object.keys(owned)])];
    const rows: Array<{
      id: string; description: string; prompt: string; sourceHash: string; sourceVersion: string; edited: boolean;
      tools?: string[]; disallowedTools?: string[]; skills?: string[]; mcpServers?: string[];
    }> = [];
    for (const id of ids) {
      try {
        if (owned[id]?.compiledCorrupt) continue;
        const compiled = compileEffectiveMainAgent(id, owned[id]);
        const stock = (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(id) ? compileMainAgentProfile(id) : null;
        rows.push({
          id,
          description: compiled.description,
          prompt: compiled.prompt,
          sourceHash: compiled.sourceHash,
          sourceVersion: compiled.sourceVersion,
          edited: stock ? compiled.sourceHash !== stock.sourceHash : true,
          ...(compiled.tools ? { tools: compiled.tools } : {}),
          ...(compiled.disallowedTools ? { disallowedTools: compiled.disallowedTools } : {}),
          ...(compiled.skills ? { skills: compiled.skills } : {}),
          ...(compiled.mcpServers ? { mcpServers: compiled.mcpServers } : {}),
        });
      } catch { /* skip incomplete custom rows */ }
    }
    return rows;
  }

  return { resolveProjectWriterHost, selectionCatalogHost, listedAgentProfiles };
}
