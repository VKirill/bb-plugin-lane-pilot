import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/storage/database";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { registerAgentRoutineActions } from "../../src/rooms/schedule/server/schedule-agent-actions";
import { agentHistoryBlock, agentOutcomeOf, handOverTrailer, parseAgentOutcome, parseHandOver, renderAgentOutcome } from "../../src/rooms/schedule/outcome";
import { createScheduleStore } from "../../src/rooms/schedule/store";
import { addSchedule, createClock } from "./harness";

/**
 * The graph a schedule of kind agent runs (workflows/agent-routine.json) through the real engine: the brief step and the outcome step are the
 * real code steps, the agent's own step is a scripted answer (its thread is tested with the chain executors and the plugin).
 */
const PROJECT = "p1";
const answer = (extra: Record<string, unknown> = {}) => ({ report: "Looked at 12 queries.", summary: "3 queries fell out of the top 10", decision: "queued a title test", follow_ups: "re-check on Monday", code_change: "", urgent: false, status: "done", blocked_reason: "", handoff: "done", ...extra });
const change = "Add the canonical tag to the /pricing template: it omits it, so two URLs compete.";

function world(options: { pm?: boolean; agent?: Record<string, unknown>; handOver?: (args: Record<string, any>) => Promise<any> } = {}) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const handOvers: Array<Record<string, any>> = [];
  const pm = options.pm === false ? null : { pmThreadId: "thr_pm", runId: "lprun_1" };
  const services = {
    workflowTriggers: { pmOf: async () => pm },
    phaseIntake: { handOver: async (args: Record<string, any>) => { handOvers.push(args); return options.handOver ? options.handOver(args) : { started: true, via: "issue-quick", id: `wfrun_${handOvers.length}` }; } },
  } as never;
  const ctx = { db, bb: { log: { warn: vi.fn() } } } as never;
  const engine = new WorkflowEngine({ db, harnessVersion: "test" });
  registerPureActions(engine);
  let scripted = options.agent ?? answer();
  const seen: Array<Record<string, unknown>> = [];
  engine.register("agent", { reentrant: true, run: async (c: { node: { id: string; role: string; prompt: string }; render: (text: string) => string }) => { seen.push({ role: c.render(c.node.role), prompt: c.render(c.node.prompt) }); return { output: scripted }; } } as never);
  registerAgentRoutineActions(engine, ctx, services);
  const clock = createClock(Date.UTC(2026, 9, 26, 5));
  const schedule = addSchedule(db, clock, { task: { kind: "agent", agentId: "seo-specialist", task: "Check the positions.", authorized: false, accounts: [], historyRuns: 5 } as never, name: "Positions", when: { type: "cron", cron: "0 9 * * 1", timezone: "UTC" } });
  const store = createScheduleStore(db, clock.now);
  const inputs = (extra: Record<string, unknown> = {}) => ({ agentId: "seo-specialist", task: "Check the positions of the main queries.", history: "", memory: "", authorized: false, accounts: [], historyRuns: 5,
    scheduleName: "Positions", scheduleId: schedule.id, scheduleRunId: "srun_now", runKey: "key-1", scheduledAt: Date.UTC(2026, 9, 26, 6), model: "", reasoning: "", serviceTier: "default", ...extra });
  const run = async (extra: Record<string, unknown> = {}) => {
    const started = engine.start({ workflow: builtinWorkflow("agent-routine")!, inputs: inputs(extra), runtime: { ctx, services, pmThreadId: pm?.pmThreadId ?? null, projectId: PROJECT, runId: pm?.runId ?? null, origin: "schedule" } as never, key: String(extra.runKey ?? "key-1"), link: { projectId: PROJECT, ...(pm ? { runId: pm.runId } : {}) } });
    return await started.done;
  };
  const ownerItems = () => db.prepare("SELECT key,source,kind,project_id,what,why,wake FROM lane_pilot_owner_item ORDER BY created_at, key").all() as Array<Record<string, any>>;
  return { db, engine, run, handOvers, ownerItems, seen, store, schedule, setAgent: (next: Record<string, unknown>) => { scripted = next; } };
}

