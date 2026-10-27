import { z } from "zod";
import {
  MAIN_AGENT_ID,
  agentKind,
  compileEffectiveMainAgent,
  compileMainAgentProfile,
  isStockProfileId,
  type AgentKind,
  type CustomAgentMeta,
  type StoredAgentRow,
} from "./agent-profile";
import { isLanePmAgent, parseAgentMarkdown, splitClaudeToolList } from "./native-agent-overlay";

/**
 * The owner's own agents. An agent is data: a row of the same store as the edits of a bundled profile (`lp.agent.overrides`), under an id no bundled
 * agent uses. The row holds the compiled profile (prompt, tools, skills, MCP servers) and a `meta` with what the profile has no room for.
 */
const names = z.array(z.string().trim().min(1)).max(64);
const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const createAgentInputSchema = z.object({
  id: z.string().regex(MAIN_AGENT_ID),
  /** The label every picker shows. */
  displayName: z.string().trim().min(1).max(120),
  /** What the agent is for, in a line or two (shown in the list; the compiled profile keeps only the label). */
  description: z.string().trim().max(400).optional(),
  prompt: z.string().trim().min(1).max(32_000),
  tools: names.optional(),
  disallowedTools: names.optional(),
  skills: names.optional(),
  mcpServers: names.optional(),
  model: z.string().trim().min(1).max(100).optional(),
  effort: effort.optional(),
}).strict();
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

/** Every field but the id is optional; `model` and `effort` take null to go back to the default. */
export const updateAgentInputSchema = z.object({
  id: z.string().regex(MAIN_AGENT_ID),
  displayName: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional(),
  prompt: z.string().trim().min(1).max(32_000).optional(),
  tools: names.optional(),
  disallowedTools: names.optional(),
  skills: names.optional(),
  mcpServers: names.optional(),
  model: z.string().trim().min(1).max(100).nullable().optional(),
  effort: effort.nullable().optional(),
}).strict();
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

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
};

/** The part of a list item a picker needs (the composer popover, the PM's team tab): no prompt, no resources. */
export function pickableAgent(row: AgentListItem): Pick<AgentListItem, "id" | "description" | "displayName" | "summary" | "kind" | "custom"> {
  return { id: row.id, description: row.description, displayName: row.displayName, ...(row.summary ? { summary: row.summary } : {}), kind: row.kind, custom: row.custom };
}

export type AgentFailure =
  | "invalid_agent"
  | "agent_id_reserved"
  | "agent_exists"
  | "agent_not_found"
  | "agent_not_custom"
  | "agent_in_use";

const RESERVED_IDS = new Set(["browser-qa", "default", "general-purpose", "explore", "plan"]);

/** A custom agent may not take the id of a bundled agent, of a Lane PM or of a name the Claude Code CLI reserves. */
export function isReservedAgentId(id: string): boolean {
  return isStockProfileId(id) || isLanePmAgent(id) || RESERVED_IDS.has(id);
}

export function isCustomAgentId(id: string): boolean {
  return !isReservedAgentId(id);
}

/** One row of the agent list: a bundled agent as it stands now (stock or edited), or an owner's agent. */
export function agentListItem(id: string, stored?: StoredAgentRow): AgentListItem {
  const compiled = compileEffectiveMainAgent(id, stored);
  const custom = !isStockProfileId(id);
  const stock = custom ? null : compileMainAgentProfile(id);
  const meta = stored?.meta;
  return {
    id,
    description: compiled.description,
    displayName: meta?.displayName ?? compiled.description,
    ...(meta?.summary ? { summary: meta.summary } : {}),
    kind: agentKind(id),
    custom,
    prompt: compiled.prompt,
    sourceHash: compiled.sourceHash,
    sourceVersion: compiled.sourceVersion,
    edited: stock ? compiled.sourceHash !== stock.sourceHash : true,
    ...(compiled.tools ? { tools: compiled.tools } : {}),
    ...(compiled.disallowedTools ? { disallowedTools: compiled.disallowedTools } : {}),
    ...(compiled.skills ? { skills: compiled.skills } : {}),
    ...(compiled.mcpServers ? { mcpServers: compiled.mcpServers } : {}),
    ...(meta?.model ? { model: meta.model } : {}),
    ...(meta?.effort ? { effort: meta.effort } : {}),
  };
}

