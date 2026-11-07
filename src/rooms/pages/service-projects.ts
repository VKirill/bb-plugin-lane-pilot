import { DRILL_SANDBOX_PROJECT_IDS, isSandboxProjectName, type ListedProject } from "../contracts/project-scope";

const DRILL_IDS = new Set<string>(DRILL_SANDBOX_PROJECT_IDS);

/** The owner's own «hide project» choices live in this browser (the hub keeps no per-device list). */
export const HIDDEN_PROJECTS_KEY = "lane-pilot:hidden-projects";

export function isTestProject(project: ListedProject): boolean {
  return DRILL_IDS.has(project.id) || isSandboxProjectName(project.name);
}

export function readHiddenProjects(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(HIDDEN_PROJECTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function writeHiddenProjects(ids: string[]): void {
  try { globalThis.localStorage?.setItem(HIDDEN_PROJECTS_KEY, JSON.stringify([...new Set(ids)])); } catch { /* private mode: the choice lasts until the page closes */ }
}

/** Working projects first; test projects and the ones the owner hid go under «Service». */
export function splitProjects<P extends ListedProject>(projects: P[], hidden: ReadonlySet<string>): { main: P[]; service: P[] } {
  const main: P[] = [];
  const service: P[] = [];
  for (const project of projects) (isTestProject(project) || hidden.has(project.id) ? service : main).push(project);
  return { main, service };
}
