import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { registeredTools, unionMembers } from "../src/rooms/core/server";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION } from "../src/rooms/native-agent/native-agent-overlay";
import { PM_TOOL_FAMILIES } from "../src/rooms/tools/pm-tool-families";

// Agents copy the call shapes their instructions show. A shape that names a tool, an action or a field that does not exist sends them to a
// refusal (live phase ph_86fd9d3fab, 2026-10-27: `revise` without goal and note). This reads every call shape the agents are shown (the PM
// and specialist prompts, the tools' own texts, the `next` texts of the phase and the router in the sources) and checks it against the zod
// schemas the tools are registered with.

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

/** tool -> action ("" for a tool without actions) -> the fields that action takes and the ones it must get. */
type Shape = { fields: Set<string>; required: Set<string> };
type Shapes = Map<string, Map<string, Shape>>;

const shapeOf = (fields: z.ZodRawShape): Shape => ({
  fields: new Set(Object.keys(fields)),
  required: new Set(Object.entries(fields).filter(([, field]) => !(field as z.ZodType).safeParse(undefined).success).map(([key]) => key)),
});

async function start() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const book = registeredTools(bb.agents);
  const published = harness.registrations.agentTools as Array<{ name: string; description: string; instructions?: string; inputSchema: Record<string, any> }>;
  const shapes: Shapes = new Map();
  for (const tool of published) {
    const original = book.get(tool.name)!.parameters;
    const actions = new Map<string, Shape>();
    const family = (PM_TOOL_FAMILIES as Record<string, { actions: Record<string, string> }>)[tool.name];
    const union = unionMembers(original);
    if (family) for (const [action, old] of Object.entries(family.actions)) actions.set(action, shapeOf((book.get(old)!.parameters as z.ZodObject).shape));
    else if (union) for (const member of union) actions.set(member.action, shapeOf(member.shape));
    else actions.set("", original instanceof z.ZodObject ? shapeOf(original.shape) : { fields: new Set(Object.keys(tool.inputSchema.properties ?? {})), required: new Set() });
    shapes.set(tool.name, actions);
  }
  return { published, shapes };
}

type Mention = { tool: string; action?: string; fields: string[]; raw: string };

const QUOTE = `\\\\?["']`;
const BRACE = new RegExp(String.raw`\b(lane_pilot_[a-z_]+)\s*\{\s*action\s*:\s*${QUOTE}([a-z_]+)${QUOTE}((?:\$\{[^}]*\}|[^}])*)\}`, "g");
const PROSE = new RegExp(String.raw`\b(lane_pilot_[a-z_]+)[\`,\s(]*(?:with\s+)?[\`(]*action[:\s]+\\?["']?([a-z_]+)\\?["']?\`?(\s*\(([^)]{1,200})\))?`, "g");
const PLAIN = /\b(lane_pilot_[a-z_]*[a-z])`?\s*\(([^)]{1,200})\)/g;
const FIELD = /^[`]?([A-Za-z][A-Za-z0-9_]*)\??[`]?(?:\s*(?:[:=≤<>]|\.\.\.).*)?$/;

/** Splits at the commas outside brackets, braces and quotes. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) { if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if ("[{(".includes(char)) depth += 1;
    else if ("]})".includes(char)) depth -= 1;
    if (char === "," && depth <= 0 && !quote) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts;
}

/** The fields a list names, or null when the text is prose and not a list of argument names. */
function fieldList(text: string): string[] | null {
  const items = splitTop(text.replace(/\$\{[^}]*\}/g, "x")).map((item) => item.trim()).filter((item) => item && item !== "…" && item !== "...");
  const fields: string[] = [];
  for (const item of items) {
    const match = FIELD.exec(item);
    if (!match) return null;
    fields.push(match[1]!);
  }
  return fields;
}

/** The phase driver builds its call shapes with `tool("answer", `, phaseId:"…", questionId, answer`)` (phase/logic.ts). */
const PHASE_HELPER = /\$\{tool\("([a-z_]+)"(?:,\s*`((?:[^`\\]|\\.)*)`)?\)\}/g;

export function mentionsIn(text: string, plain: boolean): Mention[] {
  const found: Mention[] = [];
  for (const m of text.matchAll(BRACE)) found.push({ tool: m[1]!, action: m[2]!, fields: fieldList(m[3]!.replace(/^\s*,/, "")) ?? [], raw: m[0] });
  for (const m of text.matchAll(PROSE)) found.push({ tool: m[1]!, action: m[2]!, fields: (m[4] ? fieldList(m[4]) : null) ?? [], raw: m[0] });
  if (plain) for (const m of text.matchAll(PLAIN)) { const fields = fieldList(m[2]!); if (fields?.length) found.push({ tool: m[1]!, fields, raw: m[0] }); }
  if (text.includes("const tool = (action: string, args = \"\") => `lane_pilot_phase")) {
    for (const m of text.matchAll(PHASE_HELPER)) found.push({ tool: "lane_pilot_phase", action: m[1]!, fields: fieldList((m[2] ?? "").replace(/^\s*,/, "")) ?? [], raw: m[0] });
  }
  return found;
}

/** What is wrong with one mention against the registered schemas, or null. A shape that lists its arguments must list every required one. */
function problem(mention: Mention, shapes: Shapes): string | null {
  const actions = shapes.get(mention.tool);
  if (!actions) return `${mention.tool} is not a registered tool`;
  const hasActions = !actions.has("");
  if (mention.action === undefined) return hasActions ? null : checkFields(mention, actions.get("")!);
  if (!hasActions) return `${mention.tool} takes no action (${mention.raw})`;
  const shape = actions.get(mention.action);
  if (!shape) return `${mention.tool} has no action ${mention.action} (it has ${[...actions.keys()].join(", ")})`;
  return checkFields(mention, shape);
}

function checkFields(mention: Mention, shape: Shape): string | null {
  const name = `${mention.tool}${mention.action ? ` ${mention.action}` : ""}`;
  const unknown = mention.fields.filter((field) => !shape.fields.has(field));
  if (unknown.length) return `${name} does not take ${unknown.join(", ")} (it takes ${[...shape.fields].join(", ") || "nothing"}); in "${mention.raw}"`;
  const missing = mention.fields.length ? [...shape.required].filter((field) => !mention.fields.includes(field)) : [];
  return missing.length ? `${name} needs ${missing.join(", ")} too; in "${mention.raw}"` : null;
}

const root = fileURLToPath(new URL("..", import.meta.url));
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "tests") continue;
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

