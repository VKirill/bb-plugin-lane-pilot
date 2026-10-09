import { z } from "zod";
import { LANE_PILOT_TOOL_SEARCH_NAME, PM_CORE_TOOLS, PM_TOOL_FAMILIES, rewriteFoldedToolNames, type ToolFamily } from "../pm-tool-families";
import type { ServerCore } from "../../core/server";
import { registerObservedTool, registeredTools, type ObservedTool } from "../../core/server";

/** The shared lead of every "Use from the active Lane Pilot PM thread." that the family says once. */
const PM_ONLY_LEAD = /Use (?:only )?from the (?:active|matching) Lane Pilot PM thread\.\s*/g;

const tidy = (text: string) => rewriteFoldedToolNames(text).replace(PM_ONLY_LEAD, "").trim();

function shapeOf(tool: ObservedTool): z.ZodRawShape {
  if (!(tool.parameters instanceof z.ZodObject)) throw new Error(`tool family: ${tool.name} has no object parameters`);
  return (tool.parameters as z.ZodObject).shape;
}

/** The kind under optional/default/nullable wrappers. */
function baseKind(schema: z.ZodType): string {
  let current: any = schema;
  for (let i = 0; i < 6 && current?._zod?.def; i += 1) {
    const def = current._zod.def;
    if (["optional", "default", "nullable", "prefault", "readonly"].includes(def.type) && def.innerType) { current = def.innerType; continue; }
    return def.type;
  }
  return "unknown";
}

/**
 * Agents often send a number or a list as text ("45", "[\"a\"]"), mostly when the tool's schema came through ToolSearch.
 * A family field that is not text also takes a JSON string of its own type; the old tool still checks the value.
 */
function lenient(schema: z.ZodType): z.ZodType {
  if (!["number", "int", "bigint", "boolean", "array", "object", "record", "tuple"].includes(baseKind(schema))) return schema;
  const fromText = z.string().transform((text, ctx) => {
    try { return JSON.parse(text) as unknown; } catch { ctx.addIssue({ code: "custom", message: "expected JSON of the field's type" }); return z.NEVER; }
  }).pipe(schema);
  return z.union([schema, fromText]);
}

function lenientShape(tool: ObservedTool): z.ZodRawShape {
  return Object.fromEntries(Object.entries(shapeOf(tool)).map(([key, field]) => [key, lenient(field as z.ZodType)]));
}

/** BB caps a tool's static instructions; a family that does not fit says only what each action's instructions say. */
const INSTRUCTIONS_MAX = 4000;

/** One action of a family: the old tool it runs, the arguments that old tool takes and the ones it must get. */
type Member = {
  action: string;
  tool: ObservedTool;
  /** The old tool's fields, lenient about text; its defaults stay with the old tool. */
  args: z.ZodObject;
  required: Array<{ key: string; type: string }>;
};

/** What a field takes, for messages and instructions: `string`, `number`, `local|staging|...`. */
function fieldType(schema: z.ZodType): string {
  const def = (schema as any)._zod.def;
  if (def.type === "enum") return Object.values(def.entries).join("|");
  if (["optional", "default", "nullable", "prefault", "readonly"].includes(def.type) && def.innerType) return fieldType(def.innerType);
  return def.type;
}

/** The field without its default: the flat schema must not give an action a value that is not its own. */
function withoutDefault(schema: z.ZodType): z.ZodType {
  const def = (schema as any)._zod.def;
  return def.type === "default" || def.type === "prefault" ? withoutDefault(def.innerType) : schema;
}

function memberOf(action: string, tool: ObservedTool): Member {
  return {
    action,
    tool,
    args: z.object(lenientShape(tool)).strict(),
    required: Object.entries(shapeOf(tool))
      .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
      .map(([key, field]) => ({ key, type: fieldType(field as z.ZodType) })),
  };
}

/** Every argument of every action, once per name, optional: each name takes the union of the forms its actions take. */
function flatShape(members: Member[]): z.ZodRawShape {
  const takers = new Map<string, Array<{ action: string; field: z.ZodType; required: boolean }>>();
  for (const member of members) {
    for (const [key, field] of Object.entries(shapeOf(member.tool))) {
      const uses = takers.get(key) ?? [];
      uses.push({ action: member.action, field: field as z.ZodType, required: member.required.some((r) => r.key === key) });
      takers.set(key, uses);
    }
  }
  return Object.fromEntries([...takers].map(([key, uses]) => {
    // Two actions that send one name in the same form share the field; a clash of forms is a union.
    const forms = new Map(uses.map((use) => [JSON.stringify(z.toJSONSchema(use.field, { io: "input", unrepresentable: "any" })), lenient(withoutDefault(use.field))]));
    const variants = [...forms.values()];
    const field = variants.length === 1 ? variants[0]! : z.union(variants as [z.ZodType, z.ZodType, ...z.ZodType[]]);
    const takes = uses.map((use) => (use.required ? `${use.action} (required)` : use.action)).join(", ");
    return [key, field.optional().describe(`Argument of ${takes}.`)];
  }));
}

