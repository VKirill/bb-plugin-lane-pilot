import { z } from "zod";
import { LANE_PILOT_TOOL_SEARCH_NAME, PM_CORE_TOOLS, PM_TOOL_FAMILIES, rewriteFoldedToolNames, type ToolFamily } from "../pm-tool-families";
import type { ServerCore } from "../../../server/core";
import { registerObservedTool, registeredTools, type ObservedTool } from "../../../server/tool-result";

/** The shared lead of every "Use from the active Lane Pilot PM thread." that the family says once. */
const PM_ONLY_LEAD = /Use (?:only )?from the (?:active|matching) Lane Pilot PM thread\.\s*/g;

const tidy = (text: string) => rewriteFoldedToolNames(text).replace(PM_ONLY_LEAD, "").trim();

function shapeOf(tool: ObservedTool): z.ZodRawShape {
  if (!(tool.parameters instanceof z.ZodObject)) throw new Error(`tool family: ${tool.name} has no object parameters`);
  return (tool.parameters as z.ZodObject).shape;
}

/** BB caps a tool's static instructions; a family that does not fit says only what each action's instructions say. */
const INSTRUCTIONS_MAX = 4000;

function familyInstructions(members: Array<{ action: string; tool: ObservedTool }>): string {
  const lead = "Every call carries `action` plus the arguments of that action; any other argument is refused. Use from the active Lane Pilot PM thread.";
  const full = [lead, ...members.map(({ action, tool }) => `- action "${action}": ${tidy(tool.description)} ${tidy(tool.instructions ?? "")}`.trim())].join("\n");
  if (full.length <= INSTRUCTIONS_MAX) return full;
  const short = [lead, ...members.map(({ action, tool }) => `- action "${action}": ${tidy(tool.instructions || tool.description)}`)].join("\n");
  if (short.length > INSTRUCTIONS_MAX) throw new Error(`tool family: instructions of ${members.map((m) => m.action).join("/")} are ${short.length} characters, over ${INSTRUCTIONS_MAX}`);
  return short;
}

function mountFamily(ctx: ServerCore, name: string, family: ToolFamily): void {
  const book = registeredTools(ctx.bb.agents);
  const members = Object.entries(family.actions).map(([action, oldName]) => {
    const tool = book.get(oldName);
    if (!tool) throw new Error(`tool family ${name}: ${oldName} is not registered`);
    return { action, tool };
  });
  const variants = members.map(({ action, tool }) => z.object({ action: z.literal(action), ...shapeOf(tool) }).strict());
  const byAction = new Map(members.map((member) => [member.action, member.tool]));
  const actionList = members.map((member) => member.action).join(", ");
  registerObservedTool(ctx.bb.agents, {
    name,
    description: `${family.summary} Pick one action (${actionList}) and give its arguments next to it.`,
    instructions: familyInstructions(members),
    parameters: z.discriminatedUnion("action", variants as unknown as [typeof variants[number], ...typeof variants]),
    execute: async (input, context) => {
      const { action, ...rest } = input as { action: string } & Record<string, unknown>;
      const tool = byAction.get(action)!;
      // The old handler gets exactly what the old tool took: its own schema, strictness and defaults included.
      return tool.execute(tool.parameters.parse(rest), context);
    },
  });
}

type CatalogEntry = { tool: string; action?: string; formerName?: string; description: string; schema: ObservedTool };

function catalog(ctx: ServerCore): CatalogEntry[] {
  const book = registeredTools(ctx.bb.agents);
  const entries: CatalogEntry[] = [];
  for (const name of [...PM_CORE_TOOLS, "lane_pilot_schedule"]) {
    const tool = book.get(name);
    if (tool) entries.push({ tool: name, description: tidy(tool.description), schema: tool });
  }
  for (const [family, spec] of Object.entries(PM_TOOL_FAMILIES) as Array<[string, ToolFamily]>) {
    for (const [action, oldName] of Object.entries(spec.actions)) {
      const tool = book.get(oldName);
      if (tool) entries.push({ tool: family, action, formerName: oldName, description: tidy(tool.description), schema: tool });
    }
  }
  return entries;
}

const words = (text: string) => text.toLowerCase().split(/[^a-zа-яё0-9]+/i).filter((word) => word.length >= 2);

/** Score of one catalog entry for the words of a query: names weigh most, then the description, then the instructions. */
function score(entry: CatalogEntry, query: string, queryWords: string[]): number {
  const bare = query.trim().replace(/^mcp__bb-bridge__/, "");
  if (bare === entry.formerName || (bare === entry.tool && !entry.action)) return 1000;
  const names = words(`${entry.tool} ${entry.action ?? ""} ${entry.formerName ?? ""}`).join(" ");
  const description = entry.description.toLowerCase();
  const instructions = tidy(entry.schema.instructions ?? "").toLowerCase();
  let total = bare === entry.tool ? 5 : 0;
  for (const word of queryWords) total += (names.includes(word) ? 6 : 0) + (description.includes(word) ? 3 : 0) + (instructions.includes(word) ? 1 : 0);
  return total;
}

function mountToolSearch(ctx: ServerCore): void {
  registerObservedTool(ctx.bb.agents, {
    name: LANE_PILOT_TOOL_SEARCH_NAME,
    description: "Find a Lane Pilot capability by words (or by an old tool name) and get how to call it: the tool, its action and the argument schema.",
    instructions: "Use when you need a Lane Pilot capability that is not a tool of its own in your list (council, reminders and questions to other threads, specialists, the owner's browser, memory and lessons, workflow drafts), or when a text names a tool you do not have: search its name or a few words. Each hit says `tool` and `action` to call (for example tool `lane_pilot_relay`, action `remind`), the former name, a description and the JSON schema of the arguments (without `action`).",
    parameters: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).default(4) }).strict(),
    execute: async (params) => {
      const queryWords = words(params.query);
      const hits = catalog(ctx)
        .map((entry) => ({ entry, score: score(entry, params.query, queryWords) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, params.limit);
      if (!hits.length) {
        return JSON.stringify({ matches: [], available: catalog(ctx).map((entry) => (entry.action ? `${entry.tool}:${entry.action}` : entry.tool)) }, null, 2);
      }
      return JSON.stringify({
        matches: hits.map(({ entry }) => ({
          tool: entry.tool,
          ...(entry.action ? { action: entry.action } : {}),
          ...(entry.formerName ? { formerName: entry.formerName } : {}),
          description: entry.description,
          arguments: z.toJSONSchema(entry.schema.parameters, { io: "input", unrepresentable: "any" }),
        })),
      }, null, 2);
    },
  });
}

/** Run after every module registered its tools: the families wrap their handlers. */
export function mountToolFamilies(ctx: ServerCore): void {
  for (const [name, family] of Object.entries(PM_TOOL_FAMILIES) as Array<[string, ToolFamily]>) mountFamily(ctx, name, family);
  mountToolSearch(ctx);
}

