export const PERSONAL_PROJECT_KIND = "personal" as const;
export const STANDARD_PROJECT_KIND = "standard" as const;
export const PERSONAL_PROJECT_ID = "proj_personal";

export type ListedProject = { id: string; name: string; kind?: string };

/**
 * Sandbox and drill traffic is not the product's: the drill's sandbox projects, every project named «LP sandbox …», «LP native …»
 * or «LP bench …» (src/rooms/bench replays a fixed task set on purpose) and the drill's tasks (`drill-*`) fail on purpose and are
 * left out of the canary, the wall, the live rate, the owner list and the sidebar's working projects. The one rule; every caller derives.
 */
export const SANDBOX_PROJECT_ID = "proj_3tb652jpsi";
/** Every drill sandbox: the Mac mini's and, since 2026-10-28, OVH's («LP sandbox OVH (drill)», where deploys from OVH run the drill). */
export const DRILL_SANDBOX_PROJECT_IDS: readonly string[] = [SANDBOX_PROJECT_ID, "proj_ibu6v9g64j"];
export const SANDBOX_PROJECT_NAME_PREFIXES = ["LP sandbox", "LP native", "LP bench"] as const;
export const isSandboxProjectName = (name: string | null | undefined): boolean =>
  typeof name === "string" && SANDBOX_PROJECT_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
export const isDrillTask = (taskId: string): boolean => taskId.startsWith("drill-");

/** Service/projectless container. Never match by display name. */
export function isServicePersonalProject(project: ListedProject): boolean {
  return project.kind === PERSONAL_PROJECT_KIND || project.id === PERSONAL_PROJECT_ID;
}

export function userVisibleProjects(projects: ListedProject[]): ListedProject[] {
  return projects.filter((project) => !isServicePersonalProject(project));
}
