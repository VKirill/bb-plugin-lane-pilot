import type { I18nKey } from "@lane-pilot/i18n";
import { isScoutSeat, ROLE_IDS, roleRowOf } from "@lane-pilot/models";
import type { LoadoutRole } from "../../contracts";
import { ROLE_GROUPS, type RoleSpec } from "../../native-agent/ui";

export type LoadoutFilter = "all" | "pipeline" | "specialist" | "pm" | "custom";
export type ScopeLevel = "system" | "project" | "section";

export type TableRoleRow = {
  role: string;
  providerId: string;
  model: string;
  effort: string;
  source: "table" | "stage" | "default";
  sourceKey: string | null;
  own: boolean;
  version: number;
  defaultModel: string;
  defaultEffort: string;
  offered: boolean | null;
  pool: ReadonlyArray<{ providerId: string; model: string; effort: string | null }>;
};

export const TABLE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export const AS_WRITER = new Set(["code-repair", "night-fixer"]);

export const SPEC_BY_ROLE = new Map<string, RoleSpec>(
  ROLE_GROUPS.flatMap((group) => group.roles.map((spec) => [spec.id, spec] as const)),
);

export const FILTER_LABELS: Record<LoadoutFilter, I18nKey> = {
  all: "consoleLoadoutFilterAll",
  pipeline: "consoleLoadoutFilterPipeline",
  specialist: "consoleLoadoutFilterSpecialist",
  pm: "consoleLoadoutFilterPm",
  custom: "consoleLoadoutFilterCustom",
};

export function accessRoleOf(entry: LoadoutRole): string {
  if (isScoutSeat(entry.role)) return "scout";
  if ((entry.kind === "specialist" || entry.kind === "custom") && !entry.role.startsWith("specialist:")) {
    return `specialist:${entry.role}`;
  }
  return entry.role;
}

export function tableRoleIdOf(entry: LoadoutRole, tableRoles: ReadonlyMap<string, TableRoleRow> | null): string | null {
  if (entry.role === "writer" || entry.role === "code-repair" || entry.role === "night-fixer") return null;
  if (entry.role === "onboarder" || entry.role === "workspace-provisioner" || entry.kind === "pm") return null;
  if (tableRoles?.has(entry.role)) return entry.role;
  if (ROLE_IDS.includes(entry.role)) return entry.role;
  if (entry.kind === "custom") return entry.role;
  const resolved = roleRowOf(entry.role);
  if (entry.role === "memory-maintainer" || entry.role === "gate-triage" || resolved === entry.role) return resolved;
  return null;
}

export function fallbackRolesFromGroups(contextMode: LoadoutRole["contextMode"] = "roles"): LoadoutRole[] {
  return ROLE_GROUPS.flatMap((group) =>
    group.roles.map((spec): LoadoutRole => ({
      role: spec.id.startsWith("specialist:") ? spec.id.slice("specialist:".length) : spec.id,
      kind: group.id === "specialists" ? "specialist" : "pipeline",
      model: { provider: null, model: null, from: "builtin" },
      items: [],
      contextMode,
      machine: null,
      note: null,
    })),
  );
}