it("shows the PM, the specialists and the tools' own texts only call shapes that exist in the schemas", async () => {
  const { published, shapes } = await start();
  const surfaces: Array<[string, string]> = [
    ["the PM prompt", LANE_PILOT_PM_SESSION],
    ...Object.entries(BB_AGENT_SESSIONS).map(([id, prompt]): [string, string] => [`the ${id} prompt`, prompt]),
    ...published.map((tool): [string, string] => [`${tool.name} text`, `${tool.description}\n${tool.instructions ?? ""}`]),
  ];
  const wrong = surfaces.flatMap(([origin, text]) => mentionsIn(text, true).map((mention) => problem(mention, shapes)).filter(Boolean).map((message) => `${origin}: ${message}`));
  expect(wrong).toEqual([]);
});

it("keeps every call shape written in the sources (next texts of the phase and the router, hints, notices) true to the schemas", async () => {
  const { shapes } = await start();
  const wrong: string[] = [];
  for (const file of sources(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const mention of mentionsIn(text, false)) {
      const message = problem(mention, shapes);
      if (message) wrong.push(`${file.slice(root.length)}: ${message}`);
    }
  }
  expect(wrong).toEqual([]);
});

/** The tools the PM's list folded into family actions, by their old names (src/rooms/tools/pm-tool-families.ts). */
const FOLDED = Object.values(PM_TOOL_FAMILIES).flatMap((family) => Object.values(family.actions) as string[]);

it("names no folded tool by its old name in a text the PM or the architect reads (a next step, a notice, a hint)", () => {
  // Skipped: the tools' own description and instructions (the family rewrites them when it mounts), the architect's session text (rewritten
  // the same way when it is exported), the allow-lists and the presentation table.
  const skip = /(native-session-hooks|tool-presentation|pm-tool-families|native-hook-sources|sma-map\/|workflow\/workflow-architect\.ts)/;
  const wrong: string[] = [];
  for (const file of sources(join(root, "src"))) {
    if (skip.test(file)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (/^(\/\/|\*|\/\*)/.test(trimmed) || /^(description|instructions|name)\s*:/.test(trimmed)) return;
      const prose = trimmed.replace(/\/\/ .*$/, "").replace(/(["'])lane_pilot_[a-z_]+\1/g, "");
      for (const name of FOLDED) if (new RegExp(`\\b${name}\\b(?!_)`).test(prose)) wrong.push(`${file.slice(root.length)}:${index + 1} names ${name}: ${trimmed.slice(0, 120)}`);
    });
  }
  expect(wrong).toEqual([]);
});

it("keeps the old names of folded tools out of the descriptions and instructions of the tools the PM keeps by name", async () => {
  const { published } = await start();
  const own = new Set(Object.keys(PM_TOOL_FAMILIES));
  const wrong = published
    .filter((tool) => !own.has(tool.name) && !FOLDED.includes(tool.name) && tool.name !== "lane_pilot_tool_search")
    .flatMap((tool) => FOLDED.filter((name) => new RegExp(`\\b${name}\\b(?!_)`).test(`${tool.description}\n${tool.instructions ?? ""}`)).map((name) => `${tool.name} names ${name}`));
  expect(wrong).toEqual([]);
});

it("shows the PM no folded tool by its old name in the family instructions either", async () => {
  const { published } = await start();
  const wrong = published.filter((tool) => tool.name in PM_TOOL_FAMILIES)
    .flatMap((tool) => FOLDED.filter((name) => new RegExp(`\\b${name}\\b(?!_)`).test(`${tool.description}\n${tool.instructions ?? ""}`)).map((name) => `${tool.name} names ${name}`));
  expect(wrong).toEqual([]);
});
