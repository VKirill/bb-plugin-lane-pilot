// Region 9 · Person and window, batch c (n814 … n849), the server halves and the pure registries. Each test checks the result the card names (what was written,
// sent or refused), not that a function was called. The screens that press these doors are rendered in jsdom by four-proofs-r09-c.test.tsx.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import { forgeToolParameters, mountForge } from "../../src/rooms/forge/server";
import { registeredTools } from "../../src/rooms/platform/server/tool-result";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { tokenDailyByModel } from "../../src/rooms/usage/server";
import { createFromDraft, proposeDraft } from "../../src/rooms/tasks/server/draft";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import { SCREENS, screenFor, searchCockpit, startScreen, unusedReads } from "../../src/rooms/cockpit/ui/registry";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";

type Rpc = Record<string, (input: never) => Promise<unknown>>;
const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" } as never); return { bb, harness, db: openDatabase(bb) }; };
/** The cockpit's own server table on a scratch database; `threads.send` is recorded, never sent. */
function cockpit() {
  const { bb, harness, db } = open();
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  harness.sdk.stub("threads.send", async (input: { threadId: string; mode: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, mode: input.mode, text: input.input[0]!.text }); return {}; });
  const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, {} as never) as unknown as Rpc;
  return { bb, db, sent, rpc, harness };
}

