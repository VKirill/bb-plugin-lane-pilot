import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";
import { listHandoffs } from "@lane-pilot/handoff";

const projectId = "council-project";
const pmThreadId = "council-pm";
const runId = "council-run";
const workspace = "/tmp/council-workspace";

const agendaJson = JSON.stringify({ agenda: ["Where do buyers stop?", "What do the queries ask for?"], criteria: ["effect on sales", "simplicity", "effort"] });
const decisionJson = JSON.stringify({
  summary: "Buyers stop at payment; queries ask for saved projects.",
  options: [{ title: "Guest checkout", expectedImpact: "faster first purchase", effort: "low", confidence: "high", evidence: ["PROJECT.md: account before payment"] }],
  recommendation: "Ship guest checkout first.",
  dissent: [{ seat: "Skeptic", point: "Refund risk." }],
  experiments: [{ hypothesis: "Guest checkout raises first purchases", metric: "first-purchase rate" }],
  nextTasks: [{ title: "Guest checkout", objective: "Let a visitor buy without an account.", acceptance: ["No account form before payment"], toAgent: "writer" }],
});

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("council tools", () => {
  it("runs a council on hidden seat threads, writes the decision page and hands next tasks over", async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const meta = new Map<string, Record<string, unknown>>();
    const written = new Map<string, string>();
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : meta.get(threadId) ?? {},
          spawn: async (args) => {
            const request = args as unknown as Record<string, unknown>;
            spawned.push(request);
            const id = `seat-${spawned.length}`;
            meta.set(id, (request.pluginMetadata as Record<string, unknown>) ?? {});
            return { id };
          },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async ({ threadId }) => {
            const m = meta.get(threadId) ?? {};
            const round = Number(m.round);
            if (m.seatId === "chair") return { output: round === 0 ? "```json\n" + agendaJson + "\n```" : decisionJson };
            if (round === 1) return { output: `${String(m.seatId)}: position on payment and saved projects.` };
            return { output: m.seatId === "skeptic" ? "The saved-projects evidence is thin." : "PASS" };
          },
          stop: async () => ({ ok: true }) as never,
          list: async () => [...meta.keys()].map((id) => ({ id })) as never,
        },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
          models: async () => ({ models: [{ id: "m", model: "m", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }, { reasoningEffort: "high", description: "high" }] }] }) as never,
        },
        files: {
          read: async ({ path }: { path: string }) => ({ content: path.endsWith("PROJECT.md") ? "A photo cabinet; account is required before payment." : null }) as never,
          write: async ({ path, content }: { path: string; content: string }) => { written.set(path, content); return { ok: true } as never; },
        },
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    saveProjectSetting(db, projectId, "plan_critique.provider", "codex");
    saveProjectSetting(db, projectId, "plan_critique.model", "m2");
    saveProjectSetting(db, projectId, "council.skeptic.provider", "openrouter");
    saveProjectSetting(db, projectId, "council.skeptic.model", "deepseek/deepseek-r2");
    saveProjectSetting(db, projectId, "council.skeptic.reasoning_effort", "medium");
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;

    const started = await call("lane_pilot_council_start", { runId, question: "Как поднять повторные покупки в кабинете?", roles: ["product", "skeptic"], materials: ["materials/direct.csv"], maxRounds: 3, mode: "rounds", judge: false });
    expect(started.state).toBe("agenda");
    expect(started.seats.map((seat: { id: string; model: string }) => `${seat.id}:${seat.model}`)).toEqual(["product:m2", "skeptic:deepseek/deepseek-r2"]);

    let view: Record<string, any> = started;
    for (let i = 0; i < 100 && !["done", "failed", "stopped"].includes(view.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      view = await call("lane_pilot_council_status", { runId, councilId: started.id });
    }
    expect(view.reason).toBeNull();
    expect(view.state).toBe("done");
    expect(view.agenda).toHaveLength(2);
    expect(view.decision.recommendation).toBe("Ship guest checkout first.");
    expect(view.messages.map((m: { seatId: string; kind: string; round: number }) => `${m.seatId}:${m.kind}:${m.round}`)).toEqual([
      "owner:owner:0", "chair:agenda:0",
      "product:position:1", "skeptic:position:1", "moderator:status:1",
      "product:status:2", "skeptic:reply:2", "moderator:status:2",
      "chair:decision:4",
    ]);
    expect(spawned.every((request) => (request.pluginMetadata as { role: string }).role === "council-seat")).toBe(true);
    expect(String(spawned[1]!.prompt)).toContain("A photo cabinet");
    expect(String(spawned[1]!.prompt)).toContain("Material: materials/direct.csv\n(unreadable)");

    for (let i = 0; i < 50 && !view.decisionPath; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = await call("lane_pilot_council_status", { runId, councilId: started.id }); }
    expect(view.decisionPath).toMatch(/^docs\/decisions\/\d{4}-\d{2}-\d{2}-council-/);
    expect(written.get(`${workspace}/${view.decisionPath}`)).toContain("## Recommendation");
    const handoffs = listHandoffs(db, { projectId, runId });
    expect(handoffs.map((item) => `${item.card.fromAgent}>${item.card.toAgent}:${item.card.title}`)).toEqual(["council>writer:Guest checkout"]);

    const rpc = await harness.behavior.callRpc("get_council", { councilId: started.id }) as { recommendation: string | null; messages: unknown[] };
    expect(rpc.recommendation).toBe("Ship guest checkout first.");
    expect(rpc.messages).toHaveLength(9);
    const listed = await harness.behavior.callRpc("list_councils", { projectId }) as { councils: Array<{ id: string; state: string }> };
    expect(listed.councils).toEqual([expect.objectContaining({ id: started.id, state: "done" })]);
    expect(await call("lane_pilot_council_stop", { runId, councilId: started.id })).toMatchObject({ state: "done", stopRequested: false });
  });

  it("runs the boardroom: seats speak on impulse, the owner joins by tool and RPC, and the decision comes on request", async () => {
    const meta = new Map<string, Record<string, unknown>>();
    let spawns = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : meta.get(threadId) ?? {},
          spawn: async (args) => { const request = args as unknown as Record<string, unknown>; const id = `room-${++spawns}`; meta.set(id, { ...(request.pluginMetadata as Record<string, unknown>), prompt: String(request.prompt) }); return { id }; },
          get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
          events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
          output: async ({ threadId }) => {
            const m = meta.get(threadId) ?? {};
            const round = Number(m.round); const prompt = String(m.prompt);
            if (m.seatId === "chair") return { output: round === 0 ? agendaJson : decisionJson };
            if (round === 1) return { output: m.seatId === "skeptic" ? "Skeptic: opening. Product director, what evidence do you have?" : "Product director: opening position." };
            if (m.seatId === "product" && prompt.includes("what evidence do you have")) return { output: "Here is the evidence: 12 of 40 queries." };
            if (m.seatId === "skeptic" && prompt.includes("Что с ценами")) return { output: "On prices: thin evidence, agree with the owner." };
            return { output: "PASS" };
          },
          stop: async () => ({ ok: true }) as never,
          list: async () => [...meta.keys()].map((id) => ({ id })) as never,
        },
        providers: { list: async () => [] as never, models: async () => ({ models: [] }) as never },
        files: { read: async () => ({ content: null }) as never, write: async () => ({ ok: true }) as never },
      },
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    createRun(db, runId, projectId);
    setRunThread(db, runId, pmThreadId);
    const call = async (name: string, params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>;

    const started = await call("lane_pilot_council_start", { runId, question: "Как поднять повторные покупки?", roles: ["product", "skeptic"], maxRounds: 3, judge: false });
    const status = async () => call("lane_pilot_council_status", { runId, councilId: started.id });
    let view: Record<string, any> = started;
    for (let i = 0; i < 100 && !(view.messages ?? []).some((m: { seatId: string; kind: string }) => m.seatId === "product" && m.kind === "reply"); i++) { await new Promise((r) => setTimeout(r, 50)); view = await status(); }
    expect(view.messages.map((m: { seatId: string; kind: string }) => `${m.seatId}:${m.kind}`).slice(0, 6)).toEqual(["owner:owner", "chair:agenda", "product:position", "skeptic:position", "moderator:status", "product:reply"]);
    expect(view.messages[4].text).toContain("Floor: Product director (addressed, rule");

    // The room goes quiet and waits for the owner; the owner names the skeptic.
    for (let i = 0; i < 100 && !(view.messages ?? []).some((m: { text: string }) => m.text.includes("waiting for the owner")); i++) { await new Promise((r) => setTimeout(r, 50)); view = await status(); }
    const said = await call("lane_pilot_council_say", { runId, councilId: started.id, text: "Что с ценами? Скептик, ответь." });
    expect(said.said.seq).toBeGreaterThan(0);
    for (let i = 0; i < 100 && !(view.messages ?? []).some((m: { text: string }) => m.text.includes("On prices")); i++) { await new Promise((r) => setTimeout(r, 50)); view = await status(); }
    const trail = view.messages.map((m: { seatId: string; kind: string }) => `${m.seatId}:${m.kind}`);
    expect(trail[trail.indexOf("owner:owner", 1) + 2]).toBe("skeptic:reply");

    const decided = await harness.behavior.callRpc("council_say", { councilId: started.id, decide: true }) as { decideRequested: boolean };
    expect(decided.decideRequested).toBe(true);
    for (let i = 0; i < 200 && view.state !== "done"; i++) { await new Promise((r) => setTimeout(r, 50)); view = await status(); }
    expect(view.state).toBe("done");
    expect(view.decision.recommendation).toBe("Ship guest checkout first.");
    const detail = await harness.behavior.callRpc("get_council", { councilId: started.id }) as { speaking: string | null; messages: Array<{ seatId: string }> };
    expect(detail.speaking).toBeNull();
    expect(detail.messages.filter((m) => m.seatId === "owner")).toHaveLength(2);
  });
});
