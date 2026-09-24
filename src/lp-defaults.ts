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

export function inheritProjectValues(
  project: Record<string, unknown>,
  defaults: LanePilotDefaults,
): { values: Record<string, unknown>; inherited: string[] } {
  const values = { ...project };
  const inherited: string[] = [];
  const apply = (key: string, next: unknown) => {
    if (values[key] !== undefined && values[key] !== null && values[key] !== "") return;
    if (next === undefined || next === "") return;
    values[key] = next;
    inherited.push(key);
  };
  apply("writer.provider", defaults.writerProviderId);
  apply("writer.model", defaults.writerModel);
  apply("writer.reasoning_effort", defaults.writerReasoningEffort);
  apply("helper.placement", defaults.helperPlacement ?? "plugin");
  apply("browser_qa.host_id", defaults.qaHostId);
  if (values["helper.placement"] === undefined) {
    values["helper.placement"] = "plugin";
    inherited.push("helper.placement");
  }
  return { values, inherited };
}

export function parseHelperPlacement(raw: unknown): HelperPlacementMode {
  return raw === "project_tree" ? "project_tree" : "plugin";
}