describe("region 9 · the owner's queue and requests (the cockpit's server half)", () => {
  it("[sma:d_enqueue] «a new task» from the window goes to the project's PM as one queued message that carries the owner's text; with no PM chat open nothing is sent and the window is told why", async () => {
    const { db, sent, rpc } = cockpit();
    createRun(db, "r1", "p1", "bb", "/ws");
    createRun(db, "r2", "p2", "bb", "/ws2");
    await expect(rpc.cockpit_request({ projectId: "p1", kind: "task", text: "Fix the footer\n\nIt overlaps the cart" } as never)).rejects.toThrow("no Lane Pilot PM chat is open in this project");
    expect(sent).toEqual([]);
    setRunThread(db, "r1", "thr_pm1");
    setRunThread(db, "r2", "thr_pm2");
    expect(await rpc.cockpit_request({ projectId: "p1", kind: "task", text: "Fix the footer\n\nIt overlaps the cart" } as never)).toEqual({ sent: true, pmThreadId: "thr_pm1" });
    expect(sent).toEqual([{ threadId: "thr_pm1", mode: "queue-if-active", text: "[Lane Pilot window] The owner asks for a new task:\nFix the footer\n\nIt overlaps the cart" }]);
    // A batch says «one per line», not «a new task»: the PM reads the kind from the lead.
    await rpc.cockpit_request({ projectId: "p2", kind: "batch", text: "a: one\na: two" } as never);
    expect(sent[1]).toEqual({ threadId: "thr_pm2", mode: "queue-if-active", text: "[Lane Pilot window] The owner asks for a new batch of tasks (one per line):\na: one\na: two" });
  });

  it("[sma:d_forge] an order from the forge goes to the project's PM naming the kind and the name, carries the brief, and carries the owner's own text only inside owner_text tags when he wrote one", async () => {
    const { db, sent, rpc } = cockpit();
    createRun(db, "r1", "p1", "bb", "/ws");
    await expect(rpc.cockpit_forge_order({ projectId: "p1", kind: "role", name: "fixer", brief: "b".repeat(30) } as never)).rejects.toThrow("no Lane Pilot PM chat is open in this project");
    setRunThread(db, "r1", "thr_pm1");
    expect(await rpc.cockpit_forge_order({ projectId: "p1", kind: "role", name: "fixer", brief: "Fixes one red check for the catalog." } as never)).toEqual({ ordered: true, pmThreadId: "thr_pm1" });
    expect(sent[0]).toEqual({ threadId: "thr_pm1", mode: "queue-if-active", text: '[Lane Pilot window] The owner orders from the forge: a role «fixer». Run lane_pilot_forge {action:"draft", kind:"role", name:"fixer", brief} with this brief: Fixes one red check for the catalog.' });
    await rpc.cockpit_forge_order({ projectId: "p1", kind: "skill", name: "lazy-images", brief: "Lazy-load product photos please.", body: "Use loading=lazy." } as never);
    expect(sent[1]!.text).toContain("brief: Lazy-load product photos please. The owner wrote the text himself");
    expect(sent[1]!.text).toContain("<owner_text>\nUse loading=lazy.\n</owner_text>");
    expect(sent[0]!.text).not.toContain("owner_text");
  });

  it("[sma:d_backlog_promote] «promote a backlog item» goes to the PM as its own request, the item's words kept, in the project of the window and in no other", async () => {
    const { db, sent, rpc } = cockpit();
    createRun(db, "r1", "p1", "bb", "/ws");
    createRun(db, "r2", "p2", "bb", "/ws2");
    setRunThread(db, "r1", "thr_pm1");
    setRunThread(db, "r2", "thr_pm2");
    await rpc.cockpit_request({ projectId: "p2", kind: "promote", text: "t-07 the footer fix" } as never);
    expect(sent).toEqual([{ threadId: "thr_pm2", mode: "queue-if-active", text: "[Lane Pilot window] The owner asks for to promote a backlog item to a task:\nt-07 the footer fix" }]);
  });

  it("[sma:d_priority] a priority said for a task rewrites that task's contract priority and nothing else, is read back by the task card, and a task of another run is refused and keeps its priority; hold and release move the held stamp", async () => {
    const { db, rpc } = cockpit();
    createRun(db, "run1", "p1", "bb", "/ws");
    createRun(db, "run2", "p1", "bb", "/ws");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { title: "Fix the form", priority: "low", objective: "keep me" } });
    createTask(db, { id: "t2", runId: "run2", kind: "bb", contract: { title: "Other", priority: "normal" } });
    const card = async (runId: string, taskId: string) => await rpc.cockpit_task({ runId, taskId } as never) as { priority: string; objective: string; heldUntil: number | null };
    expect(await rpc.cockpit_queue({ runId: "run1", taskIds: ["t1"], action: "priority", priority: "urgent" } as never)).toEqual({ changed: ["t1"], refused: [] });
    expect(await card("run1", "t1")).toMatchObject({ priority: "urgent", objective: "keep me" });
    // The same number said again by the same person changes nothing more.
    await rpc.cockpit_queue({ runId: "run1", taskIds: ["t1"], action: "priority", priority: "urgent" } as never);
    expect((await card("run1", "t1")).priority).toBe("urgent");
    expect(await rpc.cockpit_queue({ runId: "run1", taskIds: ["t2"], action: "priority", priority: "high" } as never)).toEqual({ changed: [], refused: [{ taskId: "t2", why: "not a task of run run1" }] });
    expect((await card("run2", "t2")).priority).toBe("normal");
    await rpc.cockpit_queue({ runId: "run1", taskIds: ["t1"], action: "hold" } as never);
    expect((await card("run1", "t1")).heldUntil).toBeGreaterThan(Date.now());
    await rpc.cockpit_queue({ runId: "run1", taskIds: ["t1"], action: "release" } as never);
    expect((await card("run1", "t1")).heldUntil).toBeNull();
  });

  it("[sma:m_sw_visible_time] the window's «seen» report adds one view and the milliseconds a screen stayed in view, a single report is capped at an hour, and the list says per screen how many views and how long", async () => {
    const { rpc } = cockpit();
    await rpc.cockpit_seen({ screen: "today", ms: 1500 } as never);
    await rpc.cockpit_seen({ screen: "today", ms: 2500 } as never);
    await rpc.cockpit_seen({ screen: "money", ms: 99_999_999 } as never);
    const listed = await rpc.cockpit_seen_list({} as never) as { seen: Record<string, { views: number; ms: number; last: number }>; rpcs: string[] };
    expect(listed.seen.today).toMatchObject({ views: 2, ms: 4000 });
    expect(listed.seen.money).toMatchObject({ views: 1, ms: 3_600_000 });
    expect(Object.keys(listed.seen).sort()).toEqual(["money", "today"]);
    expect(listed.rpcs).toContain("cockpit_seen");
  });
});

