/**
 * Which tab shows a catalog row that no fixed block names. The fixed blocks (the team table, the policy groups of «Work», memory
 * and docs in «Knowledge», diagnostics in «Runs») list their own keys; whatever else the catalog makes editable lands here, so a
 * new setting is never lost: it shows up under «Work» unless it belongs to a role or to the workflows.
 */
export type SettingTab = "team" | "work" | "knowledge" | "automation" | "runs";

export function extraSettingTab(storageKey: string): SettingTab {
  if (storageKey === "council.judge" || storageKey.startsWith("browser_qa.")) return "team";
  if (storageKey.startsWith("workflow.")) return "automation";
  return "work";
}
