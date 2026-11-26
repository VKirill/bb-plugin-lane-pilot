import { LEAD_ID } from "../../contracts";
import { isLanePmAgent, nativeAgentName, WORKFLOW_ARCHITECT_ID } from "../../contracts/server";
import {
  BB_BRIDGE_MCP_SERVER,
  NATIVE_LP_BRIDGE_ARCHITECT_TOOLS,
  NATIVE_LP_BRIDGE_LEAD_TOOLS,
  NATIVE_LP_BRIDGE_PM_TOOLS,
  NATIVE_LP_BRIDGE_SPECIALIST_TOOLS,
  unionLpBridgeTools,
  withoutLpBridgeTools,
} from "./bridge-tools";
import { allowDirectoryMove } from "./native-directory-policy";

/** Official `--agents` JSON fields from https://code.claude.com/docs/en/sub-agents */
export const AGENTS_JSON_FIELDS = [
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "initialPrompt",
  "memory",
  "effort",
  "background",
  "omitClaudeMd",
  "isolation",
] as const;

/** Plugin loader ignores these; `--agents` would activate them. */
export const PLUGIN_IGNORED_FIELDS = [
  "hooks",
  "mcpServers",
  "permissionMode",
  "initialPrompt",
] as const;

/** BB session owns model/effort/full-access; do not copy from the agent file. */
export const BB_SESSION_OWNED_FIELDS = ["model", "effort"] as const;

export const AGENTS_JSON_FIELD_SET = new Set<string>(AGENTS_JSON_FIELDS);
export const PLUGIN_IGNORED_SET = new Set<string>(PLUGIN_IGNORED_FIELDS);
export const BB_SESSION_OWNED_SET = new Set<string>(BB_SESSION_OWNED_FIELDS);
export const DROPPED_IDENTITY_FIELDS = new Set(["name", "color", "experimental"]);
const CLI_SESSION_TOOLS = new Set(["SendMessage", "ListAgents", "TaskStop"]);

/**
 * Claude Code defers MCP tool schemas (names only at start, the schema when the model asks) only when the session has
 * the ToolSearch tool. An agent whose `tools` list names tools one by one lacks it, so every MCP schema was sent up front
 * (Opus PMs: 36.6k tokens at the start, 15k of them MCP). The PM list adds it.
 */
export const DEFERRED_MCP_LOADER = "ToolSearch";
/**
 * The whole BB bridge for the PM: the other BB plugins' tools (Image Studio, File Gateway, Env Catalog…) for a one-off call. In a PM thread
 * the bridge carries only the PM's own Lane Pilot tools (tools.ts), so the server entry adds no writer or architect tool.
 */
export const PM_BRIDGE_SERVER_ENTRY = `mcp__${BB_BRIDGE_MCP_SERVER}`;
/** Bridge tools the PM never calls: moving the chat to another folder breaks the run's binding; a BB workflow starts agents outside Lane Pilot. */
export const PM_DISALLOWED_BRIDGE_TOOLS = ["update_environment_directory", "bb_workflow_run"].map((name) => `mcp__${BB_BRIDGE_MCP_SERVER}__${name}`);

/** The PM's disallowed tools with the bridge tools it never calls; other agents keep theirs. */
export function overlayDisallowedTools(agentId: string, disallowed: readonly string[] | undefined): string[] | undefined {
  if (!isLanePmAgent(agentId)) return disallowed ? [...disallowed] : undefined;
  return [...new Set([...(disallowed ?? []), ...PM_DISALLOWED_BRIDGE_TOOLS])];
}

export function splitClaudeToolList(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const item = current.trim();
      if (item) out.push(item);
      current = "";
      continue;
    }
    current += ch;
  }
  const item = current.trim();
  if (item) out.push(item);
  return out;
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (
    (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseAgentMarkdown(text: string): { frontmatter: Record<string, unknown>; prompt: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("native_agent_frontmatter_missing");
  const frontmatter: Record<string, unknown> = {};
  const lines = match[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1]!;
    const rest = keyMatch[2]!;
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i] === "" || /^\s+/.test(lines[i]!))) {
        block.push(lines[i]!.replace(/^  /, ""));
        i += 1;
      }
      i -= 1;
      frontmatter[key] = block.join("\n").replace(/\n$/, "");
      continue;
    }
    if (rest === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j]!)) {
        items.push(lines[j]!.replace(/^\s+-\s+/, "").trim());
        j += 1;
      }
      if (items.length) {
        frontmatter[key] = items;
        i = j - 1;
        continue;
      }
    }
    frontmatter[key] = parseScalar(rest);
  }
  return { frontmatter, prompt: match[2]! };
}

export function normalizeToolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? splitClaudeToolList(value)
      : [];
  return items;
}

/**
 * A Lane PM delegates code only to Lane writers. A general-purpose subagent would write product code
 * in the PM's own checkout, past plan critique, the writer model and worktrees. Onboard/docs/night
 * are Lane Pilot background stages, not Agent() one-shots, so a PM keeps read-only Explore/Plan only.
 * The Lane specialists run as child BB threads through lane_pilot_helpers (action specialist), so the owner can open them;
 * as Agent() subagents BB showed only «a background agent is running».
 */
const BB_PM_STRIPPED_SUBAGENTS = new Set([
  "general-purpose",
  "run-supervisor", "lane-stack:run-supervisor",
  "lane-supervisor", "lane-stack:lane-supervisor",
  "emergency-writer", "lane-stack:emergency-writer",
  "project-onboarder", "lane-stack:project-onboarder",
  "docs-maintainer", "lane-stack:docs-maintainer",
  "night-reviewer", "lane-stack:night-reviewer",
  "browser-qa", "lane-stack:browser-qa",
  "design-lead", "lane-stack:design-lead",
  "copy-lead", "lane-stack:copy-lead",
  "seo-specialist", "lane-stack:seo-specialist", "growth-marketer", "lane-stack:growth-marketer",
  "tavily", "lane-stack:tavily",
]);

