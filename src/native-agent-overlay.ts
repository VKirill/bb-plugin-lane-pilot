import { unionLpBridgeTools } from "./native-session-hooks";

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

const AGENTS_JSON_FIELD_SET = new Set<string>(AGENTS_JSON_FIELDS);
const PLUGIN_IGNORED_SET = new Set<string>(PLUGIN_IGNORED_FIELDS);
const BB_SESSION_OWNED_SET = new Set<string>(BB_SESSION_OWNED_FIELDS);
const DROPPED_IDENTITY_FIELDS = new Set(["name", "color", "experimental"]);

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

function normalizeToolList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? splitClaudeToolList(value)
      : [];
  return items;
}

const PM_AGENT_IDS = new Set(["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator"]);

/**
 * A Lane PM delegates code only to Lane writers. A general-purpose subagent would write product code
 * in the PM's own checkout, past plan critique, the writer model and worktrees, so a PM keeps
 * read-only Explore/Plan and the Lane specialists only.
 */
const CLI_LANE_SUBAGENTS = new Set(["general-purpose", "lane-stack:run-supervisor", "lane-stack:lane-supervisor", "lane-stack:emergency-writer"]);

export function isLanePmAgent(agentId: string): boolean {
  return PM_AGENT_IDS.has(agentId.split(":").pop() ?? agentId);
}

/** Appended to a Lane PM's prompt in a BB chat: writer lanes are BB threads there, not run-controller processes. */
export const LANE_PILOT_PM_SESSION = `## Lane Pilot session (BB)

This chat runs inside BB with Lane Pilot, and writer lanes are BB threads, not run-controller processes.
- Plan as usual: run-init, PLAN.md, SPEC.md, task files, plan-critique and run-validate stay available.
- Dispatch every writer task with \`lane_pilot_dispatch_writer\`: \`task\` is the task-v2 contract with \`project_cwd\` equal to this checkout, \`plan\` is the canonical plan text for that task. Tasks without unmet \`depends_on\` may be dispatched together; dispatch a dependent task once its dependencies are accepted.
- Poll with \`lane_pilot_wait_writer\` (runId) and repeat while it reports running, until every task is accepted or blocked.
- Each writer works in its own BB worktree. On acceptance Lane Pilot merges that worktree into main; a merge conflict retries the task on the new main by itself.
- Here, do not run run-controller, lane-ctl start/retry/fallback, lane-bg or lane-exec, and do not use run-supervisor, lane-supervisor or emergency-writer. Never write product code yourself.
- When every task is accepted, check main, update docs and memory, then report.`;

export function withoutCodeWritingSubagents(agentId: string, tools: string[]): string[] {
  if (!isLanePmAgent(agentId)) return tools;
  return tools.map((tool) => {
    if (tool === "Agent" || tool === "Task") return `${tool}(Explore, Plan)`;
    const match = /^(Agent|Task)\((.*)\)$/.exec(tool);
    if (!match) return tool;
    const kept = match[2]!.split(",").map((name) => name.trim()).filter((name) => name && !CLI_LANE_SUBAGENTS.has(name));
    return `${match[1]}(${kept.join(", ")})`;
  });
}

export function stockAgentsOverlayFromInstalled(input: {
  agentId: string;
  source: string;
  markdown: string;
}): Record<string, unknown> | null {
  const parsed = parseAgentMarkdown(input.markdown);
  const tools = normalizeToolList(parsed.frontmatter.tools);
  if (!tools || tools.includes("*")) return null;
  const plugin = input.source.startsWith("plugin:");
  const definition: Record<string, unknown> = {
    description: typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim()
      ? parsed.frontmatter.description
      : input.agentId,
    prompt: isLanePmAgent(input.agentId) ? `${parsed.prompt.trimEnd()}\n\n${LANE_PILOT_PM_SESSION}\n` : parsed.prompt,
    tools: unionLpBridgeTools(withoutCodeWritingSubagents(input.agentId, tools)),
  };
  for (const [key, value] of Object.entries(parsed.frontmatter)) {
    if (key === "description" || key === "tools" || key === "prompt") continue;
    if (DROPPED_IDENTITY_FIELDS.has(key) || BB_SESSION_OWNED_SET.has(key)) continue;
    if (plugin && PLUGIN_IGNORED_SET.has(key)) continue;
    if (!AGENTS_JSON_FIELD_SET.has(key)) continue;
    if (key === "disallowedTools") {
      const denied = normalizeToolList(value);
      if (denied) definition[key] = denied;
      continue;
    }
    definition[key] = value;
  }
  return { [input.agentId]: definition };
}

export function unionLpBridgeToolsOnAgentsJson(agentId: string, agentsJson: string): Record<string, unknown> {
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
    definition.tools = unionLpBridgeTools(withoutCodeWritingSubagents(agentId, tools));
    if (isLanePmAgent(agentId) && typeof definition.prompt === "string" && !definition.prompt.includes(LANE_PILOT_PM_SESSION)) {
      definition.prompt = `${definition.prompt.trimEnd()}\n\n${LANE_PILOT_PM_SESSION}\n`;
    }
  }
  return { [agentId]: definition };
}
