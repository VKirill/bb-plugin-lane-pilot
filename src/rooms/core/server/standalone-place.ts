import type { ServerCore } from "../../contracts/server";

/**
 * Where a helper runs in a project that has no Lane Pilot PM chat: the project's own first folder on a machine, as a thread started from BB
 * would. With a PM chat the helper reuses the chat's environment instead (pmCheckout / `environment: { type: "reuse" }`).
 */
export type ProjectFolder = { hostId: string; path: string };

export async function projectSources(bb: ServerCore["bb"], projectId: string): Promise<Array<{ hostId?: string; path?: string }>> {
  try {
    const project = await bb.sdk.projects.get({ projectId }) as { sources?: Array<{ hostId?: string; path?: string }> } | null;
    return project?.sources ?? [];
  } catch {
    return [];
  }
}

/** The ids of the machines that are connected right now; null when the hub cannot say (then the first folder is as good as any). */
async function connectedHosts(bb: ServerCore["bb"]): Promise<Set<string> | null> {
  try {
    const rows = await bb.sdk.hosts.list() as ReadonlyArray<{ id?: string; status?: string }>;
    const online = new Set(rows.filter((row) => row.status === "connected" && row.id).map((row) => row.id as string));
    return online.size ? online : null;
  } catch {
    return null;
  }
}

/**
 * The project's folder a parentless helper starts in: the first one on a machine that is connected (the lead's first tick, 0.1.447,
 * picked the first folder of the list on a MacBook that was off and never started), else the first one of the list.
 */
export async function projectFolder(bb: ServerCore["bb"], projectId: string): Promise<ProjectFolder | null> {
  const folders = (await projectSources(bb, projectId)).filter((row): row is { hostId: string; path: string } => Boolean(row.hostId && row.path));
  if (!folders.length) return null;
  const online = await connectedHosts(bb);
  const source = (online && folders.find((row) => online.has(row.hostId))) ?? folders[0]!;
  return { hostId: source.hostId, path: source.path };
}

/** The environment a hidden, parentless helper thread of the project starts in. */
export const folderEnvironment = (folder: ProjectFolder) => ({ type: "host" as const, hostId: folder.hostId, workspace: { type: "unmanaged" as const, path: folder.path } });

/** The title and place of a hidden thread of the project that has no parent chat (a scheduled errand's, a standalone workflow's helper). */
export const hiddenPlacement = (projectId: string, title: string, sectionId?: string | null) =>
  ({ visibility: "hidden" as const, projectId, title: title.slice(0, 120), ...(sectionId ? { sectionId } : {}) });
