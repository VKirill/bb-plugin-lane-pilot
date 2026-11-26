import { z } from "zod";

/**
 * Tools that take an `action` (lane_pilot_phase, lane_pilot_schedule, the PM's family tools …). BB shows a model only `type: object`
 * of a top-level union, so the call shape of each action reaches the model through two things generated here from the zod schema:
 * one flat object schema with every argument, and one signature line per action in the tool's instructions (`revise {phaseId, goal, note}`).
 * A refusal names the action and the arguments it needs. Live phase ph_86fd9d3fab, 2026-10-27: the PM called `revise` twice before it
 * learned that the call takes goal and note.
 */

/** One action of an action tool: the arguments it takes, and the schema its handler finally parses. */
export type ActionMember = {
  action: string;
  /** The action's own fields (never `action` itself). */
  shape: z.ZodRawShape;
  /** The fields as a strict object, lenient about numbers, lists and flags sent as JSON text. */
  args: z.ZodObject;
  required: Array<{ key: string; type: string }>;
  /** What the handler parses once the arguments passed: a union option's whole union, or the old tool's own schema. */
  final: z.ZodType;
  /** The handler's schema carries `action` itself (a union) and wants it back in the value. */
  withAction: boolean;
};

const WRAPPERS = ["optional", "default", "nullable", "prefault", "readonly"];

/** The kind under optional/default/nullable wrappers. */
function baseKind(schema: z.ZodType): string {
  let current: any = schema;
  for (let i = 0; i < 6 && current?._zod?.def; i += 1) {
    const def = current._zod.def;
    if (WRAPPERS.includes(def.type) && def.innerType) { current = def.innerType; continue; }
    return def.type;
  }
  return "unknown";
}

/**
 * Agents often send a number or a list as text ("45", "[\"a\"]"), mostly when the tool's schema came through ToolSearch.
 * A field that is not text also takes a JSON string of its own type; the handler's schema still checks the value.
 */
function lenient(schema: z.ZodType): z.ZodType {
  if (!["number", "int", "bigint", "boolean", "array", "object", "record", "tuple"].includes(baseKind(schema))) return schema;
  const fromText = z.string().transform((text, ctx) => {
    try { return JSON.parse(text) as unknown; } catch { ctx.addIssue({ code: "custom", message: "expected JSON of the field's type" }); return z.NEVER; }
  }).pipe(schema);
  return z.union([schema, fromText]);
}

/** What a field takes, for messages and instructions: `string`, `number`, `local|staging|...`. */
export function fieldType(schema: z.ZodType): string {
  const def = (schema as any)._zod.def;
  if (def.type === "enum") return Object.values(def.entries).join("|");
  if (def.type === "literal") return (def.values as unknown[]).map((value) => JSON.stringify(value)).join("|");
  if (WRAPPERS.includes(def.type) && def.innerType) return fieldType(def.innerType);
  // A union is a field that also takes its own JSON text (asJson in the phase tool): the type is that of its first form.
  if (def.type === "union" && def.options?.length) return fieldType(def.options[0]);
  if (def.type === "pipe" && def.in) return fieldType(def.in);
  return def.type;
}

/** The field without its default: the flat schema must not give an action a value that is not its own. */
function withoutDefault(schema: z.ZodType): z.ZodType {
  const def = (schema as any)._zod.def;
  return def.type === "default" || def.type === "prefault" ? withoutDefault(def.innerType) : schema;
}

export function memberOf(action: string, shape: z.ZodRawShape, final: z.ZodType, withAction: boolean): ActionMember {
  return {
    action,
    shape,
    args: z.object(Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, lenient(field as z.ZodType)]))).strict(),
    required: Object.entries(shape)
      .filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success)
      .map(([key, field]) => ({ key, type: fieldType(field as z.ZodType) })),
    final,
    withAction,
  };
}

/** The actions of a tool whose parameters are a union on `action`; null for any other schema. */
export function unionMembers(schema: z.ZodType): ActionMember[] | null {
  const def = (schema as any)?._zod?.def;
  if (def?.type !== "union" || def.discriminator !== "action") return null;
  return (def.options as z.ZodObject[]).map((option) => {
    const { action, ...shape } = option.shape;
    return memberOf((action as any)._zod.def.values[0] as string, shape, schema, true);
  });
}