describe("region 9 · the forge writes a skill", () => {
  const SKILL = "---\nname: lazy-images\ndescription: Lazy-load product photos so switching stays fast. Use when photos load slowly.\n---\nSteps: write the file.\n";
  function forge() {
    const { bb: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(fake);
    createRun(db, "runA", "projA", "bb", "/ws", "none", undefined, "host-1");
    const kv = new Map<string, unknown>();
    const files = new Map<string, string>();
    const hostCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const agents = { registerTool: () => undefined };
    const bb = { agents, storage: { kv: { get: (async (key: string) => kv.get(key)) as never, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
      sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "runA" }) } },
      hosts: { experimental_client: () => ({ call: async (method: string, args: Record<string, unknown>) => { hostCalls.push({ method, args }); return { status: "applied" }; } }) } };
    mountForge({ db, bb } as never, { dispatchWriter: (async () => ({ ok: true })) as never, readWriterWorkspaceFile: (async ({ path }: { path: string }) => ({ content: files.get(path) ?? "" })) as never });
    const tool = registeredTools(agents).get("lane_pilot_forge")!;
    const call = async (input: Record<string, unknown>) => JSON.parse(String(await tool.execute(forgeToolParameters.parse(input) as never, { threadId: "thr_pm", projectId: "projA" } as never)));
    const refused = async (input: Record<string, unknown>) => { try { await call(input); } catch (error) { return (error as Error).message; } return "NOT REFUSED"; };
    return { call, refused, files, hostCalls, kv };
  }

  it("[sma:d_skill_create] a linted skill draft is written as .claude/skills/<name>/SKILL.md with exactly the draft's bytes, only after the request step and with the receipt's bytes; a draft changed after its lint, an unlinted one and an unrequested confirm write nothing", async () => {
    const f = forge();
    const draft = ".agents/forge/skills/lazy-images/SKILL.md";
    expect(await f.refused({ action: "enable", kind: "skill", name: "lazy-images", step: "request" })).toBe("no forge receipt for skill lazy-images: lint it first");
    f.files.set(draft, SKILL);
    const receipt = await f.call({ action: "lint", kind: "skill", name: "lazy-images" });
    expect(receipt).toMatchObject({ ok: true, findings: [], path: draft });
    expect(await f.refused({ action: "enable", kind: "skill", name: "lazy-images", step: "confirm" })).toBe("enabling is two steps: request first, then confirm");
    expect(await f.call({ action: "enable", kind: "skill", name: "lazy-images", step: "request" })).toMatchObject({ requested: true });
    // The draft is edited after its lint: the receipt no longer matches, nothing is written.
    f.files.set(draft, `${SKILL}One more line.\n`);
    expect(await f.refused({ action: "enable", kind: "skill", name: "lazy-images", step: "confirm" })).toBe("the draft changed since its receipt: lint it again");
    expect(f.hostCalls).toEqual([]);
    f.files.set(draft, SKILL);
    expect(await f.call({ action: "enable", kind: "skill", name: "lazy-images", step: "confirm" })).toEqual({ enabled: ".claude/skills/lazy-images/SKILL.md", sha256: receipt.sha256 });
    expect(f.hostCalls).toHaveLength(1);
    expect(f.hostCalls[0]!.method).toBe("writeForgeEnabled");
    expect(f.hostCalls[0]!.args).toMatchObject({ projectCwd: "/ws", edits: [{ path: ".claude/skills/lazy-images/SKILL.md", expectedSha256: null, content: SKILL }] });
    expect(((await f.kv.get("lp.forge.receipts")) as Record<string, { enabledBy?: string }>)["projA:skill:lazy-images"]!.enabledBy).toBe("pm");
  });
});

