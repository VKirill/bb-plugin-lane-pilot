import { resolve } from "node:path";
import type { ScheduleTask } from "../model";
import type { WhereView } from "../views";
import type { ServerCore } from "../../core/server/core";
import type { Services } from "../../core/server/services";
import { stringAt } from "../../core/server/values";

/**
 * Where scheduled work runs, read from BB: the project's name, the Project Folders section the project's PM chat is filed in (the thread's
 * own `sectionId`; else the deepest folder whose path holds the chat's environment), the machine and folder of that environment. A script
 * names its own machine and folder; an errand and a chain use the PM chat's (the helper thread reuses its environment).
 */
export type ProjectPlace = {
  projectName: string | null; sectionId: string | null; sectionName: string | null; sectionPath: string | null;
  /** The folder the PM chat works in (its environment's path, else the project's first source): where an errand's helper runs. */
  folderPath: string | null; hostId: string | null;
};
export const EMPTY_PLACE: ProjectPlace = { projectName: null, sectionId: null, sectionName: null, sectionPath: null, folderPath: null, hostId: null };

const within = (path: string, folder: string) => { const target = resolve(path), base = resolve(folder); return target === base || target.startsWith(`${base}/`); };

async function placeOf(ctx: ServerCore, services: Services, projectId: string): Promise<ProjectPlace> {
  const { bb } = ctx;
  const project = await bb.sdk.projects.get({ projectId }).catch(() => null) as { name?: unknown; sources?: Array<{ hostId?: string; path?: string }> } | null;
  const pm = services.workflowTriggers.pmOf(projectId);
  const thread = pm ? await bb.sdk.threads.get({ threadId: pm.pmThreadId }).catch(() => null) : null;
  const environmentId = stringAt(thread, "environmentId");
  const environment = environmentId ? await bb.sdk.environments.get({ environmentId }).catch(() => null) : null;
  const folderPath = stringAt(environment, "path") ?? project?.sources?.[0]?.path ?? null;
  const hostId = stringAt(environment, "hostId") ?? project?.sources?.[0]?.hostId ?? null;
  const sections = await ctx.listProjectSections(projectId).catch(() => []);
  const own = stringAt(thread, "sectionId");
  const section = (own ? sections.find((row) => row.id === own) : undefined)
    ?? (folderPath ? sections.filter((row) => row.kind === "folder" && row.path && within(folderPath, row.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined);
  return {
    projectName: typeof project?.name === "string" && project.name ? project.name : null,
    sectionId: section?.id ?? null, sectionName: section?.name ?? null, sectionPath: section?.path || null, folderPath, hostId,
  };
}

/** The places of the given projects, read once each. */
export async function projectPlaces(ctx: ServerCore, services: Services, projectIds: readonly string[]): Promise<Map<string, ProjectPlace>> {
  const ids = [...new Set(projectIds)];
  return new Map(await Promise.all(ids.map(async (id) => [id, await placeOf(ctx, services, id).catch(() => EMPTY_PLACE)] as const)));
}

/** The `where` of a schedule: a script's own machine and folder, else the PM chat's; the folder of a chain is the project's. */
export function whereOf(task: ScheduleTask, place: ProjectPlace | undefined, hostName: (id: string) => string | null): WhereView {
  const p = place ?? EMPTY_PLACE;
  const hostId = task.kind === "script" ? task.hostId : p.hostId;
  return {
    projectName: p.projectName, sectionId: p.sectionId, sectionName: p.sectionName, sectionPath: p.sectionPath,
    hostId, hostName: hostId ? hostName(hostId) : null, cwd: task.kind === "script" ? task.cwd : p.folderPath,
  };
}

/** The machine a thread runs on (its environment's host), remembered: a thread never moves. */
export function createThreadHosts(ctx: ServerCore) {
  const known = new Map<string, string>();
  return async (threadId: string): Promise<string | null> => {
    const cached = known.get(threadId);
    if (cached) return cached;
    const thread = await ctx.bb.sdk.threads.get({ threadId }).catch(() => null);
    const environmentId = stringAt(thread, "environmentId");
    const environment = environmentId ? await ctx.bb.sdk.environments.get({ environmentId }).catch(() => null) : null;
    const hostId = stringAt(environment, "hostId");
    if (hostId) known.set(threadId, hostId);
    return hostId;
  };
}
