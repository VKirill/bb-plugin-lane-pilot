import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { NATIVE_LP_BRIDGE_ARCHITECT_TOOLS, NATIVE_LP_BRIDGE_PM_TOOLS, NATIVE_LP_BRIDGE_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { PM_CORE_TOOLS, PM_TOOL_FAMILIES, foldedToolCall, foldedToolHome, rewriteFoldedToolNames } from "../src/rooms/tools/pm-tool-families";

// A compiled Claude Code profile holds at most 64 tools; the PM had 39 Lane Pilot tools next to 24 stock ones (audit round 4, P2-24).
describe("the PM's folded tool list", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  const start = async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    return harness;
  };
  const ctx = { threadId: "pm-thread", projectId: "project-a" };

  it("is core tools, five families, the schedule and the search: at most 30, all registered, none twice", async () => {
    const harness = await start();
    const registered = harness.registrations.agentTools.map((tool) => tool.name);
    expect(NATIVE_LP_BRIDGE_PM_TOOLS.length).toBeLessThanOrEqual(30);
    expect(new Set(NATIVE_LP_BRIDGE_PM_TOOLS).size).toBe(NATIVE_LP_BRIDGE_PM_TOOLS.length);
    expect([...NATIVE_LP_BRIDGE_PM_TOOLS].sort()).toEqual([...PM_CORE_TOOLS, ...Object.keys(PM_TOOL_FAMILIES), "lane_pilot_schedule", "lane_pilot_tool_search"].sort());
    for (const name of NATIVE_LP_BRIDGE_PM_TOOLS) expect(registered, name).toContain(name);
    for (const name of NATIVE_LP_BRIDGE_TOOLS) expect(registered, name).toContain(name);
    // The old handlers stay registered under their old names for the roles that still name them.
    for (const name of NATIVE_LP_BRIDGE_ARCHITECT_TOOLS) expect(registered, name).toContain(name);
    for (const family of Object.values(PM_TOOL_FAMILIES)) for (const old of Object.values(family.actions)) {
      expect(registered, old).toContain(old);
      expect(NATIVE_LP_BRIDGE_PM_TOOLS as readonly string[], old).not.toContain(old);
    }
  });

  it("keeps every family's instructions under the family cap and names the actions in the description", async () => {
    const harness = await start();
    for (const [name, family] of Object.entries(PM_TOOL_FAMILIES)) {
      const tool = harness.registrations.agentTools.find((row) => row.name === name)!;
      expect(tool.instructions!.length, name).toBeLessThanOrEqual(4000);
      for (const action of Object.keys(family.actions)) {
        expect(tool.description, `${name} ${action}`).toContain(action);
        expect(tool.instructions, `${name} ${action}`).toContain(`action "${action}"`);
      }
      expect(JSON.stringify(tool.inputSchema)).toContain('"action"');
    }
  });

  // BB keeps only `type: object` of a top-level union, so the schema the bridge gets must be one flat object.
  it("publishes each family as one flat object: the action enum and every argument, with no top-level union", async () => {
    const harness = await start();
    for (const [name, family] of Object.entries(PM_TOOL_FAMILIES)) {
      const schema = harness.registrations.agentTools.find((row) => row.name === name)!.inputSchema as Record<string, any>;
      expect(schema.type, name).toBe("object");
      expect(schema.oneOf, name).toBeUndefined();
      expect(schema.anyOf, name).toBeUndefined();
      expect(schema.properties.action.enum, name).toEqual(Object.keys(family.actions));
    }
    const helpers = harness.registrations.agentTools.find((row) => row.name === "lane_pilot_helpers")!.inputSchema as Record<string, any>;
    expect(Object.keys(helpers.properties)).toEqual(expect.arrayContaining(["runId", "envClass", "cases", "url"]));
    const relay = harness.registrations.agentTools.find((row) => row.name === "lane_pilot_relay")!.inputSchema as Record<string, any>;
    expect(Object.keys(relay.properties)).toEqual(expect.arrayContaining(["note", "taskIds", "inMinutes"]));
  });

  it("lists each action's required arguments in the family instructions, generated from the schema", async () => {
    const harness = await start();
    const instructions = (name: string) => harness.registrations.agentTools.find((row) => row.name === name)!.instructions!;
    expect(instructions("lane_pilot_helpers")).toContain('action "browser_qa": Required: runId (string), taskId (string), url (string), cases (array), envClass (local|staging|preview|production|unknown).');
    expect(instructions("lane_pilot_relay")).toContain('action "list": No required argument.');
  });

  it("says where browser_qa's runId comes from and what envClass means", async () => {
    const harness = await start();
    const browserQa = harness.registrations.agentTools.find((row) => row.name === "lane_pilot_browser_qa")!;
    expect(browserQa.instructions).toContain("runId is this PM thread's Lane Pilot run id (lprun_");
    expect(browserQa.instructions).toContain("envClass says what the URL is: local");
  });

  it("refuses a browser_qa call without runId or envClass, naming both with their types", async () => {
    const harness = await start();
    const call = (args: Record<string, unknown>) => harness.behavior.callAgentTool("lane_pilot_helpers", args, ctx);
    await expect(call({ action: "browser_qa", taskId: "t1", url: "https://example.com", cases: ["home renders"] }))
      .rejects.toThrow("lane_pilot_helpers browser_qa needs: runId (string), envClass (local|staging|preview|production|unknown)");
  });

  it("names the action that owns an argument sent to another action", async () => {
    const harness = await start();
    const call = (name: string, args: Record<string, unknown>) => harness.behavior.callAgentTool(name, args, ctx);
    await expect(call("lane_pilot_relay", { action: "list", inMinutes: 5 })).rejects.toThrow("lane_pilot_relay list does not take inMinutes (an argument of remind)");
    await expect(call("lane_pilot_memory", { action: "context", query: "x", inMinutes: 5 })).rejects.toThrow('Unrecognized key: "inMinutes"');
  });

  it("hands a list sent as JSON text to browser_qa as the list", async () => {
    const harness = await start();
    const outcome = async (cases: unknown) => {
      try { return String(await harness.behavior.callAgentTool("lane_pilot_helpers", { action: "browser_qa", runId: "lprun_1", taskId: "t1", url: "https://example.com", cases, envClass: "staging" }, ctx)); } catch (cause) { return String(cause); }
    };
    const asText = await outcome('["home renders"]');
    expect(asText).not.toMatch(/expected array|Invalid arguments|arguments are invalid/i);
    expect(asText).toBe(await outcome(["home renders"]));
  });

  it("runs the old handler with the old arguments: the same answer as the old tool", async () => {
    const harness = await start();
    const call = async (name: string, args: Record<string, unknown>) => String(await harness.behavior.callAgentTool(name, args, ctx));
    expect(await call("lane_pilot_workflow_draft", { action: "get" })).toBe(await call("lane_pilot_workflow_draft_get", {}));
    expect(await call("lane_pilot_relay", { action: "list" })).toBe(await call("lane_pilot_relay_list", {}));
  });

  it("takes a number or a list sent as text (the live PM sent inMinutes:\"45\" and taskIds:\"[...]\" on 2026-10-08)", async () => {
    const harness = await start();
    const outcome = async (args: Record<string, unknown>) => {
      try { return String(await harness.behavior.callAgentTool("lane_pilot_relay", args, ctx)); } catch (cause) { return String(cause); }
    };
    const asText = await outcome({ action: "remind", inMinutes: "45", note: "check the task", taskIds: '["metrika-fix"]' });
    expect(asText).not.toMatch(/expected number|expected array|Invalid arguments/i);
    expect(asText).toBe(await outcome({ action: "remind", inMinutes: 45, note: "check the task", taskIds: ["metrika-fix"] }));
    // Text that is not the field's type is still refused.
    expect(await outcome({ action: "remind", inMinutes: "soon", note: "x" })).toMatch(/invalid/i);
  });

  it("refuses an unknown action and an argument that belongs to another action, as the old tools refused unknown arguments", async () => {
    const harness = await start();
    const call = (name: string, args: Record<string, unknown>) => harness.behavior.callAgentTool(name, args, ctx);
    await expect(call("lane_pilot_relay", { action: "nope" })).rejects.toThrow(/invalid/);
    await expect(call("lane_pilot_relay", { action: "list", inMinutes: 5 })).rejects.toThrow(/invalid/);
    await expect(call("lane_pilot_relay", { action: "remind", inMinutes: 5 })).rejects.toThrow(/invalid/);
  });

  it("finds a capability by words and by an old tool name, with its family, action and argument schema", async () => {
    const harness = await start();
    const search = async (query: string) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_tool_search", { query }, ctx))) as { matches: Array<{ tool: string; action?: string; formerName?: string; arguments: { properties?: Record<string, unknown> } }> };
    const remind = await search("set a reminder for later");
    expect(remind.matches[0]).toMatchObject({ tool: "lane_pilot_relay", action: "remind", formerName: "lane_pilot_remind" });
    expect(Object.keys(remind.matches[0]!.arguments.properties!)).toEqual(expect.arrayContaining(["inMinutes", "note", "taskIds"]));
    const lesson = await search("mcp__bb-bridge__lane_pilot_lesson");
    expect(lesson.matches[0]).toMatchObject({ tool: "lane_pilot_memory", action: "lesson" });
    expect((await search("council")).matches.map((match) => match.tool)).toContain("lane_pilot_council");
    expect((await search("dispatch")).matches[0]).toMatchObject({ tool: "lane_pilot_dispatch_writer" });
    const none = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_tool_search", { query: "zzzqqq" }, ctx))) as { matches: unknown[]; available: string[] };
    expect(none.matches).toEqual([]);
    expect(none.available).toContain("lane_pilot_relay:remind");
  });

  it("tells where an old name lives and rewrites old names in a text", () => {
    expect(foldedToolHome("lane_pilot_council_say")).toEqual({ tool: "lane_pilot_council", action: "say" });
    expect(foldedToolHome("lane_pilot_dispatch_writer")).toBeUndefined();
    expect(foldedToolCall("lane_pilot_remind")).toBe('lane_pilot_relay {action:"remind"}');
    expect(rewriteFoldedToolNames("set lane_pilot_remind, then lane_pilot_wait_writer, see lane_pilot_workflow_draft_* tools"))
      .toBe('set lane_pilot_relay {action:"remind"}, then lane_pilot_wait_writer, see lane_pilot_workflow_draft tools');
  });
});
