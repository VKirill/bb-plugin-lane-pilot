import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { foreignTurnReason, ownerTurnGate } from "../src/rooms/core/server/owner-turn";
import { registerObservedTool, registeredTools, setWorkStartGate, type ObservedToolContext } from "../src/rooms/core/server/tool-result";

// 2026-11-01: a PM chat in a subfolder told the repository root's PM to dispatch the owner's tasks with `bb thread tell`, and it did.
const context: ObservedToolContext = { threadId: "thr_pm", projectId: "proj_1", signal: new AbortController().signal };
const turnFrom = (senderThreadId: string | null) => ({ data: { initiator: senderThreadId ? "agent" : "user", senderThreadId } });

describe("foreignTurnReason", () => {
  it("lets the owner's own turn and Lane Pilot's own helper threads through", () => {
    expect(foreignTurnReason(turnFrom(null), null, "lane_pilot_dispatch_writer")).toBeNull();
    expect(foreignTurnReason(null, null, "lane_pilot_dispatch_writer")).toBeNull();
    expect(foreignTurnReason(turnFrom("thr_writer"), { originPluginId: "lane-pilot" }, "lane_pilot_dispatch_writer")).toBeNull();
  });

  it("refuses a turn another chat started, naming the sender and the way out", () => {
    const reason = foreignTurnReason(turnFrom("thr_other_pm"), { originPluginId: null }, "lane_pilot_dispatch_writer");
    expect(reason).toContain("thr_other_pm");
    expect(reason).toContain("not the owner's order");
    // A sender BB cannot show any more is still not the owner.
    expect(foreignTurnReason(turnFrom("thr_gone"), null, "lane_pilot_errand")).toContain("thr_gone");
  });
});

describe("ownerTurnGate", () => {
  it("reads the last turn of the calling thread and the sender's origin, in either list shape", async () => {
    const calls: unknown[] = [];
    const sdkOf = (listed: unknown, sender: unknown) => ({ sdk: { threads: {
      events: { list: async (query: unknown) => { calls.push(query); return listed; } },
      get: async () => sender,
    } } });
    expect(await ownerTurnGate(sdkOf([turnFrom("thr_x")], { originPluginId: null }))(context, "t")).toContain("thr_x");
    expect(await ownerTurnGate(sdkOf({ events: [turnFrom("thr_x")] }, { originPluginId: "lane-pilot" }))(context, "t")).toBeNull();
    expect(await ownerTurnGate(sdkOf([turnFrom(null)], null))(context, "t")).toBeNull();
    expect(calls[0]).toMatchObject({ threadId: "thr_pm", types: ["client/turn/requested"], order: "desc" });
  });

  it("lets the call through when the hub read fails", async () => {
    const broken = { sdk: { threads: { events: { list: async () => { throw new Error("hub down"); } }, get: async () => null } } };
    expect(await ownerTurnGate(broken)(context, "t")).toBeNull();
    // A host without the events API at all (test fakes, an older hub) is the same: through.
    expect(await ownerTurnGate({ sdk: { threads: {} } } as never)(context, "t")).toBeNull();
  });
});

describe("registerObservedTool with startsWork", () => {
  afterEach(() => setWorkStartGate(null));

  function fakeAgents() {
    const published = new Map<string, { execute: (params: unknown, context: ObservedToolContext) => Promise<unknown> }>();
    return { published, registerTool: (tool: { name: string; execute: (params: unknown, context: ObservedToolContext) => Promise<unknown> }) => { published.set(tool.name, tool); } };
  }

  it("refuses a work-starting tool in a foreign turn on both the direct path and the family book, and leaves other tools alone", async () => {
    setWorkStartGate(async (_context, toolName) => `${toolName} refused: foreign turn`);
    const agents = fakeAgents();
    const ran: string[] = [];
    registerObservedTool(agents, { name: "lane_pilot_dispatch_writer", description: "d", parameters: z.object({}).strict(), startsWork: true, execute: async () => { ran.push("dispatch"); return "ok"; } });
    registerObservedTool(agents, { name: "lane_pilot_facts", description: "d", parameters: z.object({}).strict(), execute: async () => { ran.push("facts"); return "ok"; } });
    const direct = JSON.parse(String(await agents.published.get("lane_pilot_dispatch_writer")!.execute({}, context))) as { ok: boolean; error: { code: string } };
    expect(direct).toMatchObject({ ok: false, error: { code: "not_owner_turn" } });
    await expect(registeredTools(agents).get("lane_pilot_dispatch_writer")!.execute({}, context)).rejects.toThrow(/foreign turn/);
    expect(await agents.published.get("lane_pilot_facts")!.execute({}, context)).toBe("ok");
    expect(ran).toEqual(["facts"]);
  });

  it("runs the tool when the gate is quiet or not installed", async () => {
    const agents = fakeAgents();
    registerObservedTool(agents, { name: "lane_pilot_errand", description: "d", parameters: z.object({}).strict(), startsWork: true, execute: async () => "started" });
    expect(await agents.published.get("lane_pilot_errand")!.execute({}, context)).toBe("started");
    setWorkStartGate(async () => null);
    expect(await agents.published.get("lane_pilot_errand")!.execute({}, context)).toBe("started");
  });
});