describe("the routine graph of a scheduled agent", () => {
  it("is a built-in chain that passes the validator, takes its role from the input, and ends in the outcome", () => {
    const routine = builtinWorkflow("agent-routine")!;
    expect(routine).toMatchObject({ id: "agent-routine", status: "published" });
    expect(routine.nodes.find((node) => node.id === "work")).toMatchObject({ type: "agent", role: "specialist:{{$inputs.agentId}}" });
    expect(routine.nodes.map((node) => node.id)).toEqual(["brief", "work", "outcome", "done"]);
  });

  it("runs the agent step as the named agent with the brief as its prompt, keeps the outcome as the report and posts one quiet line on the owner's list", async () => {
    const w = world();
    const summary = await w.run({ history: "- 2026-10-19T06:00Z · succeeded\n  summary: earlier", memory: "the site is on Yandex Webmaster" });
    expect(summary).toMatchObject({ status: "succeeded", output: { status: "done", blocked_reason: "", urgent: false } });
    expect(w.seen[0]).toMatchObject({ role: "specialist:seo-specialist" });
    const prompt = String(w.seen[0]!.prompt);
    expect(prompt).toContain("This is a scheduled run of «Positions»");
    expect(prompt).toContain("<standing_task>\nCheck the positions of the main queries.\n</standing_task>");
    expect(prompt).toContain("<previous_runs>\n- 2026-10-19T06:00Z · succeeded\n  summary: earlier\n</previous_runs>");
    expect(prompt).toContain("<project_memory>\nthe site is on Yandex Webmaster\n</project_memory>");
    expect(prompt).toContain("Lane Pilot takes that text as a request of its own");
    expect(prompt).not.toContain("OUTCOME\nsummary:");
    const report = String((summary.output as { report: string }).report);
    expect(report).toContain("Looked at 12 queries.");
    expect(parseAgentOutcome(report)).toMatchObject({ summary: "3 queries fell out of the top 10", decision: "queued a title test", followUps: "re-check on Monday", status: "done" });
    expect(w.ownerItems()).toEqual([{ key: "schedule-agent:key-1", source: "schedule", kind: "agent_outcome", project_id: PROJECT, what: "«Positions» (seo-specialist): 3 queries fell out of the top 10", why: expect.stringContaining("Решение: queued a title test"), wake: 0 }]);
  });

  it("wakes the owner when the agent says urgent, and records a blocked agent as blocked with its reason", async () => {
    const urgent = world({ agent: answer({ urgent: true }) });
    await urgent.run();
    expect(urgent.ownerItems()[0]).toMatchObject({ kind: "agent_outcome", wake: 1 });
    const stuck = world({ agent: answer({ status: "blocked", blocked_reason: "Webmaster login expired" }) });
    const summary = await stuck.run();
    expect(summary.output).toMatchObject({ status: "blocked", blocked_reason: "Webmaster login expired" });
    expect(stuck.ownerItems()[0]).toMatchObject({ kind: "agent_blocked", why: expect.stringContaining("Агент остановился: Webmaster login expired.") });
  });

  it("hands a code change to Lane Pilot's intake once, marks the report with it, and tells the owner", async () => {
    const w = world({ agent: answer({ code_change: change }) });
    const summary = await w.run();
    expect(w.handOvers).toHaveLength(1);
    expect(w.handOvers[0]).toMatchObject({ projectId: PROJECT, pmThreadId: "thr_pm", runId: "lprun_1", text: change, key: "schedule:key-1" });
    expect(w.handOvers[0]!.origin).toMatch(/seo-specialist.*«Positions».*source: schedule/);
    const report = String((summary.output as { report: string }).report);
    expect(parseHandOver(report)).toEqual({ via: "issue-quick", id: "wfrun_1" });
    expect(report).toContain(handOverTrailer("issue-quick", "wfrun_1"));
    expect(w.ownerItems()[0]!.why).toContain("Передано Lane Pilot (issue-quick wfrun_1)");
  });

  it("does not hand over the same change again when the run before did, and says so on the list", async () => {
    const w = world({ agent: answer({ code_change: change }) });
    const first = store(w, `OUTCOME\nsummary: x\ncode-change: ${change}\n\n${handOverTrailer("phase", "ph_1")}`);
    expect(first).toBeDefined();
    await w.run();
    expect(w.handOvers).toEqual([]);
    expect(w.ownerItems()[0]!.why).toContain("та же правка");
  });

  it("starts nothing without Lane Pilot in the project; the owner's line carries the change and the brief says nothing builds it", async () => {
    const w = world({ pm: false, agent: answer({ code_change: change }) });
    const summary = await w.run();
    expect(summary.status).toBe("succeeded");
    expect(w.handOvers).toEqual([]);
    expect(String((summary.output as { report: string }).report)).not.toContain("HAND-OVER");
    expect(w.ownerItems()).toHaveLength(1);
    expect(w.ownerItems()[0]!.why).toContain("Нужна правка кода");
    expect(w.ownerItems()[0]!.why).toContain(change);
    expect(w.ownerItems()[0]!.why).toContain("нет Lane Pilot");
    expect(String(w.seen[0]!.prompt)).toContain("This project does not use Lane Pilot");
  });

  it("keeps the line when the road refuses or fails, and does not mark the report", async () => {
    const refused = world({ agent: answer({ code_change: change }), handOver: async () => ({ started: false, kind: "question", reason: "the text reads as question, not as work to build" }) });
    expect((await refused.run()).output).toMatchObject({ status: "done" });
    expect(refused.ownerItems()[0]!.why).toContain("Lane Pilot её не взял: the text reads as question");
    const broken = world({ agent: answer({ code_change: change }), handOver: async () => { throw new Error("boom"); } });
    expect((await broken.run()).status).toBe("succeeded");
    expect(broken.ownerItems()[0]!.why).toContain("передача не удалась: boom");
  });

  it("posts one line per run, however often the step is repeated", async () => {
    const w = world();
    await w.run();
    await w.run({ runKey: "key-1" });
    expect(w.ownerItems()).toHaveLength(1);
  });
});

