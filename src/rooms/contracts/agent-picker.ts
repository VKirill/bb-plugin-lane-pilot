export type AgentKind = "coordinator" | "specialist" | "internal";

/** The action id of the helper-threads panel row the UI posts back (native-agent/ui/helper-threads.tsx). */
export const HELPER_PANEL_ACTION = "lane-helper-thread";

export type AgentListItem = {
  id: string;
  /** The label pickers show (for a bundled agent, English; the screens translate it by id). Same value as `displayName`. */
  description: string;
  displayName: string;
  /** What the agent is for, when its owner wrote it. */
  summary?: string;
  kind: AgentKind;
  custom: boolean;
  prompt: string;
  sourceHash: string;
  sourceVersion: string;
  edited: boolean;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  mcpServers?: string[];
  model?: string;
  effort?: string;
  domain?: string;
  machineAffinity?: string;
  coreSkills?: string[];
  skillSections?: string[];
  deliverables?: string[];
  validator?: string;
};

/** The part of a list item a picker needs (the composer popover, the PM's team tab): no prompt, no resources. */
export function pickableAgent(row: AgentListItem): Pick<AgentListItem, "id" | "description" | "displayName" | "summary" | "kind" | "custom" | "domain"> {
  return { id: row.id, description: row.description, displayName: row.displayName, ...(row.summary ? { summary: row.summary } : {}), kind: row.kind, custom: row.custom, ...(row.domain ? { domain: row.domain } : {}) };
}
