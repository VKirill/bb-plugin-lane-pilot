/**
 * M7: sections of a project-umbrella are developments of their own. `project` entries in a scope mark a record
 * project-wide on purpose ("project" or "project:<reason>", e.g. "project:hub-infra"); in a standalone project
 * an empty scope still means the whole project, in an umbrella it is unassigned and waits for a section.
 */
export type ProjectKind = "standalone" | "umbrella";

/** Whether the project-umbrella rule applies: the setting wins, otherwise a project that uses section chains is one. */
export function resolveProjectKind(configured: "auto" | ProjectKind | undefined, usesSections: boolean): ProjectKind {
  if (configured === "standalone" || configured === "umbrella") return configured;
  return usesSections ? "umbrella" : "standalone";
}

const SHARED = /^project(:.*)?$/;
/** `["project"]` / `["project:hub-infra"]` — every section of the project reads this. */
export const isSharedScope = (scope: readonly string[]): boolean => scope.some((entry) => SHARED.test(entry));
/** The scope a deliberately project-wide record stores; the reason travels inside the marker. */
export const sharedScope = (reason?: string): string[] => [reason ? `project:${reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shared"}` : "project"];
