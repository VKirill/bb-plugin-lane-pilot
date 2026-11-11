/**
 * The project's second address (SMA m_pj_register, m_pj_planning, d_project_planning): `project.planning_home` names an
 * absolute folder on the project's host under which `.agents/phases`, `.agents/planning` and `.agents/todos` live instead of
 * the checkout's own `.agents`. Unset (or invalid) reads as the checkout — today's behaviour on every install that sets nothing.
 */
export const PLANNING_HOME_SETTING = "project.planning_home";

/** The setting's value as a usable absolute path, or null. An invalid value (not absolute, `..`, backslash) is no home. */
export function planningHomeOf(settings: Record<string, unknown> | null | undefined): string | null {
  const raw = settings?.[PLANNING_HOME_SETTING];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const home = raw.trim().replace(/\/+$/, "");
  if (!home.startsWith("/") || home.includes("\0") || home.includes("\\") || home.split("/").includes("..")) return null;
  return home;
}

/** The root the `.agents/*` planning files are read and written under: the planning home when set, else the run's checkout. */
export function planningRoot(run: { writer_workspace_path?: string | null } | null | undefined, settings: Record<string, unknown> | null | undefined): string | null {
  return planningHomeOf(settings) ?? run?.writer_workspace_path ?? null;
}