/** A finished run of the schedule with this output, so that the next one finds it as «the run before». */
function store(w: ReturnType<typeof world>, output: string) {
  const row = w.store.addRun({ scheduleId: w.schedule.id, runKey: "before", scheduledAt: Date.UTC(2026, 9, 19, 6), trigger: "tick" }).run;
  w.store.claim(row.id, Date.UTC(2026, 9, 19, 7));
  w.store.finish(row.id, "succeeded", { output });
  return row.id;
}

describe("the outcome as fields and as text", () => {
  it("is built from the agent's typed fields: none-words are empty, blocked needs a reason, and the text reads back the same", () => {
    const outcome = agentOutcomeOf({ summary: "found it", decision: "none", follow_ups: "Nothing", code_change: "n/a", urgent: "yes", status: "blocked", blocked_reason: "" });
    expect(outcome).toEqual({ summary: "found it", decision: "", followUps: "", codeChange: "", urgent: true, status: "blocked", blockedReason: "blocked without a reason" });
    expect(parseAgentOutcome(renderAgentOutcome(outcome))).toEqual(outcome);
    const done = agentOutcomeOf({ summary: "ok", decision: "queued a test", follow_ups: "re-check", code_change: change, urgent: false, status: "done" });
    expect(parseAgentOutcome(renderAgentOutcome(done))).toEqual(done);
    expect(agentOutcomeOf({}).summary).toBe("no summary given");
  });

  it("is what the next run's history lists", () => {
    const text = `Findings.\n\n${renderAgentOutcome(agentOutcomeOf(answer({ code_change: change })))}\n\n${handOverTrailer("phase", "ph_2")}`;
    const block = agentHistoryBlock([{ scheduled_at: Date.UTC(2026, 9, 26, 6), status: "succeeded", output: text, error: null, reason: null }]);
    expect(block).toContain("summary: 3 queries fell out of the top 10");
    expect(block).toContain("handed over to Lane Pilot: phase ph_2");
  });
});
