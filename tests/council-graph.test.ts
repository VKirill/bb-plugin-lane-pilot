import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine, registerPureActions, validateWorkflow } from "@lane-pilot/workflow-engine";
import { ROOM_TURN_CAP, maxTurnsOf } from "@lane-pilot/council";
import { listHandoffs } from "@lane-pilot/handoff";
import plugin from "../server";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/rooms/storage/database";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";

/**
 * The council as a graph (workflows/council.json): the real plugin, the real engine and journal, BB's threads and files as doubles.
 * The Council office reads the two council tables; the PM tools keep their names and replies.
 */
const projectId = "council-graph-project";
const pmThreadId = "council-graph-pm";
const runId = "council-graph-run";
const workspace = "/tmp/council-graph-workspace";
const QUESTION = "Как поднять повторные покупки в кабинете?";

const agendaJson = JSON.stringify({ agenda: ["Where do buyers stop?", "What do the queries ask for?"], criteria: ["effect on sales", "simplicity"] });
const decisionJson = JSON.stringify({
  summary: "Buyers stop at payment.",
  options: [{ title: "Guest checkout", expectedImpact: "faster first purchase", effort: "low", confidence: "high", evidence: ["PROJECT.md"] }],
  recommendation: "Ship guest checkout first.",
  dissent: [{ seat: "Skeptic", point: "Refund risk." }],
  experiments: [{ hypothesis: "Guest checkout raises first purchases", metric: "first-purchase rate" }],
  nextTasks: [{ title: "Guest checkout", objective: "Let a visitor buy without an account.", acceptance: ["No account form before payment"], toAgent: "writer" }],
});

type Answer = (meta: Record<string, any>, prompt: string) => string;
const defaultAnswer: Answer = (meta) => {
  const round = Number(meta.round);
  if (meta.seatId === "chair") return round === 0 ? agendaJson : decisionJson;
  if (round === 1) return `${String(meta.seatId)}: position on payment and saved projects.`;
  return meta.seatId === "skeptic" ? `The evidence is thin (round ${round}).` : "PASS";
};

let current: { dispose: () => Promise<void> } | null = null;
afterEach(async () => { await current?.dispose(); current = null; });

function world(options: { answer?: Answer; hold?: (meta: Record<string, any>) => boolean } = {}) {
  const state = {
    spawned: [] as Array<Record<string, any>>, stopped: [] as string[], sends: [] as string[], written: new Map<string, string>(),
    held: new Set<string>(), meta: new Map<string, Record<string, any>>(), prompts: new Map<string, string>(),
  };
  const answer = options.answer ?? defaultAnswer;
  const created = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : state.meta.get(threadId) ?? {},
        spawn: async (args) => {
          const request = args as unknown as Record<string, any>;
          state.spawned.push(request);
          const id = `seat-${state.spawned.length}`;
          state.meta.set(id, request.pluginMetadata ?? {});
          state.prompts.set(id, String(request.prompt));
          if (options.hold?.(request.pluginMetadata ?? {})) state.held.add(id);
          return { id };
        },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }),
        events: { list: async ({ threadId }) => state.held.has(threadId)
          ? [{ type: "turn/started", threadId, seq: 1 }]
          : [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        output: async ({ threadId }) => ({ output: answer(state.meta.get(threadId) ?? {}, state.prompts.get(threadId) ?? "") }),
        stop: async ({ threadId }) => { state.stopped.push(threadId); return { ok: true } as never; },
        send: async (args: unknown) => { state.sends.push((args as { input: Array<{ text?: string }> }).input[0]?.text ?? ""); },
        list: async () => [...state.meta.keys()].map((id) => ({ id })) as never,
      },
      providers: {
        list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }] as never,
        models: async () => ({ models: [] }) as never,
      },
      files: {
        read: async ({ path }: { path: string }) => ({ content: path.endsWith("PROJECT.md") ? "A photo cabinet; account is required before payment." : null }) as never,
        write: async ({ path, content }: { path: string; content: string }) => { state.written.set(path, content); return { ok: true } as never; },
      },
    },
  });
  let live = created;
  const view = {
    get bb() { return live.bb; }, get harness() { return live.harness; },
    get db() { return openDatabase(live.bb); },
    call: async (name: string, params: Record<string, unknown>) => JSON.parse(String(await live.harness.behavior.callAgentTool(name, params, { threadId: pmThreadId, projectId }))) as Record<string, any>,
    rpc: async (name: string, params: Record<string, unknown>) => await live.harness.behavior.callRpc(name, params) as Record<string, any>,
    /** The plugin after a reload: a new host and a new engine on the same database; the startup recovery resumes the runs that were cut off. */
    reload: async () => {
      live = await live.harness.reload(plugin);
      live.harness.runService("startup-recovery");
    },
  };
  current = { dispose: async () => { await live.harness.lifecycle.dispose(); } };
  return { state, view };
}

