import type { I18nKey } from "@lane-pilot/i18n";
import { selectionKeys, type SelectionId } from "./picker-selections";
import { COUNCIL_SEATS } from "./page-model";
import { writerFallbackKeys } from "../writer-fallbacks";

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

const picked = (id: SelectionId) => Object.values(selectionKeys(id));

export const ROLE_GROUPS: Array<{ id: RoleGroupId; roles: RoleSpec[] }> = [
  { id: "code", roles: [
    { id: "writer", testId: "writer-picker", model: "writer", detail: "writer", keys: ["writer.provider", "writer.model", "writer.reasoning_effort", "writer.service_tier", "writer.agent", "jev.LANE_JEV_EFFORT", "jev.LANE_OPENCODE_JEV", ...[1, 2].flatMap((slot) => Object.values(writerFallbackKeys(slot as 1 | 2)))] },
    { id: "code-repair", keys: [] },
    { id: "night-fixer", keys: [] },
  ] },
  { id: "check", roles: [
    { id: "plan-critic", testId: "plan-critique-settings", model: "planCritique", enabled: { key: "plan_critique.enabled", fallback: true, label: "stagePlanCritique" }, keys: ["plan_critique.enabled", ...picked("planCritique")] },
    { id: "code-critic", testId: "code-critique-settings", model: "codeCritique", enabled: { key: "code_critique.enabled", fallback: false, label: "stageCodeCritique" }, keys: ["code_critique.enabled", ...picked("codeCritique")] },
    { id: "specialist-reviewer", testId: "specialist-settings", model: "specialist", enabled: { key: "specialist.enabled", fallback: false, label: "specialistReview" }, keys: ["specialist.enabled", ...picked("specialist")] },
    { id: "night-reviewer", testId: "night-review-settings", model: "night", enabled: { key: "night_review.enabled", fallback: false, label: "nightReviewEnabled" }, keys: ["night_review.enabled", ...picked("night")] },
    { id: "gate-triage", keys: [] },
    { id: "pm-reader", testId: "pm-read-settings", model: "pmRead", enabled: { key: "pm_read.enabled", fallback: false, label: "largeFileRead" }, keys: ["pm_read.enabled", ...picked("pmRead")] },
    { id: "council-seat", testId: "council-settings", detail: "council", enabled: { key: "council.judge", fallback: true, label: "settingCouncilJudge" },
      keys: ["council.judge", ...COUNCIL_SEATS.flatMap((seat) => [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`])] },
    { id: "rules-analyzer", testId: "rules-analyzer", model: "rules", keys: [] },
  ] },
  { id: "project", roles: [
    { id: "docs-maintainer", testId: "docs-picker", model: "docs", enabled: { key: "docs.enabled", mode: true, label: "groupDocs" }, keys: ["docs.enabled", ...picked("docs")] },
    { id: "onboarder", testId: "onboarding-picker", model: "onboarding", keys: picked("onboarding") },
    { id: "memory-maintainer", testId: "memory-picker", model: "memory", enabled: { key: "memory.enabled", fallback: false, label: "settingMemoryEnabled" }, keys: ["memory.enabled", ...picked("memory")] },
    { id: "project-life", testId: "project-life-picker", model: "projectLife", enabled: { key: "project_life.enabled", fallback: true, label: "groupProjectLife" }, keys: ["project_life.enabled", ...picked("projectLife")] },
  ] },
  { id: "browser", roles: [
    { id: "browser-qa", testId: "browser-qa-host", detail: "browser", enabled: { key: "browser_qa.enabled", fallback: false, label: "globalQaHost" }, keys: ["browser_qa.enabled", "browser_qa.provider", "browser_qa.model", "browser_qa.backend", "browser_qa.approve", "browser_qa.reasoning_effort"] },
    { id: "errand", keys: [] },
  ] },
  { id: "specialists", roles: ["specialist:design-lead", "specialist:copy-lead", "specialist:seo-specialist", "specialist:tavily"].map((id) => ({ id, keys: [] })) },
  { id: "workflow", roles: ["analyst", "planner", "auditor", "debugger"].map((id) => ({ id, keys: [] })) },
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
