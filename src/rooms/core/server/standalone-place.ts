import type { ServerCore } from "./core";

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

export async function projectFolder(bb: ServerCore["bb"], projectId: string): Promise<ProjectFolder | null> {
  const source = (await projectSources(bb, projectId)).find((row) => row.hostId && row.path);
  return source?.hostId && source.path ? { hostId: source.hostId, path: source.path } : null;
}

/** The environment a hidden, parentless helper thread of the project starts in. */
export const folderEnvironment = (folder: ProjectFolder) => ({ type: "host" as const, hostId: folder.hostId, workspace: { type: "unmanaged" as const, path: folder.path } });

/** The title and place of a hidden thread of the project that has no parent chat (a scheduled errand's, a standalone workflow's helper). */
export const hiddenPlacement = (projectId: string, title: string, sectionId?: string | null) =>
  ({ visibility: "hidden" as const, projectId, title: title.slice(0, 120), ...(sectionId ? { sectionId } : {}) });