describe("region 9 · words of a task and the answer's sources", () => {
  it("[sma:d_task_words] a task that ended (accepted or canceled) is never rewritten: the PM's update is refused with «task_finished» and the contract stays; a queued one passes that gate; a started one that is not waiting on the person is refused as started", async () => {
    const { bb, db } = open();
    createRun(db, "run", "proj", "bb", "/ws", "none", undefined, "host-1");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm' WHERE id='run'").run();
    const contract = { schema_version: 2, id: "x", title: "Original", objective: "o" };
    for (const id of ["acc", "can", "que", "run1"]) { createTask(db, { id, runId: "run", kind: "bb", contract }); createAttempt(db, { id: `a-${id}`, runId: "run", taskId: id }); }
    transitionAttempt(db, "a-acc", "accepted", { reason: "ok" });
    transitionAttempt(db, "a-can", "canceled", { reason: "dropped" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr-w' WHERE id='a-run1'").run();
    const ctx = { bb: bb as never, db, state: { disposed: false }, configForRun: async () => null, log: () => undefined } as unknown as ServerCore;
    const { updateTask } = createWriterUpdateTask(ctx, { activeWriterTasks: new Set<string>() } as unknown as Services);
    const words = (taskId: string, extra: Record<string, unknown> = {}) => updateTask({ projectId: "proj", runId: "run", pmThreadId: "pm", taskId, plan: "A rewritten plan", ...extra } as never);
    expect((await words("acc")).error).toMatchObject({ code: "task_finished", retryable: false, sideEffects: "none" });
    expect((await words("can")).error).toMatchObject({ code: "task_finished" });
    expect(((await words("acc")).error as { hint: string }).hint).toBe("task acc ended accepted: its words are final. For new work dispatch a new task.");
    // An unfinished queued task gets past the finished gate (it stops later, here for lack of a configured project).
    expect((await words("que")).error).toMatchObject({ code: "not_configured" });
    // A bare note is not words: on a task that is not running it is refused as such.
    expect((await words("que", { plan: undefined, note: "hurry" })).error).toMatchObject({ code: "task_not_running" });
    // Another run's task is not this PM's to change.
    expect((await updateTask({ projectId: "proj", runId: "run", pmThreadId: "other", taskId: "que", plan: "p" } as never)).error).toMatchObject({ code: "not_pm_thread" });
  });

  it("[sma:m_sw_sources] every answer of lane_pilot_facts names the books it was read from — the run board, the spend book of the day, the finished attempts, the failed attempts — and a free question names none", async () => {
    const { bb, harness } = open();
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "proj");
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { title: "Hud" } });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', reason=NULL WHERE id='a1'").run();
    const day = new Date().toISOString().slice(0, 10);
    registerConversationTools({ db, bb } as never, { spendByModel: (projectId: string, d: string) => tokenDailyByModel(db, projectId, d), phasesOf: () => [{ id: "ph1", title: "P", stage: "plan", state: "active", next: null }] });
    const facts = registeredTools(bb.agents).get("lane_pilot_facts")!;
    const ask = async (question: string) => JSON.parse(String(await facts.execute({ question }, { threadId: "thr", projectId: "proj", signal: new AbortController().signal } as never)));
    expect((await ask("что с задачами")).sources).toEqual(["the run board (lane_pilot_attempt, run run1)"]);
    expect((await ask("сколько токенов")).sources).toEqual([`the spend book (lane_pilot_token_daily, ${day})`]);
    expect((await ask("что было вчера")).sources).toEqual(["the finished attempts (lane_pilot_attempt)"]);
    expect((await ask("почему упало")).sources).toEqual(["the failed attempts and their failure class (lane_pilot_attempt)"]);
    expect((await ask("на каком этапе")).sources).toEqual(["lane_pilot_phase (the live phases of this PM thread)"]);
    const free = await ask("нарисуй схему");
    expect(free.sources).toBeUndefined();
    expect(free).toMatchObject({ kind: "free", facts: null });
  });
});

