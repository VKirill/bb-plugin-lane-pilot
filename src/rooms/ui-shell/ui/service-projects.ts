import type { ListedProject } from "../../native-agent";

/** Test and sandbox projects of Lane Pilot's own checks: kept out of the way in the project list. */
const SANDBOX_PROJECT_IDS = new Set(["proj_3tb652jpsi"]);
const SERVICE_NAME = /^LP\s+(sandbox|native|test)/i;

/** The owner's own «hide project» choices live in this browser (the hub keeps no per-device list). */
export const HIDDEN_PROJECTS_KEY = "lane-pilot:hidden-projects";

export function isTestProject(project: ListedProject): boolean {
  return SANDBOX_PROJECT_IDS.has(project.id) || SERVICE_NAME.test(project.name);
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