/** Every argument of every action, once per name, optional: each name takes the union of the forms its actions take. */
export function flatShape(members: ActionMember[]): z.ZodRawShape {
  const takers = new Map<string, Array<{ action: string; field: z.ZodType; required: boolean }>>();
  for (const member of members) {
    for (const [key, field] of Object.entries(member.shape)) {
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
 * The arguments one action gets, checked the way its handler checks them: missing required ones, another action's
 * arguments and wrong types are refused with the action's name; the handler's own schema then gets the value.
 */
export function checkArguments(tool: string, members: ActionMember[], member: ActionMember, args: Record<string, unknown>): Checked {
  const missing = member.required.filter(({ key }) => args[key] === undefined);
  if (missing.length) return { ok: false, message: `${tool} ${member.action} needs: ${missing.map(({ key, type }) => `${key} (${type})`).join(", ")}` };
  const foreign = Object.keys(args).filter((key) => args[key] !== undefined && !Object.hasOwn(member.shape, key));
  if (foreign.length) {
    return {
      ok: false,
      message: foreign.map((key) => {
        const owner = members.find((other) => Object.hasOwn(other.shape, key));
        return `${tool} ${member.action} does not take ${key}${owner ? ` (an argument of ${owner.action})` : ""}`;
      }).join("; "),
    };
  }
  const typed = member.args.safeParse(args);
  if (!typed.success) return { ok: false, message: `${tool} ${member.action}: ${issuesOf(typed.error)}` };
  const checked = member.final.safeParse(member.withAction ? { action: member.action, ...(typed.data as object) } : typed.data);
  if (!checked.success) return { ok: false, message: `${tool} ${member.action}: ${issuesOf(checked.error)}` };
  return { ok: true, value: checked.data };
}

/**
 * The published schema of an action tool: `action` (an enum) plus every argument, optional, merged by name. A superRefine runs the
 * action's checks at parse time, where a refusal reaches the caller as an invalid-arguments error. `refuse` answers for an action
 * that is not a member (a retired one) with the message to give.
 */
export function flatParameters(tool: string, members: ActionMember[], extra?: { actions: string[]; refuse: (action: string) => string | undefined }) {
  const byAction = new Map(members.map((member) => [member.action, member]));
  const list = members.map((member) => member.action).join(", ");
  return z.object({
    action: z.enum([...members.map((member) => member.action), ...(extra?.actions ?? [])] as [string, ...string[]]).describe(`The action to run: ${list}.`),
    ...flatShape(members),
  }).strict().superRefine((input, issues) => {
    const { action, ...args } = input as { action: string } & Record<string, unknown>;
    const refused = extra?.refuse(action);
    if (refused) { issues.addIssue({ code: "custom", message: refused }); return; }
    const member = byAction.get(action);
    if (!member) return;
    const checked = checkArguments(tool, members, member, args);
    if (!checked.ok) issues.addIssue({ code: "custom", message: checked.message });
  });
}

/** `revise {phaseId, goal, note}`: required fields bare, optional ones marked `?`, enums and non-text kinds after a colon. */
export function signature(member: ActionMember): string {
  const parts = Object.entries(member.shape).map(([key, field]) => {
    const required = member.required.some((row) => row.key === key);
    const type = fieldType(field as z.ZodType);
    const shown = type === "string" ? "" : type.includes("|") && type.split("|").length > 8 ? ": string" : `: ${type}`;
    return `${key}${required ? "" : "?"}${shown}`;
  });
  return `${member.action} {${parts.join(", ")}}`;
}

/** The generated block of an action tool's instructions: one signature line per action. */
export function signatureLines(members: ActionMember[]): string[] {
  return members.map((member) => `- ${signature(member)}`);
}

/** The instructions of an action tool: the tool's own text, then what each action takes. */
export function withSignatures(instructions: string | undefined, members: ActionMember[]): string {
  return [instructions, "Arguments by action (`?` optional):", ...signatureLines(members)].filter(Boolean).join("\n");
}
