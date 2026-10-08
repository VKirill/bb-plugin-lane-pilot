/**
 * The PM's tool list is folded: a compiled Claude Code agent profile holds at most 64 tools and the PM had 39 Lane Pilot tools
 * next to 24 stock ones. The tools the PM uses in every turn stay as they are; the rest are actions of a few family tools
 * (`lane_pilot_relay` with `action: "remind"`) that run the old handlers unchanged. `lane_pilot_tool_search` finds a capability by
 * words (or by an old tool name) and returns its family, action and argument schema. The old tools stay registered for the roles that
 * still name them (the Workflow architect); only the PM's allow-list (native-session-hooks.ts) stops listing them.
 */
export const LANE_PILOT_TOOL_SEARCH_NAME = "lane_pilot_tool_search";

export type ToolFamily = {
  /** One line for the tool description: what the family is for. */
  summary: string;
  /** action -> the registered tool whose handler and argument schema the action uses */
  actions: Readonly<Record<string, string>>;
};

export const PM_TOOL_FAMILIES = {
  lane_pilot_helpers: {
    summary: "Helpers outside the writer lane: a specialist thread (design-lead, copy-lead, seo-specialist, tavily), one step in the owner's Chrome, a browser check of an accepted task.",
    actions: { specialist: "lane_pilot_specialist", wait_specialist: "lane_pilot_wait_specialist", browser: "lane_pilot_browser", browser_qa: "lane_pilot_browser_qa" },
  },
  lane_pilot_council: {
    summary: "Council of directors: role-bound seats on different models argue a product or business question; the chair writes a decision.",
    actions: { start: "lane_pilot_council_start", status: "lane_pilot_council_status", say: "lane_pilot_council_say", stop: "lane_pilot_council_stop" },
  },
  lane_pilot_relay: {
    summary: "Other threads and time: ask another thread, answer a question you were asked, set or list reminders.",
    actions: { ask: "lane_pilot_ask", reply: "lane_pilot_reply", remind: "lane_pilot_remind", list: "lane_pilot_relay_list" },
  },
  lane_pilot_memory: {
    summary: "Project memory and learning: search memory, routing statistics, repeated lessons, rule proposals, recording a lesson.",
    actions: { context: "lane_pilot_memory_context", routing_stats: "lane_pilot_routing_stats", lessons_sweep: "lane_pilot_lessons_sweep", rule_propose: "lane_pilot_rule_propose", lesson: "lane_pilot_lesson" },
  },
  lane_pilot_workflow_draft: {
    summary: "Workflow drafts (repeatable chains): what a chain can use, create, patch, read, test on stubs, publish.",
    actions: {
      capabilities: "lane_pilot_workflow_capabilities", create: "lane_pilot_workflow_draft_create", patch: "lane_pilot_workflow_draft_patch",
      get: "lane_pilot_workflow_draft_get", test: "lane_pilot_workflow_draft_test", publish: "lane_pilot_workflow_draft_publish",
    },
  },
} as const satisfies Record<string, ToolFamily>;

export type PmToolFamilyName = keyof typeof PM_TOOL_FAMILIES;

/** Tools the PM keeps by name: used in nearly every turn, or too weighty to hide behind an action. */
export const PM_CORE_TOOLS = [
  "lane_pilot_read",
  "lane_pilot_dispatch_writer",
  "lane_pilot_wait_writer",
  "lane_pilot_answer_writer",
  "lane_pilot_cancel_task",
  "lane_pilot_update_task",
  "lane_pilot_workspace_status",
  "lane_pilot_run_health",
  "lane_pilot_ask_owner",
  "lane_pilot_errand",
  "lane_pilot_wait_errand",
  "lane_pilot_route",
  "lane_pilot_run_workflow",
  "lane_pilot_workflow_status",
  "lane_pilot_workflow_amend",
] as const;

/** Families that were a tool of their own before (lane_pilot_schedule is one tool with actions from the start). */
export const PM_FAMILY_TOOLS = [...Object.keys(PM_TOOL_FAMILIES), "lane_pilot_schedule"] as string[];

/** Where an old tool name lives now: `{ tool: "lane_pilot_relay", action: "remind" }`; undefined for a tool that kept its name. */
export function foldedToolHome(oldName: string): { tool: string; action: string } | undefined {
  for (const [tool, family] of Object.entries(PM_TOOL_FAMILIES) as Array<[string, ToolFamily]>) {
    for (const [action, name] of Object.entries(family.actions)) if (name === oldName) return { tool, action };
  }
  return undefined;
}

/** How the PM is told to call a folded tool, for descriptions and hints: `lane_pilot_relay {action:"remind"}`. */
export function foldedToolCall(oldName: string): string | undefined {
  const home = foldedToolHome(oldName);
  return home ? `${home.tool} {action:"${home.action}"}` : undefined;
}

const OLD_NAME = /\blane_pilot_workflow_draft_\*|\blane_pilot_[a-z_]*[a-z]\b/g;

/** Old tool names in a text written for the old list, rewritten to how the folded tools are called. Unknown names stay. */
export function rewriteFoldedToolNames(text: string): string {
  return text.replace(OLD_NAME, (name) => (name === "lane_pilot_workflow_draft_*" ? "lane_pilot_workflow_draft" : foldedToolCall(name) ?? name));
}
