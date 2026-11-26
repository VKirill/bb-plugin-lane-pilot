export const BB_BRIDGE_MCP_SERVER = "bb-bridge";

export const NATIVE_LP_BRIDGE_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_cancel_task",
  "lane_pilot_update_task",
  "lane_pilot_wait_writer",
  "lane_pilot_answer_writer",
  "lane_pilot_ask_owner",
  "lane_pilot_browser_qa",
  "lane_pilot_ingest_opencode_telemetry",
  "lane_pilot_memory_context",
  "lane_pilot_workspace_status",
  "lane_pilot_gate_report",
  "lane_pilot_handoff_create",
  "lane_pilot_handoff_receipt",
  "lane_pilot_handoff_list",
  "lane_pilot_run_health",
  "lane_pilot_specialist",
  "lane_pilot_wait_specialist",
  "lane_pilot_scout",
  "lane_pilot_wait_scout",
  "lane_pilot_browser",
  "lane_pilot_errand",
  "lane_pilot_wait_errand",
  "lane_pilot_ask",
  "lane_pilot_reply",
  "lane_pilot_relay_list",
  "lane_pilot_workflow_draft_create",
  "lane_pilot_workflow_draft_patch",
  "lane_pilot_workflow_draft_get",
  "lane_pilot_workflow_capabilities",
  "lane_pilot_workflow_draft_test",
  "lane_pilot_workflow_draft_publish",
  "lane_pilot_route",
  "lane_pilot_run_workflow",
  "lane_pilot_workflow_status",
  "lane_pilot_workflow_amend",
  "lane_pilot_schedule",
  "lane_pilot_queue",
  "lane_pilot_facts",
  "lane_pilot_check",
  "lane_pilot_permit",
  "lane_pilot_helpers",
  "lane_pilot_relay",
  "lane_pilot_memory",
  "lane_pilot_workflow_draft",
  "lane_pilot_tool_search",
] as const;

/**
 * The PM's list is folded (src/pm-tool-families.ts): a compiled Claude Code profile holds at most 64 tools. The core tools keep their
 * names; the rest are actions of five family tools, plus lane_pilot_schedule and the search that finds a capability by words.
 */
export const NATIVE_LP_BRIDGE_PM_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_propose",
  "lane_pilot_wait_writer",
  "lane_pilot_answer_writer",
  "lane_pilot_cancel_task",
  "lane_pilot_update_task",
  "lane_pilot_reassign_task",
  "lane_pilot_workspace_status",
  "lane_pilot_run_health",
  "lane_pilot_ask_owner",
  "lane_pilot_errand",
  "lane_pilot_wait_errand",
  "lane_pilot_route",
  "lane_pilot_run_workflow",
  "lane_pilot_workflow_status",
  "lane_pilot_workflow_amend",
  "lane_pilot_helpers",
  "lane_pilot_relay",
  "lane_pilot_memory",
  "lane_pilot_workflow_draft",
  "lane_pilot_schedule",
  "lane_pilot_queue",
  "lane_pilot_facts",
  "lane_pilot_check",
  "lane_pilot_permit",
  "lane_pilot_tool_search",
] as const;

/** The one bridge tool a specialist gets: the schedule, so the owner can ask «every Monday collect…» in the specialist's own chat. */
export const NATIVE_LP_BRIDGE_SPECIALIST_TOOLS = ["lane_pilot_schedule"] as const;

/** The tools of the lead («Штурман», src/rooms/lead/lead-agent.ts): reading and its own tool; it never dispatches, schedules, spends or sends. */
export const NATIVE_LP_BRIDGE_LEAD_TOOLS = ["lane_pilot_read", "lane_pilot_lead", "lane_pilot_tool_search"] as const;

/** The tools of the Workflow architect: it builds chains, it does not dispatch writers. */
export const NATIVE_LP_BRIDGE_ARCHITECT_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_ask_owner",
  // The families the old per-action names were folded into (src/rooms/platform/server/pm-tool-families.ts): with the old names the architect had
  // only read and ask_owner and could build nothing (live architect order thr_ucanjpsgn5, 2026-10-25). Its session text is rewritten
  // to the family calls the same way as the PM's.
  "lane_pilot_workflow_draft",
  "lane_pilot_relay",
  "lane_pilot_tool_search",
] as const;

/** The PreToolUse matcher of the subagent tool under both of its names. */
export const SUBAGENT_MATCHER = "Task|Agent";

export function lpBridgeCatalogNames(tools: readonly string[] = NATIVE_LP_BRIDGE_TOOLS): string[] {
  return tools.map((name) => `mcp__${BB_BRIDGE_MCP_SERVER}__${name}`);
}

export function withoutLpBridgeTools(tools: readonly string[]): string[] {
  const prefix = `mcp__${BB_BRIDGE_MCP_SERVER}__`;
  return tools.filter((tool) => !tool.startsWith(prefix));
}

export function unionLpBridgeTools(
  tools: readonly string[],
  catalog: readonly string[] = NATIVE_LP_BRIDGE_PM_TOOLS,
): string[] {
  const extra = lpBridgeCatalogNames(catalog);
  const seen = new Set(tools);
  const next = [...tools];
  for (const name of extra) {
    if (seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}