type Checked = { ok: true; value: unknown } | { ok: false; message: string };

const issuesOf = (error: z.ZodError) => error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");

/**
 * The arguments one action gets, checked the way its old tool checks them: missing required ones, another action's
 * arguments and wrong types are refused with the action's name; the old tool's own schema then gets the value.
 */
function checkArguments(family: string, members: Member[], member: Member, args: Record<string, unknown>): Checked {
  const missing = member.required.filter(({ key }) => args[key] === undefined);
  if (missing.length) return { ok: false, message: `${family} ${member.action} needs: ${missing.map(({ key, type }) => `${key} (${type})`).join(", ")}` };
  const own = shapeOf(member.tool);
  const foreign = Object.keys(args).filter((key) => args[key] !== undefined && !Object.hasOwn(own, key));
  if (foreign.length) {
    return {
      ok: false,
      message: foreign.map((key) => {
        const owner = members.find((other) => Object.hasOwn(shapeOf(other.tool), key));
        return `${family} ${member.action} does not take ${key}${owner ? ` (an argument of ${owner.action})` : ""}`;
      }).join("; "),
    };
  }
  const typed = member.args.safeParse(args);
  if (!typed.success) return { ok: false, message: `${family} ${member.action}: ${issuesOf(typed.error)}` };
  const checked = member.tool.parameters.safeParse(typed.data);
  if (!checked.success) return { ok: false, message: `${family} ${member.action}: ${issuesOf(checked.error)}` };
  return { ok: true, value: checked.data };
}

function familyInstructions(members: Member[]): string {
  const lead = "Every call carries `action` plus the arguments of that action; any other argument is refused. Use from the active Lane Pilot PM thread.";
  const required = (member: Member) => (member.required.length
    ? `Required: ${member.required.map(({ key, type }) => `${key} (${type})`).join(", ")}.`
    : "No required argument.");
  const full = [lead, ...members.map((member) => `- action "${member.action}": ${required(member)} ${tidy(member.tool.description)} ${tidy(member.tool.instructions ?? "")}`.trim())].join("\n");
  if (full.length <= INSTRUCTIONS_MAX) return full;
  const short = [lead, ...members.map((member) => `- action "${member.action}": ${required(member)} ${tidy(member.tool.instructions || member.tool.description)}`)].join("\n");
  if (short.length > INSTRUCTIONS_MAX) throw new Error(`tool family: instructions of ${members.map((m) => m.action).join("/")} are ${short.length} characters, over ${INSTRUCTIONS_MAX}`);
  return short;
}

function mountFamily(ctx: ServerCore, name: string, family: ToolFamily): void {
  const book = registeredTools(ctx.bb.agents);
  const members = Object.entries(family.actions).map(([action, oldName]) => {
    const tool = book.get(oldName);
    if (!tool) throw new Error(`tool family ${name}: ${oldName} is not registered`);
    return memberOf(action, tool);
  });
  const byAction = new Map(members.map((member) => [member.action, member]));
  const actionList = members.map((member) => member.action).join(", ");
  registerObservedTool(ctx.bb.agents, {
    name,
    description: `${family.summary} Pick one action (${actionList}) and give its arguments next to it.`,
    instructions: familyInstructions(members),
    // BB keeps only `type: object` of a top-level union, so the family publishes one flat object. Its superRefine runs the
    // action's checks at parse time, where a refusal reaches the caller as an invalid-arguments error.
    parameters: z.object({
      action: z.enum(members.map((member) => member.action) as [string, ...string[]]).describe(`The action to run: ${actionList}.`),
      ...flatShape(members),
    }).strict().superRefine((input, issues) => {
      const { action, ...args } = input as { action: string } & Record<string, unknown>;
      const member = byAction.get(action);
      if (!member) return;
      const checked = checkArguments(name, members, member, args);
      if (!checked.ok) issues.addIssue({ code: "custom", message: checked.message });
    }),
    execute: async (input, context) => {
      const { action, ...args } = input as { action: string } & Record<string, unknown>;
      const member = byAction.get(action)!;
      // The old handler gets exactly what the old tool parses: its own schema, strictness and defaults included.
      const checked = checkArguments(name, members, member, args);
      if (!checked.ok) throw new Error(checked.message);
      return member.tool.execute(checked.value, context);
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