type Resources = Partial<Record<"tools" | "disallowedTools" | "skills" | "mcpServers", string[]>>;

function rowOf(id: string, prompt: string, displayName: string, meta: CustomAgentMeta, resources: Resources): StoredAgentRow {
  const compiled = compileMainAgentProfile(id, { prompt, description: displayName, ...resources });
  return { prompt, description: displayName, compiled, meta };
}

/** The row of a new owner's agent. Throws on a reserved or invalid id (the caller maps it to an error code). */
export function newCustomAgentRow(input: CreateAgentInput, now: number): StoredAgentRow {
  const resources = {
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.disallowedTools ? { disallowedTools: input.disallowedTools } : {}),
    ...(input.skills ? { skills: input.skills } : {}),
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
  };
  return rowOf(input.id, input.prompt, input.displayName, {
    displayName: input.displayName,
    ...(input.description ? { summary: input.description } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    createdAt: now,
    updatedAt: now,
  }, resources);
}

/** The row after an update: the fields given replace the old ones, the rest stay; the dates and the id never change. */
export function updatedCustomAgentRow(id: string, row: StoredAgentRow, patch: UpdateAgentInput, now: number): StoredAgentRow {
  const compiled = compileEffectiveMainAgent(id, row);
  const meta = row.meta ?? {};
  const displayName = patch.displayName ?? meta.displayName ?? compiled.description;
  const prompt = patch.prompt ?? compiled.prompt;
  const resources = {
    ...((patch.tools ?? compiled.tools) ? { tools: patch.tools ?? compiled.tools } : {}),
    ...((patch.disallowedTools ?? compiled.disallowedTools) ? { disallowedTools: patch.disallowedTools ?? compiled.disallowedTools } : {}),
    ...((patch.skills ?? compiled.skills) ? { skills: patch.skills ?? compiled.skills } : {}),
    ...((patch.mcpServers ?? compiled.mcpServers) ? { mcpServers: patch.mcpServers ?? compiled.mcpServers } : {}),
  } as Resources;
  const summary = patch.description !== undefined ? patch.description : meta.summary;
  const model = patch.model === undefined ? meta.model : patch.model ?? undefined;
  const nextEffort = patch.effort === undefined ? meta.effort : patch.effort ?? undefined;
  return rowOf(id, prompt, displayName, {
    displayName,
    ...(summary ? { summary } : {}),
    ...(model ? { model } : {}),
    ...(nextEffort ? { effort: nextEffort } : {}),
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    updatedAt: now,
  }, resources);
}

function nameList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return typeof value === "string" ? splitClaudeToolList(value) : undefined;
}

/**
 * The text of an agent file as the fields of create/update. JSON is read as it is (`{"id": …}`); anything starting with `---` is markdown with
 * frontmatter: the body is the prompt, `id` (or `name`), `displayName`, `description`, `model`, `effort` are scalars, `tools`, `disallowedTools`,
 * `skills` and `mcpServers` are a YAML list or a comma line.
 */
export function parseAgentFile(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("agent_file_empty");
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agent_file_not_an_object");
    return parsed as Record<string, unknown>;
  }
  const { frontmatter, prompt } = parseAgentMarkdown(trimmed);
  const out: Record<string, unknown> = {};
  const id = frontmatter.id ?? frontmatter.name;
  if (typeof id === "string" && id) out.id = id;
  for (const key of ["displayName", "description", "model", "effort"] as const) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  for (const key of ["tools", "disallowedTools", "skills", "mcpServers"] as const) {
    const list = nameList(frontmatter[key]);
    if (list) out[key] = list;
  }
  if (prompt.trim()) out.prompt = prompt.trim();
  return out;
}
