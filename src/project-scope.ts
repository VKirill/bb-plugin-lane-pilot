export const PERSONAL_PROJECT_KIND = "personal" as const;
export const STANDARD_PROJECT_KIND = "standard" as const;
export const PERSONAL_PROJECT_ID = "proj_personal";

export type ListedProject = { id: string; name: string; kind?: string };

/** Service/projectless container. Never match by display name. */
export function isServicePersonalProject(project: ListedProject): boolean {
  return project.kind === PERSONAL_PROJECT_KIND || project.id === PERSONAL_PROJECT_ID;
}

export function userVisibleProjects(projects: ListedProject[]): ListedProject[] {
  return projects.filter((project) => !isServicePersonalProject(project));
}
