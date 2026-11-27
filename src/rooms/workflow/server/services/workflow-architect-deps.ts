import { QA_HOST_KEY } from "@lane-pilot/settings-catalog";
import { bestEffort, isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import type { collectCapabilities } from "@lane-pilot/workflow-engine";
import { configuredSetting, isCustomAgentId, type ServerCore } from "../../../contracts/server";
import { EMPLOYEE_IDS, isEmployeeSpecialist } from "../../../contracts/employee-manifest";
import { SPECIALIST_ROLES } from "../../../critique/server";
import type { DocsApi } from "../../../docs/server";
import { mapListedQaHosts, modelCatalogOf, type WorkflowLibraryApi } from "../../../platform/server";
import { findOpenNativeRun, getRunSettingsScopes, globalWorkflowDir, loadProjectSettings } from "../../../storage";
import type { DedupeGateOptions } from "./dedupe-gate";
import type { WorkflowEngineApi } from "./workflow";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";

/** The fields of the services bag `workflow-architect` reads, typed by the rooms that own them. */
export interface Services {
  docsPlaces: DocsApi["docsPlaces"];
  workflowCatalog: WorkflowEngineApi["workflowCatalog"];
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowTriggers: WorkflowTriggersApi["workflowTriggers"];
  workflowLibrary?: WorkflowLibraryApi;
  dedupeThreshold?: number | (() => number);
}

export type Place = { hostId: string; path: string };

/** What the architect touches outside the plugin's database; a test replaces them. */
export type ArchitectDeps = {
  globalDir: () => string;
  /** The folder and machine of the project the calling chat works in. */
  projectPlace: (threadId: string) => Promise<Place | null>;
  /** The same for a publish from the Workflows tab, which has no chat: the project's own folder and machine. */
  projectPlaceOf?: (projectId: string) => Promise<Place | null>;
  writeProjectFile: (place: Place, id: string, content: string, expectedSha256: string | null) => Promise<{ status: "applied" | "conflict"; path: string; afterSha256: string | null; reason: string | null }>;
  /** A skill, plugin, MCP, secret and machine lister for the project; see collectCapabilities. */
  capabilityPorts: (input: { projectId: string; threadId: string }) => Parameters<typeof collectCapabilities>[0];
  hasExecutor: (key: string) => boolean;
  /** The project's name, to tell a sandbox (canary.ts isSandboxProjectName); null when unknown. */
  projectName?: (projectId: string) => Promise<string | null>;
  /** Whether `specialist:<id>` names a bundled specialist or an agent the owner created; null when the owner's agents have not been read yet. */
  specialistKnown?: (id: string) => boolean | null;
  dedupeThreshold?: number | (() => number);
  loadLibraryWorkflows?: DedupeGateOptions["loadLibraryWorkflows"];
};

export function realDeps(ctx: ServerCore, services: Services): ArchitectDeps {
  const { bb, db, host } = ctx;
  const hostsList = async () => mapListedQaHosts(await (bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.() ?? []);
  const place = async (threadId: string): Promise<Place | null> => {
    const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
    const environmentId = stringAt(thread, "environmentId");
    const environment = environmentId ? await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound) : null;
    const path = stringAt(environment, "path"), hostId = stringAt(environment, "hostId");
    return path?.startsWith("/") && hostId ? { hostId, path } : null;
  };
  const catalog = modelCatalogOf(ctx);
  return {
    globalDir: () => globalWorkflowDir(),
    projectName: async (projectId) => stringAt(await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound), "name"),
    specialistKnown: (id) => {
      if (SPECIALIST_ROLES.includes(id as never) || isEmployeeSpecialist(id)) return true;
      const own = ctx.knownCustomAgentIds();
      return own ? own.has(id) : null;
    },
    projectPlace: place,
    projectPlaceOf: async (projectId) => {
      const places = await bestEffort(ctx.log, "architect project places", services.docsPlaces(projectId), []);
      const root = places.find((item) => item.scopes.length === 0) ?? places[0];
      return root ? { hostId: root.hostId, path: root.path } : null;
    },
    writeProjectFile: async (target, id, content, expectedSha256) => {
      const written = await host.call("writeWorkflowFile", { requestedHostId: target.hostId, projectCwd: target.path, id, content, expectedSha256 }, { hostId: target.hostId, timeoutMs: 30_000 });
      return { status: written.status, path: written.path, afterSha256: written.afterSha256, reason: written.reason };
    },
    hasExecutor: (key) => services.workflowEngine.hasExecutor(key),
    capabilityPorts: ({ projectId, threadId }) => ({
      skills: async () => {
        const listed = await bb.sdk.skills.list({ projectId, environmentId: null });
        return listed.skills.map((skill) => ({ name: skill.name, description: (skill as { description?: string }).description, pluginId: skill.pluginId }));
      },
      plugins: async () => {
        const listed = await (bb.sdk.plugins.list() as Promise<unknown>);
        const rows = (Array.isArray(listed) ? listed : ((listed as { plugins?: unknown[] })?.plugins ?? [])) as Array<{ id?: string; name?: string; displayName?: string }>;
        return rows.filter((row) => typeof row.id === "string").map((row) => ({ id: row.id!, name: row.displayName ?? row.name ?? row.id! }));
      },
      mcpServers: async () => {
        const machine = (await place(threadId))?.hostId ?? (await hostsList()).find((row) => row.connected)?.id;
        if (!machine) throw new Error("no connected machine to ask");
        return (await host.call("session_inventory", { cwd: null }, { hostId: machine })).mcpServers;
      },
      secrets: async () => await ctx.secrets.list(),
      hosts: async () => (await hostsList()).map((row) => ({ id: row.id, name: row.name, connected: row.connected })),
      browserHostId: () => {
        const runId = findOpenNativeRun(db, projectId, threadId);
        const value = configuredSetting(loadProjectSettings(db, projectId, runId ? getRunSettingsScopes(db, runId) : []), QA_HOST_KEY);
        return typeof value === "string" && value.trim() ? value.trim() : null;
      },
      specialists: async () => [...new Set([...SPECIALIST_ROLES, ...EMPLOYEE_IDS, ...Object.entries(await ctx.ownedAgents()).filter(([id, row]) => isCustomAgentId(id) && !row.compiledCorrupt).map(([id]) => id)])],
      models: async () => {
        const read = await Promise.race([catalog.get(), new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), 6_000))]);
        if (!read) return null;
        const settings = await ctx.effectiveProjectSettings(projectId).then((row) => row.values, () => ({}));
        // The helpers of a chain run on the machine of this project's chat: the pairs are judged against that machine.
        const runHostId = (await place(threadId))?.hostId ?? null;
        return { catalog: { ...read, runHostId }, settings };
      },
    }),
  };
}
