import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { registeredTools } from "../src/rooms/core/server";
import { PM_TOOL_FAMILIES } from "../src/rooms/tools/pm-tool-families";

// Live phase ph_86fd9d3fab, 2026-10-27: the PM called lane_pilot_phase revise twice before it learned the call takes goal and note.
// BB shows a model only `type: object` of a top-level union, so the instructions must say what each action takes, and a refusal must too.

/** BB refuses a tool whose instructions are longer than this. */
const BB_INSTRUCTIONS_MAX = 4096;

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

async function start() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  return { harness, book: registeredTools(bb.agents) };
}

type Published = { name: string; instructions?: string; inputSchema: Record<string, any> };

/** The fields an action must get, read from the zod schema the tool was registered with (a union option, or a family member's tool). */
function requiredOf(original: z.ZodType, action: string, family?: Record<string, string>, book?: ReadonlyMap<string, { parameters: z.ZodType }>): string[] {
  const object = family
    ? book!.get(family[action]!)!.parameters as z.ZodObject
    : ((original as any)._zod.def.options as z.ZodObject[]).find((option) => (option.shape.action as any)._zod.def.values[0] === action)!;
  return Object.entries(object.shape).filter(([key, field]) => key !== "action" && !(field as z.ZodType).safeParse(undefined).success).map(([key]) => key);
}

it("keeps the instructions of every registered tool within what BB accepts", async () => {
  const { harness } = await start();
  for (const tool of harness.registrations.agentTools as Published[]) {
    expect((tool.instructions ?? "").length, `${tool.name} instructions`).toBeLessThanOrEqual(BB_INSTRUCTIONS_MAX);
  }
});

it("names every action of every action tool with all its required fields, generated from the schema", async () => {
  const { harness, book } = await start();
  const published = harness.registrations.agentTools as Published[];
  const actionTools = published.filter((tool) => tool.inputSchema.properties?.action?.enum || tool.inputSchema.oneOf);
  expect(actionTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["lane_pilot_phase", "lane_pilot_schedule", "lane_pilot_queue", "lane_pilot_check", "lane_pilot_forge", ...Object.keys(PM_TOOL_FAMILIES)]));
  for (const tool of actionTools) {
    // BB keeps only `type: object` of a top-level union: every action tool must publish one flat object.
    expect(tool.inputSchema.type, tool.name).toBe("object");
    expect(tool.inputSchema.oneOf, tool.name).toBeUndefined();
    const family = (PM_TOOL_FAMILIES as Record<string, { actions: Record<string, string> }>)[tool.name]?.actions;
    const actions: string[] = family ? Object.keys(family) : ((book.get(tool.name)!.parameters as any)._zod.def.options as z.ZodObject[]).map((option) => (option.shape.action as any)._zod.def.values[0]);
    expect(tool.inputSchema.properties.action.enum, tool.name).toEqual(expect.arrayContaining(actions));
    for (const action of actions) {
      const required = requiredOf(book.get(tool.name)!.parameters, action, family, book);
      const line = (tool.instructions ?? "").split("\n").find((row) => new RegExp(`(^|[\\s"-])${action} \\{`).test(row) || row.includes(`${action} {`));
      expect(line, `${tool.name} ${action} has a signature line`).toBeDefined();
      const braces = (tool.instructions ?? "").match(new RegExp(`\\b${action} \\{([^}]*)\\}`))?.[1] ?? "";
      for (const field of required) expect(braces, `${tool.name} ${action} names ${field}`).toMatch(new RegExp(`(^|[\\s,])${field}(:|,|$)`));
    }
  }
});

it("writes the revise signature of lane_pilot_phase with its required fields and marks optional ones", async () => {
  const { harness } = await start();
  const instructions = (harness.registrations.agentTools as Published[]).find((tool) => tool.name === "lane_pilot_phase")!.instructions!;
  expect(instructions).toContain("revise {phaseId, goal, note}");
  expect(instructions).toContain("status {phaseId?}");
  expect(instructions).toContain("return {phaseId, to: discussion|planning|design|execution, note}");
});

it("refuses a phase revise without goal or note by naming what revise needs", async () => {
  const { harness } = await start();
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("lane_pilot_phase", args, { threadId: "pm-thread", projectId: "project-a" });
  await expect(call({ action: "revise", phaseId: "ph_1" })).rejects.toThrow("lane_pilot_phase revise needs: goal (string), note (string)");
  await expect(call({ action: "revise", phaseId: "ph_1", goal: "g" })).rejects.toThrow("lane_pilot_phase revise needs: note (string)");
  await expect(call({ action: "return", phaseId: "ph_1", note: "n" })).rejects.toThrow("lane_pilot_phase return needs: to (discussion|planning|design|execution)");
});

it("names the action that owns an argument sent to another action of a union tool", async () => {
  const { harness } = await start();
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("lane_pilot_phase", args, { threadId: "pm-thread", projectId: "project-a" });
  await expect(call({ action: "pause", phaseId: "ph_1", goal: "x" })).rejects.toThrow("lane_pilot_phase pause does not take goal (an argument of open)");
});

it("hands a union tool's handler the same value the union parses: defaults kept, JSON text for a list read", async () => {
  const { harness } = await start();
  const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("lane_pilot_queue", args, { threadId: "pm-thread", projectId: "project-a" });
  // The handler needs a PM thread the fake host does not have; what matters is that the list sent as text passes and the failure comes from the handler.
  expect(String(await call({ action: "hold", taskIds: '["a","b"]' }))).toContain("getPluginMetadata");
  await expect(call({ action: "hold" })).rejects.toThrow("lane_pilot_queue hold needs: taskIds (array)");
});
