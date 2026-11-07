import type { I18nKey } from "@lane-pilot/i18n";
import type { SelectionId } from "../../settings/ui/picker-selections";
import { COUNCIL_KEYS, ROLE_SPECS, type RoleSelectionId, type RoleSpec as RoleSelectionSpec } from "@lane-pilot/models";
import { WRITER_FALLBACK_SLOTS, writerFallbackKeys } from "../../writer/writer-fallbacks";

/** Which roles the table lists, in the order of the access roles (the same groups as the agent profile). */
export type RoleGroupId = "code" | "check" | "project" | "browser" | "specialists" | "workflow";

export type RoleSpec = {
  /** The access role id (`plan-critic`); the table joins the access view on it. */
  id: string;
  /** Test id of the row (the old per-tab block it replaces). */
  testId?: string;
  /** The role's model: one native picker. */
  model?: SelectionId | "writer" | "rules";
  /** The on/off column: a switch on this key, or the three-way docs mode. */
  enabled?: { key: string; fallback: boolean; label: I18nKey } | { key: "docs.enabled"; mode: true; label: I18nKey };
  /** The row opens into settings of its own besides the access. */
  detail?: "writer" | "council" | "browser";
  /** Every storage key the row covers: origin and reset read them, the coverage test counts them. */
  keys: string[];
};

/** The selection a row's access role owns, when it has one (packages/models/role-specs.ts). */
const selectionOf = (accessRole: string): RoleSelectionSpec | undefined => ROLE_SPECS.find((spec) => spec.accessRole === accessRole);
const selectionKeysOf = (accessRole: string): readonly string[] => selectionOf(accessRole)?.keys ?? [];
const selectionIdOf = (accessRole: string): RoleSelectionId | undefined => selectionOf(accessRole)?.selectionId as RoleSelectionId | undefined;

export const ROLE_GROUPS: Array<{ id: RoleGroupId; roles: RoleSpec[] }> = [
  { id: "code", roles: [
    { id: "writer", testId: "writer-picker", model: "writer", detail: "writer",
      keys: [...selectionKeysOf("writer"), "writer.agent", "jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV", ...WRITER_FALLBACK_SLOTS.flatMap((slot) => Object.values(writerFallbackKeys(slot)))] },
    { id: "code-repair", keys: [] },
    { id: "night-fixer", keys: [] },
  ] },
  { id: "check", roles: [
    { id: "plan-critic", testId: "plan-critique-settings", model: selectionIdOf("plan-critic"), enabled: { key: "plan_critique.enabled", fallback: true, label: "stagePlanCritique" }, keys: ["plan_critique.enabled", ...selectionKeysOf("plan-critic")] },
    { id: "code-critic", testId: "code-critique-settings", model: selectionIdOf("code-critic"), enabled: { key: "code_critique.enabled", fallback: false, label: "stageCodeCritique" }, keys: ["code_critique.enabled", ...selectionKeysOf("code-critic")] },
    { id: "critic-tiebreak", keys: [] },
    { id: "specialist-reviewer", testId: "specialist-settings", model: selectionIdOf("specialist-reviewer"), enabled: { key: "specialist.enabled", fallback: false, label: "specialistReview" }, keys: ["specialist.enabled", ...selectionKeysOf("specialist-reviewer")] },
    { id: "gate-triage", keys: [] },
    { id: "pm-reader", testId: "pm-read-settings", model: selectionIdOf("pm-reader"), enabled: { key: "pm_read.enabled", fallback: false, label: "largeFileRead" }, keys: ["pm_read.enabled", ...selectionKeysOf("pm-reader")] },
    { id: "council-seat", testId: "council-settings", detail: "council", enabled: { key: "council.judge", fallback: true, label: "settingCouncilJudge" },
      keys: ["council.judge", ...COUNCIL_KEYS] },
    { id: "rules-analyzer", testId: "rules-analyzer", model: "rules", keys: [] },
    { id: "episode-analyst", keys: [] },
    { id: "wall-hunter", keys: [] },
  ] },
  { id: "project", roles: [
    { id: "docs-maintainer", testId: "docs-picker", model: selectionIdOf("docs-maintainer"), enabled: { key: "docs.enabled", mode: true, label: "groupDocs" }, keys: ["docs.enabled", ...selectionKeysOf("docs-maintainer")] },
    { id: "onboarder", testId: "onboarding-picker", model: selectionIdOf("onboarder"), keys: [...selectionKeysOf("onboarder")] },
    { id: "memory-maintainer", testId: "memory-picker", model: selectionIdOf("memory-maintainer"), enabled: { key: "memory.enabled", fallback: false, label: "settingMemoryEnabled" }, keys: ["memory.enabled", ...selectionKeysOf("memory-maintainer")] },
    { id: "project-life", testId: "project-life-picker", model: selectionIdOf("project-life"), enabled: { key: "project_life.enabled", fallback: true, label: "groupProjectLife" }, keys: ["project_life.enabled", ...selectionKeysOf("project-life")] },
  ] },
  { id: "browser", roles: [
    { id: "browser-qa", testId: "browser-qa-host", detail: "browser", enabled: { key: "browser_qa.enabled", fallback: false, label: "globalQaHost" }, keys: ["browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend", "browser_qa.approve", "browser_qa.reasoning_effort"] },
    { id: "errand", keys: [] },
    { id: "api-recon", keys: [] },
  ] },
  { id: "specialists", roles: ["specialist:design-lead", "specialist:copy-lead", "specialist:seo-specialist", "specialist:tavily", "specialist:video-lead", "specialist:3d-artist", "specialist:game-dev", "specialist:social-manager", "specialist:billing-assistant", "specialist:visual-artist", "specialist:macos-operator", "specialist:lead"].map((id) => ({ id, keys: [] })) },
  { id: "workflow", roles: ["analyst", "planner", "auditor", "debugger", "workflow-architect", "lead", "workspace-provisioner", "harness-editor", "harness-composer", "harness-reflection"].map((id) => ({ id, keys: [] })) },
];

export const roleKey = (role: string) => role.replace(/[:-]/g, "_");
export const roleName = (role: string) => `accessName_${roleKey(role)}` as I18nKey;
export const rolePurpose = (role: string) => `accessPurpose_${roleKey(role)}` as I18nKey;

/** Where a role's value comes from, read off the screen payload: set here, inherited from above, or the built-in default. */
export type RoleOrigin = "here" | "inherited" | "default";
export function originOfKeys(keys: string[], explicit: readonly string[] | undefined, inherited: readonly string[] | undefined): RoleOrigin {
  if (keys.some((key) => explicit?.includes(key))) return "here";
  if (keys.some((key) => inherited?.includes(key))) return "inherited";
  return "default";
}