/** Sessions Lane Pilot runs itself for its own work: the owner does not pick them and they never schedule anything. The lead («Штурман») is one since 0.1.463: the panel opens its chat, the tick runs it. */
const INTERNAL_AGENT_IDS = new Set(["project-onboarder", "browser-qa", LEAD_ID]);

export function isInternalAgent(agentId: string): boolean {
  return INTERNAL_AGENT_IDS.has(nativeAgentName(agentId));
}

export function isCliLanePmPrompt(text: string): boolean {
  return /run-controller/.test(text)
    && (/lane-ctl/.test(text) || /docs\/llm/.test(text) || /\/home\/ubuntu\/\.agents/.test(text));
}

export function isCliLaneAgentPrompt(agentId: string, text: string): boolean {
  const id = nativeAgentName(agentId);
  if (/Imported from Claude Lane Stack/.test(text) || /lane-stack` 1\.60\.0/.test(text)) return true;
  if (isLanePmAgent(id)) return isCliLanePmPrompt(text);
  if (id === "copy-lead") return /Boot \*\*copy-lead\*\*/.test(text);
  if (id === "seo-specialist") return /seo-init|seo-resume/.test(text);
  if (id === "design-lead") return /# design-lead/.test(text) && /page-prototype/.test(text);
  if (id === "project-onboarder") return /docs\/llm|project-onboard /.test(text);
  if (id === "tavily") return /Boot \*\*tavily\*\*|secrets\/tavily\.env/.test(text);
  if (id === "browser-qa") return /Boot \*\*browser-qa\*\*/.test(text);
  return false;
}

export function dropCliSessionTools(tools: string[]): string[] {
  return tools.filter((tool) => !CLI_SESSION_TOOLS.has(tool));
}

export function withoutCodeWritingSubagents(agentId: string, tools: string[]): string[] {
  if (!isLanePmAgent(agentId)) return tools;
  return tools.map((tool) => {
    if (tool === "Agent" || tool === "Task") return `${tool}(Explore, Plan)`;
    const match = /^(Agent|Task)\((.*)\)$/.exec(tool);
    if (!match) return tool;
    const kept = match[2]!.split(",").map((name) => name.trim()).filter((name) => name && !BB_PM_STRIPPED_SUBAGENTS.has(name));
    return `${match[1]}(${kept.join(", ")})`;
  });
}

export function overlaySessionTools(agentId: string, tools: string[]): string[] {
  const base = withoutLpBridgeTools(dropCliSessionTools(withoutCodeWritingSubagents(agentId, tools)));
  if (nativeAgentName(agentId) === WORKFLOW_ARCHITECT_ID) {
    // The bridge's tools are deferred: without the loader the architect could not load the draft tools it is allowed.
    const architect = unionLpBridgeTools(base, NATIVE_LP_BRIDGE_ARCHITECT_TOOLS);
    return architect.includes(DEFERRED_MCP_LOADER) ? architect : [...architect, DEFERRED_MCP_LOADER];
  }
  if (nativeAgentName(agentId) === LEAD_ID) {
    // The lead keeps the road and the journal; it has no dispatch, schedule, errand or browser tool whatever a saved definition lists.
    const lead = unionLpBridgeTools(base, NATIVE_LP_BRIDGE_LEAD_TOOLS);
    return lead.includes(DEFERRED_MCP_LOADER) ? lead : [...lead, DEFERRED_MCP_LOADER];
  }
  if (!isLanePmAgent(agentId)) {
    if (isInternalAgent(agentId)) return base;
    // A specialist (bundled or the owner's own) gets the schedule and the loader that defers its schema.
    const specialist = unionLpBridgeTools(base, NATIVE_LP_BRIDGE_SPECIALIST_TOOLS);
    return specialist.includes(DEFERRED_MCP_LOADER) ? specialist : [...specialist, DEFERRED_MCP_LOADER];
  }
  const withBridge = unionLpBridgeTools(base.includes(PM_BRIDGE_SERVER_ENTRY) ? base : [...base, PM_BRIDGE_SERVER_ENTRY], NATIVE_LP_BRIDGE_PM_TOOLS);
  return withBridge.includes(DEFERRED_MCP_LOADER) ? withBridge : [...withBridge, DEFERRED_MCP_LOADER];
}

export function unionLpBridgeToolsOnAgentsJson(agentId: string, agentsJson: string, directoryMove = false): Record<string, unknown> {
  const parsed = JSON.parse(agentsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("native_agents_json_invalid");
  const body = parsed as Record<string, unknown>;
  const raw = body[agentId] && typeof body[agentId] === "object"
    ? body[agentId]
    : Object.values(body)[0];
  if (!raw || typeof raw !== "object") throw new Error("native_agents_json_missing_profile");
  const definition = { ...raw as Record<string, unknown> };
  const tools = definition.tools;
  if (Array.isArray(tools) && tools.every((item) => typeof item === "string") && !tools.includes("*")) {
    definition.tools = overlaySessionTools(agentId, tools);
    const denied = definition.disallowedTools;
    const disallowed = overlayDisallowedTools(agentId, Array.isArray(denied) && denied.every((item) => typeof item === "string") ? denied : undefined);
    if (disallowed) definition.disallowedTools = disallowed;
  }
  if (directoryMove && isLanePmAgent(agentId)) allowDirectoryMove(definition);
  return { [agentId]: definition };
}