async function boot(w: ReturnType<typeof world>, settings: Record<string, string> = {}) {
  await plugin(w.view.bb);
  const db = w.view.db;
  savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId);
  setRunThread(db, runId, pmThreadId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => unknown | Promise<unknown>, what: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) { if (await check()) return; await sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}
const ended = (state: string) => ["done", "failed", "stopped"].includes(state);
const feedOf = (view: Record<string, any>) => (view.messages as Array<{ seatId: string; kind: string; round: number; text: string }>);
const wfRuns = (db: ReturnType<typeof openDatabase>) => db.prepare("SELECT id, workflow_id, status, idem_key, link_run_id, reason FROM lane_pilot_wf_run WHERE workflow_id='council'").all() as Array<{ id: string; workflow_id: string; status: string; idem_key: string; link_run_id: string; reason: string | null }>;

describe("the council graph", () => {
  it("is a starter graph (offered to no one) that passes the validator, with loops bounded by the room's turn cap", () => {
    const council = builtinWorkflow("council")!;
    expect(council).toMatchObject({ id: "council", startedBy: "lane_pilot_council", status: "published" });
    expect(council.nodes.map((node) => node.id)).toEqual(["open", "agenda", "next", "speak", "chair", "decide", "done"]);
    expect(validateWorkflow(council).filter((problem) => problem.level === "error")).toEqual([]);
    const visits = (id: string) => (council.nodes.find((node) => node.id === id) as { maxVisits?: number }).maxVisits!;
    // `next` runs once more than `speak`; the room takes at most ROOM_TURN_CAP turns, rounds mode rounds x seats (6 x 6).
    expect(visits("speak")).toBeGreaterThanOrEqual(ROOM_TURN_CAP);
    expect(visits("next")).toBeGreaterThanOrEqual(ROOM_TURN_CAP + 1);
    expect(Math.max(visits("speak"), visits("next"))).toBeLessThanOrEqual(50);
    expect(maxTurnsOf({ maxRounds: 6, seats: Array.from({ length: 6 }, () => ({}) as never) })).toBe(36);
  });

  it("a loop that never ends stops at the visit bound of the graph, not at the end of time", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: (id) => builtinWorkflow(id) });
    registerPureActions(engine);
    let nextVisits = 0, speakVisits = 0;
    engine.register("council.open", { reentrant: true, run: async () => ({ output: { council_id: "c", seats: ["a"], chair_provider: "p", chair_model: "m", chair_effort: "high", host_id: "h", workspace: "/w" } }) });
    engine.register("council.next", { reentrant: true, run: async () => { nextVisits += 1; return { output: { done: false, seat: "a", round: 2, reason: "x" } }; } });
    engine.register("lp.council-turn", { reentrant: true, run: async (c) => {
      if (c.nodeId === "speak") speakVisits += 1;
      return { output: c.nodeId === "agenda" ? { agenda: ["q"], criteria: ["c"], thread_id: "t", handoff: "h" } : { seat: "a", passed: false, thread_id: "t", handoff: "h" } };
    } });
    engine.register("council.decide", { reentrant: true, run: async () => ({ output: { decision_path: "x", handoffs: 0 } }) });
    const started = engine.start({ workflow: builtinWorkflow("council")!, inputs: { question: "q" }, key: "council:bounds" });
    const summary = await started.done;
    expect(summary.status).toBe("failed");
    expect(summary.reason ?? summary.error ?? "").toMatch(/maxVisits/);
    expect(speakVisits).toBeLessThanOrEqual(50);
    expect(nextVisits).toBeLessThanOrEqual(50);
    expect(speakVisits).toBeGreaterThan(40);
  });

  it("a fixed-round council is a run of the graph: seats keep their models, the chair takes the council row of the role table, the page and handoffs are written", async () => {
    const w = world();
    await boot(w, { "plan_critique.provider": "codex", "plan_critique.model": "m2", "council.skeptic.provider": "openrouter", "council.skeptic.model": "deepseek/deepseek-r2", "council.skeptic.reasoning_effort": "medium" });
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], materials: ["materials/direct.csv"], maxRounds: 3, mode: "rounds", judge: false });
    expect(started).toMatchObject({ state: "agenda", wfRunId: expect.stringMatching(/^wfrun_/) });
    expect(started.seats.map((seat: { id: string; model: string }) => `${seat.id}:${seat.model}`)).toEqual(["product:m2", "skeptic:deepseek/deepseek-r2"]);

    let view: Record<string, any> = started;
    await until(async () => { view = await w.view.call("lane_pilot_council_status", { runId, councilId: started.id }); return ended(view.state) && view.decisionPath; }, "the decision page");
    expect(view).toMatchObject({ state: "done", reason: null, wfRunId: started.wfRunId });
    expect(feedOf(view).map((m) => `${m.seatId}:${m.kind}:${m.round}`)).toEqual([
      "owner:owner:0", "chair:agenda:0", "product:position:1", "skeptic:position:1", "moderator:status:1",
      "product:status:2", "skeptic:reply:2", "moderator:status:2", "chair:decision:4",
    ]);

    const db = w.view.db;
    expect(wfRuns(db)).toEqual([expect.objectContaining({ id: started.wfRunId, status: "succeeded", idem_key: `council:${started.id}`, link_run_id: runId })]);
    const path = db.prepare("SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? AND state='succeeded' ORDER BY rowid").all(started.wfRunId) as Array<{ node_id: string }>;
    expect(path.map((row) => row.node_id)).toEqual(["open", "agenda", "next", "speak", "next", "speak", "next", "speak", "next", "speak", "next", "chair", "decide", "done"]);

    // Every helper is a step of the graph run, quiet for the PM; seats run on their own models, agenda and decision on the chair's.
    for (const request of w.state.spawned) expect(request.pluginMetadata).toMatchObject({ role: "council-seat", lanePilotWorkflowRunId: started.wfRunId, councilId: started.id, parentPmThreadId: pmThreadId });
    const by = (seatId: string, round: number) => w.state.spawned.find((request) => request.pluginMetadata.seatId === seatId && request.pluginMetadata.round === round)!;
    expect(by("skeptic", 1)).toMatchObject({ providerId: "openrouter", model: "deepseek/deepseek-r2" });
    expect(by("product", 1)).toMatchObject({ providerId: "codex", model: "m2" });
    expect(by("chair", 0)).toMatchObject({ model: "gpt-6.1-sol" });
    expect(by("chair", 4)).toMatchObject({ model: "gpt-6.1-sol" });
    expect(String(w.state.spawned[1]!.prompt)).toContain("A photo cabinet");
    expect(String(w.state.spawned[1]!.prompt)).toContain("Material: materials/direct.csv\n(unreadable)");

    expect(view.decisionPath).toMatch(/^docs\/decisions\/\d{4}-\d{2}-\d{2}-council-/);
    expect(w.state.written.get(`${workspace}/${view.decisionPath}`)).toContain("## Recommendation");
    expect(listHandoffs(db, { projectId, runId }).map((item) => `${item.card.fromAgent}>${item.card.toAgent}:${item.card.title}`)).toEqual(["council>writer:Guest checkout"]);
    // The PM hears the decision once, from the `decide` step; the graph's own end notice is not a second one.
    await until(() => w.state.sends.some((text) => text.includes("decided")), "the decision notice");
    await sleep(100);
    expect(w.state.sends.filter((text) => text.includes(started.id))).toHaveLength(1);
  });

  it("the Council office reads the same shape: get_council, list_councils, defaults", async () => {
    const w = world();
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 2, mode: "rounds", judge: false });
    await until(async () => ended((await w.view.rpc("get_council", { councilId: started.id })).state), "the end");
    const detail = await w.view.rpc("get_council", { councilId: started.id });
    expect(Object.keys(detail).sort()).toEqual(["agenda", "criteria", "decisionPath", "id", "maxRounds", "messages", "question", "reason", "recommendation", "round", "seats", "speaking", "speakingSince", "state"]);
    expect(detail).toMatchObject({ id: started.id, state: "done", recommendation: "Ship guest checkout first.", speaking: null, speakingSince: null });
    expect(Object.keys(detail.seats[0]).sort()).toEqual(["id", "model", "providerId", "title"]);
    expect(Object.keys(detail.messages[0]).sort()).toEqual(["at", "kind", "round", "seatId", "seq", "text"]);
    const listed = await w.view.rpc("list_councils", { projectId });
    expect(listed.councils).toEqual([expect.objectContaining({ id: started.id, runId, state: "done", maxRounds: 2 })]);
    expect(Object.keys(listed.councils[0]).sort()).toEqual(["decisionPath", "id", "maxRounds", "question", "round", "runId", "state", "updatedAt"]);
    expect((await w.view.rpc("get_council_defaults", { projectId })).seats.map((seat: { id: string }) => seat.id)).toContain("chair");
  });

  it("the owner's words are picked up: the room waits for them, and the seat they name answers with them in its prompt", async () => {
    const w = world({ answer: (meta, prompt) => {
      const round = Number(meta.round);
      if (meta.seatId === "chair") return round === 0 ? agendaJson : decisionJson;
      if (round === 1) return meta.seatId === "skeptic" ? "Skeptic: opening. Product director, what evidence do you have?" : "Product director: opening position.";
      if (meta.seatId === "product" && prompt.includes("what evidence do you have")) return "Here is the evidence: 12 of 40 queries.";
      if (meta.seatId === "skeptic" && prompt.includes("Что с ценами")) return "On prices: thin evidence, agree with the owner.";
      return "PASS";
    } });
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 3, judge: false });
    const status = () => w.view.call("lane_pilot_council_status", { runId, councilId: started.id });
    await until(async () => feedOf(await status()).some((m) => m.text.includes("waiting for the owner")), "the room to wait for the owner");
    const said = await w.view.call("lane_pilot_council_say", { runId, councilId: started.id, text: "Что с ценами? Скептик, ответь." });
    expect(said.said.seq).toBeGreaterThan(0);
    await until(async () => feedOf(await status()).some((m) => m.text.includes("On prices")), "the skeptic to answer the owner");
    const trail = feedOf(await status()).map((m) => `${m.seatId}:${m.kind}`);
    expect(trail[trail.indexOf("owner:owner", 1) + 2]).toBe("skeptic:reply");
    const skeptic = w.state.spawned.filter((request) => request.pluginMetadata.seatId === "skeptic").at(-1)!;
    expect(String(skeptic.prompt)).toContain("Что с ценами? Скептик, ответь.");
  });

  it("a request for the decision ends the talk after the turn; the chair decides and the council is done", async () => {
    const w = world();
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 3, judge: false });
    const status = () => w.view.call("lane_pilot_council_status", { runId, councilId: started.id });
    await until(async () => feedOf(await status()).some((m) => m.text.includes("waiting for the owner") || m.kind === "reply"), "a turn in the room");
    expect(await w.view.rpc("council_say", { councilId: started.id, decide: true })).toMatchObject({ decideRequested: true });
    let view: Record<string, any> = {};
    await until(async () => { view = await status(); return view.state === "done"; }, "the decision");
    expect(feedOf(view).filter((m) => m.text.includes("The owner asked for the decision."))).toHaveLength(1);
    expect(view.decision.recommendation).toBe("Ship guest checkout first.");
    expect(wfRuns(w.view.db)).toEqual([expect.objectContaining({ status: "succeeded" })]);
  });

  it("stopping cancels the graph run, stops the seat on the floor and ends the session as stopped with no decision", async () => {
    const w = world({ hold: (meta) => meta.seatId === "skeptic" && meta.round === 1 });
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 3, mode: "rounds", judge: false });
    await until(() => w.state.held.size === 1, "the skeptic on the floor");
    const stopped = await w.view.call("lane_pilot_council_stop", { runId, councilId: started.id });
    expect(stopped).toMatchObject({ stopRequested: true });
    await until(() => w.state.stopped.length > 0, "the seat thread to be stopped");
    expect(w.state.stopped).toEqual([[...w.state.held][0]]);
    const view = await w.view.call("lane_pilot_council_status", { runId, councilId: started.id });
    expect(view).toMatchObject({ state: "stopped", reason: "stopped by the owner", decision: null, decisionPath: null });
    expect(wfRuns(w.view.db)).toEqual([expect.objectContaining({ status: "canceled" })]);
    expect(w.state.written.size).toBe(0);
    // Stopped is final: a late word is refused and the session is not moved to failed by the step that was cut.
    await sleep(150);
    expect((await w.view.rpc("get_council", { councilId: started.id })).state).toBe("stopped");
  });

  it("a plugin reload in the middle of a council resumes it: no second thread for the turn on the floor, and it ends with the decision", async () => {
    const w = world({ hold: (meta) => meta.seatId === "skeptic" && meta.round === 1 });
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 2, mode: "rounds", judge: false });
    await until(() => w.state.held.size === 1, "the skeptic on the floor");
    const spawnedBefore = w.state.spawned.length;
    expect(feedOf(await w.view.call("lane_pilot_council_status", { runId, councilId: started.id })).map((m) => `${m.seatId}:${m.kind}`)).toEqual(["owner:owner", "chair:agenda", "product:position"]);

    await w.view.reload();
    // The seat finishes while the plugin is away or coming back.
    w.state.held.clear();
    let view: Record<string, any> = {};
    await until(async () => { view = await w.view.call("lane_pilot_council_status", { runId, councilId: started.id }); return view.state === "done" && view.decisionPath; }, "the resumed council to decide");
    expect(view.reason).toBeNull();
    expect(feedOf(view).filter((m) => m.seatId === "skeptic" && m.kind === "position")).toHaveLength(1);
    expect(feedOf(view).filter((m) => m.seatId === "product" && m.kind === "position")).toHaveLength(1);
    // The held turn was not spawned again; only the turns that had not started yet were.
    expect(w.state.spawned.filter((request) => request.pluginMetadata.seatId === "skeptic" && request.pluginMetadata.round === 1)).toHaveLength(1);
    expect(w.state.spawned.length).toBeGreaterThan(spawnedBefore);
    expect(wfRuns(w.view.db)).toEqual([expect.objectContaining({ id: started.wfRunId, status: "succeeded" })]);
    expect(listHandoffs(w.view.db, { projectId, runId })).toHaveLength(1);
  });

  it("a session an earlier version was driving in memory (no graph run) is closed as failed at start, not left looking alive", async () => {
    const w = world();
    await boot(w);
    const db = w.view.db;
    db.prepare(`INSERT INTO lane_pilot_council(id,project_id,run_id,question,agenda_json,criteria_json,seats_json,state,round,max_rounds,created_at,updated_at)
      VALUES ('cncl_legacy',?,?,'old question','[]','[]','[]','discussion',1,3,1,1)`).run(projectId, runId);
    await w.view.reload();
    expect(await w.view.rpc("get_council", { councilId: "cncl_legacy" })).toMatchObject({ state: "failed", reason: expect.stringContaining("plugin reload") });
  });

  it("an unusable agenda fails the council with the reason in the feed, and the PM is told by the run's end notice", async () => {
    const w = world({ answer: () => "no agenda here" });
    await boot(w);
    const started = await w.view.call("lane_pilot_council_start", { runId, question: QUESTION, roles: ["product", "skeptic"], maxRounds: 2, mode: "rounds", judge: false });
    let view: Record<string, any> = {};
    await until(async () => { view = await w.view.call("lane_pilot_council_status", { runId, councilId: started.id }); return view.state === "failed"; }, "the failure");
    expect(view.reason).toContain("no JSON object");
    expect(feedOf(view).at(-1)).toMatchObject({ seatId: "moderator", kind: "status", text: expect.stringContaining("Failed: ") });
    expect(wfRuns(w.view.db)).toEqual([expect.objectContaining({ status: "failed" })]);
    await until(() => w.state.sends.some((text) => text.includes("council") && text.includes("failed")), "the end notice");
    expect(w.state.sends.find((text) => text.includes("failed"))).toContain("lane_pilot_council_status");
  });
});
