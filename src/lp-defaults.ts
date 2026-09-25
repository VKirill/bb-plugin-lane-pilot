export const LP_DEFAULTS_KEY = "defaults:v1";
export const LP_AGENT_OVERRIDES_KEY = "agents:v1";

export const HELPER_PLACEMENT_MODES = ["plugin", "project_tree"] as const;
export type HelperPlacementMode = (typeof HELPER_PLACEMENT_MODES)[number];

export type LanePilotDefaults = {
  writerProviderId?: string;
  writerModel?: string;
  writerReasoningEffort?: string;
  helperPlacement?: HelperPlacementMode;
  qaHostId?: string;
};

export const EMPTY_DEFAULTS: LanePilotDefaults = {};

export function parseLanePilotDefaults(raw: unknown): LanePilotDefaults {
  if (!raw || typeof raw !== "object") return {};
  const row = raw as Record<string, unknown>;
  const helper = row.helperPlacement;
  return {
    ...(typeof row.writerProviderId === "string" && row.writerProviderId ? { writerProviderId: row.writerProviderId } : {}),
    ...(typeof row.writerModel === "string" && row.writerModel ? { writerModel: row.writerModel } : {}),
    ...(typeof row.writerReasoningEffort === "string" && row.writerReasoningEffort ? { writerReasoningEffort: row.writerReasoningEffort } : {}),
    ...(helper === "plugin" || helper === "project_tree" ? { helperPlacement: helper } : {}),
    ...(typeof row.qaHostId === "string" && row.qaHostId ? { qaHostId: row.qaHostId } : {}),
  };
}

export function parseDefaultsRevision(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const revision = (raw as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export function packStoredDefaults(defaults: LanePilotDefaults, revision: number): LanePilotDefaults & { revision: number } {
  return { ...defaults, revision };
}

export function inheritProjectValues(
  project: Record<string, unknown>,
  defaults: LanePilotDefaults,
): { values: Record<string, unknown>; inherited: string[]; explicitKeys: string[] } {
  const explicitKeys = Object.keys(project);
  const values = { ...project };
  const inherited: string[] = [];
  const apply = (key: string, next: unknown) => {
    if (Object.prototype.hasOwnProperty.call(project, key)) return;
    if (next === undefined || next === "") return;
    values[key] = next;
    inherited.push(key);
  };
  apply("writer.provider", defaults.writerProviderId);
  apply("writer.model", defaults.writerModel);
  apply("writer.reasoning_effort", defaults.writerReasoningEffort);
  const hasWriterSelection = [
    project["writer.provider"], project["writer.model"],
    project.writerProviderId, project.writerModel,
    defaults.writerProviderId, defaults.writerModel,
  ].some((value) => typeof value === "string" && value.length > 0);
  if (!hasWriterSelection) {
    apply("writer.provider", "codex");
    apply("writer.model", "gpt-6-luna");
    if (values["writer.reasoning_effort"] === undefined) apply("writer.reasoning_effort", "high");
    apply("writer.service_tier", "fast");
    apply("jev.LANE_JEV_EFFORT", false);
  }
  apply("helper.placement", defaults.helperPlacement ?? "plugin");
  apply("browser_qa.host_id", defaults.qaHostId);
  if (!Object.prototype.hasOwnProperty.call(project, "helper.placement") && values["helper.placement"] === undefined) {
    values["helper.placement"] = "plugin";
    inherited.push("helper.placement");
  }
  return { values, inherited, explicitKeys };
}

export function parseHelperPlacement(raw: unknown): HelperPlacementMode {
  return raw === "project_tree" ? "project_tree" : "plugin";
}