describe("region 9 · the screen registry and the unit card of the board", () => {
  it("[sma:m_sw_registry] the window's screens are the fourteen of the registry in order, only coordination wants a wide window, an event opens the screen it belongs to, an unknown path is the placeholder, and a never-set-up project opens the first run once", () => {
    expect(SCREENS.map((screen) => screen.id)).toEqual(["home", "phases", "today", "tasks", "money", "workers", "forge", "memory", "firstrun", "coord", "ship", "system", "rules", "registry"]);
    expect(SCREENS.filter((screen) => screen.wide).map((screen) => screen.id)).toEqual(["coord"]);
    expect(new Set(SCREENS.map((screen) => screen.id)).size).toBe(SCREENS.length);
    expect(screenFor("")).toEqual({ id: "home", param: null });
    expect(screenFor("/phases/ph7")).toEqual({ id: "phases", param: "ph7" });
    expect(screenFor("event/uat")).toEqual({ id: "phases", param: null });
    expect(screenFor("event/claim")).toEqual({ id: "coord", param: null });
    expect(screenFor("event/nothing")).toEqual({ id: "building", param: "nothing" });
    expect(screenFor("elsewhere")).toEqual({ id: "building", param: "elsewhere" });
    expect(startScreen("", { needed: true })).toBe("firstrun");
    expect(startScreen("", { needed: false })).toBe("home");
    expect(startScreen("money", { needed: true })).toBe("money");
    // The palette: screens by event words first, then the project's phases and tasks; an empty query lists every screen.
    expect(searchCockpit("").map((hit) => hit.id)).toEqual(SCREENS.map((screen) => screen.id));
    expect(searchCockpit("claim", { phases: [{ id: "claim-ph", title: "Claim phase" }], tasks: [{ id: "t9", title: "claims" }] }).map((hit) => `${hit.kind}:${hit.id}`)).toEqual(["screen:coord", "phase:claim-ph", "task:t9"]);
    expect(unusedReads(["phase_list", "money_status", "get_foo", "save_setting"], ["phase_list"])).toEqual(["money_status", "get_foo"]);
  });

  it("[sma:m_sw_unit_card] a proposed batch is one card on the board — queued while proposed, blocked with «not created: n of m» when part failed, done when all were created — and its members appear as their own cards only after the owner creates them", async () => {
    const { db } = open();
    createRun(db, "run1", "proj", "bb", "/ws");
    const contracts = [{ id: "a" }, { id: "b" }];
    const proposed = proposeDraft(db, { runId: "run1", projectId: "proj", threadId: "thr_pm", kind: "batch", contracts, objective: "Ship the footer" });
    const cardOf = (id: string) => buildTaskBoard(db, { projectId: "proj", doneSince: 0 }, []).find((item) => item.key === `batch:${id}`);
    expect(cardOf(proposed.id)).toMatchObject({ kind: "batch", column: "queued", phase: "queued", state: "proposed", title: "Ship the footer", pmThreadId: "thr_pm", detail: null });
    expect(buildTaskBoard(db, { projectId: "proj", doneSince: 0 }, []).filter((item) => item.kind === "task")).toEqual([]);
    await createFromDraft(db, proposed.id, async (contract) => ((contract as { id: string }).id === "a" ? { taskId: "t-a" } : { ok: false, reason: "no area" }));
    expect(cardOf(proposed.id)).toMatchObject({ column: "blocked", phase: "blocked", state: "partial", detail: "не созданы: 1 из 2" });
    await createFromDraft(db, proposed.id, async () => ({ taskId: "t-b" }));
    expect(cardOf(proposed.id)).toMatchObject({ column: "done", phase: "accepted", state: "created", detail: null });
    // A batch with no words of its own is named by its size.
    const bare = proposeDraft(db, { runId: "run1", projectId: "proj", threadId: "thr_pm", kind: "batch", contracts: [{ id: "x" }, { id: "y" }, { id: "z" }] });
    expect(cardOf(bare.id)!.title).toBe("Пачка из 3 задач");
  });
});
