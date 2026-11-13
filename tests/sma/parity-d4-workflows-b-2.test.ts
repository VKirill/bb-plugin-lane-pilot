import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { saveProjectSetting } from "../../src/rooms/storage";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors, secretKeyName } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { runSim } from "../workflow/chain-harness";
import type { SimResult } from "../workflow/chain-harness";
import { finding, pathOf } from "../workflow/chain-helpers";
import { parseTodoMeta } from "../../src/rooms/backlog/logic";

const PROJECT = "d4b-project", PM = "d4b-pm", RUN = "d4b-run";
type Row = Record<string, unknown>;

/** The setup of parity d4 b-1, kept local so the real executors (fs.write, lp.*) run against a temp checkout. */
async function setup() {
  const checkout = mkdtempSync(join(tmpdir(), "lp-d4b-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const spawned: Row[] = [], writes: Array<{ path: string; content: string }> = [];
  const nodeOf = new Map<string, string>(), counts = new Map<string, number>();
  let next = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async (args) => { const request = args as unknown as Row; spawned.push(request); const id = `helper-${next += 1}`; nodeOf.set(id, String((request.pluginMetadata as Row).lanePilotWorkflowNode ?? (request.pluginMetadata as Row).role)); return { id }; },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        send: async () => ({}) as never,
        stop: async () => ({ ok: true }) as never,
        output: async () => ({ output: "no script" }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: { write: async (args: unknown) => { const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input); return { ok: true } as never; } },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services), resolveWorkflow: () => null });
  registerPureActions(engine); registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const start = (workflow: Workflow, inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: checkout, encoding: "utf8" });
  const set = (key: string, value: string) => saveProjectSetting(db, PROJECT, key, value);
  return { db, engine, checkout, writes, start, git, set, rt, dispose: () => harness.lifecycle.dispose() };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const wf = (name: string) => parseWorkflow(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", name), "utf8")));
const src = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", name), "utf8")) as { nodes: Array<Row & { id: string; prompt?: string }>, edges: Array<{ from: string; to: string }>, inputs: Record<string, Row> };
const node = (name: string, id: string) => src(name).nodes.find((n) => n.id === id)!;
const actionChain = (action: string, out: Record<string, string>, params?: Row): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4b-chain", name: "D4B", description: { en: "c", ru: "ц" },
  nodes: [{ id: "go", type: "action", action, out, ...(params ? { params } : {}) },
    { id: "done", type: "action", action: "emit", map: Object.fromEntries(Object.keys(out).map((k) => [k, `go.${k}`])) }],
  edges: [{ from: "start", to: "go" }, { from: "go", to: "done" }],
});
/** Agent nodes of an engine run answer from a table by node id (the fake host has no models); every call keeps the prompt as rendered. */
function stubModels(t: { engine: WorkflowEngine }, answers: Record<string, Row>) {
  const seen = new Map<string, number>(), calls: Array<{ node: string; prompt: string }> = [];
  t.engine.register("agent", { reentrant: true, run: async (ctx: { nodeId: string; node: { prompt?: string }; render: (text: string) => string }) => {
    const at = seen.get(ctx.nodeId) ?? 0; seen.set(ctx.nodeId, at + 1); calls.push({ node: ctx.nodeId, prompt: String(ctx.render(ctx.node.prompt ?? "")) });
    return { output: { handoff: `${ctx.nodeId} done`, ...(answers[ctx.nodeId] ?? {}) } };
  } } as never);
  return calls;
}
/** The nodes a real engine run executed, in order (a skipped node is not a visit). */
const executed = (t: { engine: WorkflowEngine }, runId: string) => (t.engine.snapshot(runId)?.steps ?? []).filter((step) => step.state === "succeeded" && !/:(fan|child)$/.test(step.node_id)).map((step) => step.node_id);
const skippedOf = (t: { engine: WorkflowEngine }, runId: string) => (t.engine.snapshot(runId)?.steps ?? []).filter((step) => step.state === "skipped").map((step) => step.node_id);
/** The model, human and task nodes a sim run executed: what costs a model call or a person's answer. */
const costly = (r: SimResult) => r.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id))
  .filter((id) => ["agent", "human", "lp-task", "subworkflow", "parallel"].includes(String(r.workflow.nodes.find((n) => n.id === id)?.type)));
const emitted = (r: SimResult) => r.summary.output as Row;
const commitFile = (t: Awaited<ReturnType<typeof setup>>, path: string, body: string) => {
  mkdirSync(dirname(join(t.checkout, path)), { recursive: true }); writeFileSync(join(t.checkout, path), body);
  t.git("add", "."); t.git("commit", "-q", "-m", path);
};

/** The prompts of project-start on main, word for word: a start that sets nothing new gets exactly these. */
const MAIN_START = {
  value_map: "Value map builder, before asking anything: from README, the passport (project-onboard), the site and the code — who the product is for, the job they hire it for, what they get, how we would know it works. Write .agents/planning/VALUE-MAP.md.",
  preview: "Stack and tests: languages, frameworks, the test command and whether it is green. Memory preview: lane_pilot_memory context (what the hub corpus already knows), the memory graph of notes by area. Infra profile: hosts, start, deploy, logs into lane-plan profile --set (the one profile writer).",
  recap: "Working style and risk from the owner's anamnesis. Recap in five lines, three next steps, and the roadmap skeleton (lane-plan template fill ROADMAP, STATE; phases with lane-plan phase add).",
};
const startStubs = { value_map: { value_map: "v" }, preview: { stack: {}, memory: {} }, recap: { next_steps: ["a", "b", "c"] } };
/** An install with the start research on and a profile on disk (the `ask` is a person's wait on a real engine, so the fixture answers it by having the profile). */
const startOn = (t: Awaited<ReturnType<typeof setup>>) => { t.set("project.start_research", "on"); mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true }); writeFileSync(join(t.checkout, ".agents/planning/PROFILE.md"), "host: h\n"); };
const startFlow = { tree: "tree", probe: "probe", value_map: "value_map", preview: "preview", profile_write: "profile_write", research: "research", requirements: "requirements", recap: "recap", done: "done" };

describe("parity d4 workflows b-2", () => {
  it("[sma:k_c_mssummary] milestone-summary ends done from the milestone artifacts; milestone-close runs it after close only with milestone.summary on", async () => {
    const sim = await runSim("milestone-summary", { input: { milestone: "Stats export" }, stubs: { summary: { summary_path: ".agents/planning/MILESTONE-SUMMARY.md", open_items: [] } } });
    expect(pathOf(sim)).toBe("summary goal_check done");
    expect(emitted(sim)).toMatchObject({ status: "done", summary_path: ".agents/planning/MILESTONE-SUMMARY.md" });
    const prompt = node("milestone-summary.json", "summary").prompt!;
    expect(prompt).toMatch(/ROADMAP\.md.*STATE\.md.*SUMMARY\.md.*UAT\.md.*REVIEW\.md/s);
    // An earlier milestone's summary is never lost: a dated section is added, nothing is overwritten (an agent prompt: it cannot be run here).
    expect(prompt).toMatch(/section headed `## <milestone> — <date>`/);
    expect(prompt).toMatch(/keep every earlier section as it is; never overwrite/);
    const input = { goal: "Stats export", goals: [{ id: "g1", done_when: "d", evidence: "e" }] };
    const status = { open_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, gate_state: "none", unmerged_seen: 0, uncovered_reqs: [] };
    const stubs = { "lp.close": { status: "closed", staged: 0 }, summary: { summary_path: "s.md" } };
    const off = await runSim("milestone-close", { input, stubs: { ...stubs, "lp.run_status": { ...status, milestone_summary: "off" } } });
    expect(pathOf(off)).not.toContain("summary");
    expect(off.called("summary")).toHaveLength(0);
    const on = await runSim("milestone-close", { input, stubs: { ...stubs, "lp.run_status": { ...status, milestone_summary: "on" } } });
    expect(pathOf(on)).toBe("status retro close summary approve_knowledge archive closed");
    expect(on.called("summary")).toHaveLength(1);
  });

  it("[sma:k_c_mssummary] lp.run_status exposes milestone.summary: only the word off is off; unset and any other word are the default, on", async () => {
    const t = await setup(); dispose = t.dispose;
    const read = async () => ((await t.start(actionChain("lp.run_status", { milestone_summary: "string" })).done).output as Row).milestone_summary;
    expect(await read()).toBe("on");
    t.set("milestone.summary", "off"); expect(await read()).toBe("off");
    t.set("milestone.summary", "yes please"); expect(await read()).toBe("on");
    t.set("milestone.summary", "on"); expect(await read()).toBe("on");
  });

  it("[default] milestone-close with today's inputs and settings runs main's model and human nodes, and writes no summary", async () => {
    const r = await runSim("milestone-close", { input: { goal: "Stats export", goals: [{ id: "g1", done_when: "d", evidence: "e" }] },
      stubs: { "lp.run_status": { open_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, gate_state: "none", unmerged_seen: 0, uncovered_reqs: [] }, "lp.close": { status: "closed", staged: 2 } }, humans: { approve_knowledge: { answer_kind: "deferred", approved_ids: [] } } });
    expect(costly(r)).toEqual(["retro", "close", "approve_knowledge"]);
    expect(pathOf(r)).toBe("status retro close approve_knowledge archive closed");
    expect(r.skipped).toEqual([]);
    const open = await runSim("milestone-close", { input: { goal: "Stats export" }, stubs: { "lp.run_status": { open_tasks: 2, unmerged: 0, gate_ok: true, running_attempts: 0, gate_state: "none", unmerged_seen: 0, uncovered_reqs: [] }, "lp.close": { status: "closed", staged: 0 } }, humans: { ask_finish: { answer_kind: "close_anyway" } } });
    expect(pathOf(open)).toBe("status ask_finish retro close approve_knowledge archive closed");
    expect(costly(open)).toEqual(["ask_finish", "retro", "close"]);
  });

  it("[sma:k_pl_project] the retro refreshes PROJECT.md only when it exists; it never creates it", () => {
    const retro = node("milestone-close.json", "retro").prompt!;
    expect(retro).toMatch(/If \.agents\/planning\/PROJECT\.md already exists/);
    expect(retro).toMatch(/only if the file already exists; never create it/);
    expect(retro).not.toMatch(/create the file if missing/);
    // The sentence is an instruction to a model: it cannot be run here; the graph path with it is main's (see the default test).
  });

  it("[sma:k_c_mvp] mvp-phase: a rework verdict loops once to story, a pass emits a story with who, what and why", async () => {
    const story = { who: "owner", what: "sees stats", why: "to decide", slice: "report page", out_of_scope: ["pdf"] };
    const r = await runSim("mvp-phase", { input: { goal: "export stats" }, stubs: { story, split_check: [{ verdict: "rework", notes: "not vertical" }, { verdict: "pass", notes: "ok" }] } });
    expect(pathOf(r)).toBe("story split_check story split_check goal_check done");
    expect(emitted(r)!.story as Row).toMatchObject({ who: "owner", what: "sees stats", why: "to decide" });
    expect(emitted(r)).toMatchObject({ status: "done", goal: "export stats" });
  });

  it("[sma:k_c_note] a note is one write and one confirmation line", async () => {
    const t = await setup(); dispose = t.dispose;
    const summary = await t.start(wf("note-add.json"), { text: "deploy is manual" }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", confirmation: "note saved" });
    const notes = t.writes.filter((w) => w.path.includes(".agents/todos/notes/"));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.path).toMatch(/\.agents\/todos\/notes\/.+\.md$/);
    expect(notes[0]!.content).toContain("deploy is manual");
    expect(String(summary.output!.note_path)).toContain(".agents/todos/notes/");
    expect(pathOf(await runSim("note-add", { input: { text: "x" } }))).toContain("write");
  });

  it("[sma:k_c_listassume] phase-assumptions returns an assumptions array and the graph has no write", async () => {
    const r = await runSim("phase-assumptions", { input: { phase_id: "ph_a" }, stubs: { assumptions: { assumptions: [{ statement: "users table exists", evidence: "db.ts:4", confidence: 80 }] } } });
    expect(pathOf(r)).toBe("assumptions goal_check done");
    expect(emitted(r)).toMatchObject({ status: "done" });
    expect(emitted(r)!.assumptions).toHaveLength(1);
    expect(src("phase-assumptions.json").nodes.every((n) => n.action !== "fs.write")).toBe(true);
  });

  it("[sma:k_c_profileuser] questionnaire reaches record and card without sessions; cancel ends before any write", async () => {
    const q = await runSim("profile-user", { input: {}, stubs: { record: { recorded: 8 }, card: { card: "card" } },
      humans: { consent: { answer_kind: "questionnaire" }, interview: { answer_kind: "answered", answer: "{}" } } });
    expect(pathOf(q)).toBe("consent interview record card done");
    expect(q.called("sessions")).toHaveLength(0);
    const cancel = await runSim("profile-user", { input: {}, humans: { consent: { answer_kind: "cancel" } } });
    expect(pathOf(cancel)).toBe("consent cancelled");
    expect(emitted(cancel)).toMatchObject({ status: "cancelled" });
  });

  it("[default] project-start with project.start_research off runs main's three model nodes with main's prompts, asks nobody, writes nothing and is not sent to resumed", async () => {
    const t = await setup(); dispose = t.dispose;
    t.set("project.start_research", "off");
    const calls = stubModels(t, startStubs);
    const summary = await t.start(wf("project-start.json"), {}).done;
    expect(summary.status).toBe("succeeded");
    expect(executed(t, summary.runId)).toEqual(["tree", "value_map", "preview", "recap", "done"]);
    expect(skippedOf(t, summary.runId)).toEqual(["probe", "profile_write", "ask", "research", "requirements"]);
    expect(calls.map((c) => c.node)).toEqual(["value_map", "preview", "recap"]);
    for (const call of calls) expect(call.prompt.trim()).toBe(MAIN_START[call.node as keyof typeof MAIN_START]);
    expect(summary.output).toMatchObject({ status: "done", next_steps: ["a", "b", "c"] });
    expect(t.writes).toHaveLength(0);
    // An install that has the map, the roadmap and the profile re-runs the start as it always did.
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    for (const file of ["VALUE-MAP.md", "ROADMAP.md", "PROFILE.md"]) writeFileSync(join(t.checkout, ".agents/planning", file), "x\n");
    const again = await t.start(wf("project-start.json"), {}).done;
    expect(executed(t, again.runId)).toEqual(["tree", "value_map", "preview", "recap", "done"]);
    expect(again.output).toMatchObject({ status: "done" });
    // The sim of the same graph: the same model nodes, no human.
    const sim = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "off" }, ...startStubs } });
    expect(costly(sim)).toEqual(["value_map", "preview", "recap"]);
  });

  it("[default] project-start with project.start_research unset is the research start: with no profile on disk it stops at the question to the owner, after the preview and before any research", async () => {
    const t = await setup(); dispose = t.dispose;
    const calls = stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" }, requirements: { requirements: [] } });
    const summary = await t.start(wf("project-start.json"), {}).done;
    expect(summary.status).toBe("waiting");
    expect(executed(t, summary.runId)).toEqual(["tree", "probe", "value_map", "preview", "profile_write"]);
    expect(calls.map((c) => c.node)).toEqual(["value_map", "preview"]);
    // The fresh start seeds the instruction forms (SMA k_d_tpl_instructions) and nothing else, each write create-only:
    // a null hash, which BB answers with a conflict over a file that already exists.
    const seeded = t.writes as Array<{ path: string; expectedSha256?: string | null }>;
    expect(seeded.map((w) => w.path.slice(t.checkout.length + 1)).sort()).toEqual([".agents/planning/PROJECT.md", ".github/copilot-instructions.md", "CLAUDE.md"]);
    expect(seeded.every((w) => w.expectedSha256 === null)).toBe(true);
  });

  it("[sma:k_c_newproject] with project.start_research on the start researches, writes requirements and the roadmap in one flow; quick mode has neither research nor requirements; the person is asked when there is no profile", async () => {
    const t = await setup(); dispose = t.dispose;
    startOn(t);
    const calls = stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: { host: "h1" } }, research: { research_notes: "n" }, requirements: { requirements: ["REQ-1"] } });
    const summary = await t.start(wf("project-start.json"), {}).done;
    expect(summary.status).toBe("succeeded");
    expect(executed(t, summary.runId)).toEqual(Object.values(startFlow).filter((id) => id !== "ask"));
    expect(skippedOf(t, summary.runId)).toEqual(["ask"]);
    expect(calls.map((c) => c.node)).toEqual(["value_map", "preview", "research", "requirements", "recap"]);
    const quick = await t.engine.start({ workflow: wf("project-start.json"), inputs: {}, mode: "quick", runtime: t.rt, link: { projectId: PROJECT, runId: RUN } }).done;
    expect(executed(t, quick.runId)).not.toContain("requirements");
    expect(executed(t, quick.runId)).not.toContain("research");
    expect(skippedOf(t, quick.runId)).toEqual(expect.arrayContaining(["requirements", "research"]));
    // Without a profile the ask is a human node: the sim puts the question to the owner.
    const asked = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "on" }, "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false }, "lp.profile_write": { refused: [], set: [] }, ...startStubs, research: { research_notes: "n" }, requirements: { requirements: [] } }, humans: { ask: { answer_kind: "answered" } } });
    expect(costly(asked)).toEqual(["value_map", "preview", "ask", "research", "requirements", "recap"]);
  });

  it("[sma:k_pl_project] with the switch on the recap writes PROJECT.md (Vision, Value, Limits) and keeps what exists; off it is main's prompt", async () => {
    const t = await setup(); dispose = t.dispose;
    startOn(t);
    const calls = stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" }, requirements: { requirements: [] } });
    const s0 = await t.start(wf("project-start.json"), {}).done;
    expect(s0, JSON.stringify(s0)).toMatchObject({ status: "succeeded" });
    const recap = calls.find((c) => c.node === "recap")!.prompt;
    expect(recap).toContain(MAIN_START.recap);
    expect(recap).toContain(".agents/planning/PROJECT.md");
    expect(recap).toMatch(/Vision, Value and Limits/);
    expect(recap).toMatch(/never overwritten: merge the new text into it keeping what is there, or leave it and write the new text to <name>\.new\.md next to it/);
    expect(recap).toContain("the new text is in <name>.new.md next to it");
    // An agent writes the file: the prompt is what can be checked here; the default run's recap prompt equals main's (the default test).
  });

  it("[sma:k_pl_researchdir] the research node runs before requirements and the recap, names the four files and the recap reads them; its writes never overwrite", async () => {
    const t = await setup(); dispose = t.dispose;
    startOn(t);
    const calls = stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" }, requirements: { requirements: [] } });
    const summary = await t.start(wf("project-start.json"), {}).done;
    const order = executed(t, summary.runId);
    expect(order.indexOf("research")).toBeLessThan(order.indexOf("requirements"));
    expect(order.indexOf("requirements")).toBeLessThan(order.indexOf("recap"));
    const research = calls.find((c) => c.node === "research")!.prompt, recap = calls.find((c) => c.node === "recap")!.prompt;
    for (const file of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) { expect(research).toContain(file); expect(recap).toContain(file); }
    expect(research).toMatch(/never overwritten: merge .*<name>\.new\.md/);
    expect(calls.find((c) => c.node === "requirements")!.prompt).toMatch(/never overwritten: merge .*<name>\.new\.md/);
    // The files are written by the agent, so the merge-or-.new.md rule is a prompt and cannot be run here.
  });

  it("[sma:k_c_secure] secure-phase: an open threat ends in gaps, all mitigated ends in done", async () => {
    const open = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: ["T1"], security_path: ".agents/phases/ph_a/SECURITY.md" } } });
    expect(emitted(open)).toMatchObject({ status: "gaps", open: ["T1"] });
    const clean = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: [], security_path: ".agents/phases/ph_a/SECURITY.md" } } });
    expect(pathOf(clean)).toBe("audit goal_check done");
    expect(emitted(clean)).toMatchObject({ status: "done" });
  });

  it("[sma:k_ag_security] security-audit: without phase_id the fan-out is main's 2/4/6 and threat_model is skipped; with it the threat_model node runs once", async () => {
    const stubs = { recon: { found_entry_points: true } };
    for (const [tier, count] of [["quick", 2], ["standard", 4], ["deep", 6]] as const) {
      const plain = await runSim("security-audit", { input: { tier }, stubs });
      expect(plain.called("scan:child")).toHaveLength(count);
      expect(plain.skipped).toEqual(["threat_model"]);
      expect(plain.called("threat_model")).toHaveLength(0);
      expect(costly(plain)).toEqual(["recon", "scan", "report"]);
    }
    const phase = await runSim("security-audit", { input: { tier: "standard", phase_id: "ph_a" }, stubs: { ...stubs, threat_model: { findings: [finding("high", { evidence: "T3 missing" })] } } });
    expect(phase.called("scan:child")).toHaveLength(4);
    expect(phase.called("threat_model")).toHaveLength(1);
    expect(phase.skipped).toEqual([]);
    expect(pathOf(phase)).toBe("recon scan threat_model report goal_check done");
    const prompt = node("security-audit.json", "threat_model").prompt!;
    expect(prompt).toContain("mitigated|partial|missing");
    expect(prompt).toContain("## Verified against the code");
    expect(prompt).toContain("SECURITY.md");
    // The tier tables are main's, word for word.
    const mainScan = JSON.parse(execFileSync("git", ["show", "main:workflows/security-audit.json"], { encoding: "utf8" })).nodes.find((n: Row) => n.id === "scan");
    expect(node("security-audit.json", "scan")).toEqual(mainScan);
  });

  it("[sma:k_ws_review] ship with review true and a rework verdict is held; with review false it ships", async () => {
    const held = await runSim("ship", { input: { phase_id: "ph_a", review: true }, stubs: { "code-review": { status: "rework" }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" } } });
    expect(emitted(held)).toMatchObject({ status: "held" });
    expect((emitted(held)!.held_by as string[])[0]).toMatch(/review/);
    expect(held.called("open_pr")).toHaveLength(0);
    const shipped = await runSim("ship", { input: { phase_id: "ph_a", review: false }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" }, "lp.post_ship_hooks": { count: 0, files: [] } } });
    expect(emitted(shipped)).toMatchObject({ status: "shipped" });
    expect(shipped.skipped).toContain("review");
  });

  it("[default] ship with today's inputs runs main's two model nodes (preflight, open_pr) and starts no hook session when the repository has no hook files", async () => {
    const r = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" }, "lp.post_ship_hooks": { count: 0, files: [] } } });
    expect(costly(r)).toEqual(["preflight", "open_pr"]);
    expect(r.called("post_ship")).toHaveLength(0);
    expect(r.skipped).toEqual(["review", "post_ship"]);
    expect(emitted(r)).toMatchObject({ status: "shipped", pr_url: "u", hooks_failed: [] });
    // open_pr is main's prompt minus the hook sentence: hooks run in post_ship only, never twice.
    expect(node("ship.json", "open_pr").prompt).not.toMatch(/post-ship|hook/);
    expect(node("ship.json", "post_ship").prompt).toContain("lane-plan render-hooks post-ship");
  });

  it("[sma:k_ws_post] hook files counted on the host decide it: none, no session; some, post_ship runs once and a failed hook is listed without holding the ship", async () => {
    const t = await setup(); dispose = t.dispose;
    const count = async () => ((await t.start(actionChain("lp.post_ship_hooks", { count: "int", files: "string[]" })).done).output as Row);
    expect(await count()).toMatchObject({ count: 0, files: [] });
    mkdirSync(join(t.checkout, ".agents/planning/hooks"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/hooks/notes.md"), "not a hook\n");
    expect(await count()).toMatchObject({ count: 0 });
    writeFileSync(join(t.checkout, ".agents/planning/hooks/post-ship.md"), "run smoke\n");
    writeFileSync(join(t.checkout, ".agents/planning/hooks/post-ship-notify.md"), "tell the channel\n");
    expect(await count()).toMatchObject({ count: 2, files: [".agents/planning/hooks/post-ship-notify.md", ".agents/planning/hooks/post-ship.md"] });
    // The graph, with the hook count the host just gave (two), runs the session once.
    const r = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" }, "lp.post_ship_hooks": { count: 2, files: ["a", "b"] }, post_ship: { hooks_run: ["h1"], hooks_failed: ["h2"] } } });
    expect(r.called("post_ship")).toHaveLength(1);
    expect(r.called("open_pr")).toHaveLength(1);
    expect(pathOf(r)).toBe("gate preflight review open_pr hooks post_ship goal_check shipped");
    expect(emitted(r)).toMatchObject({ status: "shipped", hooks_failed: ["h2"] });
    // What the hook session does with a failed hook is its prompt: listed, never retried blindly.
    expect(node("ship.json", "post_ship").prompt).toMatch(/does not undo the ship/);
  });

  it("[sma:k_c_spec] spec-phase: ambiguity 0.6 then 0.15 is score, ask, score, spec; always 0.6 ends low_confidence", async () => {
    const ok = await runSim("spec-phase", { input: { phase_id: "ph_a", goal: "export" }, stubs: { score: [{ ambiguity: 0.6, weakest: "goal", questions: ["q"] }, { ambiguity: 0.15, weakest: "", questions: [] }], spec: { spec_path: ".agents/phases/ph_a/SPEC.md" } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(ok)).toBe("score ask score spec done");
    expect(emitted(ok)).toMatchObject({ status: "done", spec_path: ".agents/phases/ph_a/SPEC.md" });
    const low = await runSim("spec-phase", { input: { phase_id: "ph_a", goal: "export" }, stubs: { score: { ambiguity: 0.6, weakest: "goal", questions: ["q"] }, spec: { spec_path: "s.md" } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(low)).toBe("score ask score ask score spec low_confidence");
    expect(emitted(low)).toMatchObject({ status: "low_confidence" });
  });

  it("[sma:k_c_addtests] test-gen with gaps given runs main's path (no derive, no confirm, no person asked); with a phase and no gaps it derives and the owner confirms, a timeout blocks", async () => {
    const stubs = { write_tests: { state: "accepted" }, run: { ok: true } };
    const given = await runSim("test-gen", { input: { gaps: [{ file: "a.ts" }] }, stubs, humans: { confirm: { answer_kind: "timeout" } } });
    expect(pathOf(given)).toBe("derive confirm write_tests run done");
    expect(given.skipped).toEqual(["derive", "confirm"]);
    expect(given.called("derive")).toHaveLength(0);
    expect(given.called("confirm")).toHaveLength(0);
    expect(costly(given)).toEqual(["write_tests"]);
    expect(emitted(given)).toMatchObject({ status: "done" });
    const derived = await runSim("test-gen", { input: { phase_id: "ph_a" }, stubs: { ...stubs, derive: { gaps: [{ file: "a.ts" }] } }, humans: { confirm: { answer_kind: "agree" } } });
    expect(costly(derived)).toEqual(["derive", "confirm", "write_tests"]);
    expect(derived.skipped).toEqual([]);
    const timeout = await runSim("test-gen", { input: { phase_id: "ph_a" }, stubs: { ...stubs, derive: { gaps: [{ file: "a.ts" }] } }, humans: { confirm: { answer_kind: "timeout" } } });
    expect(pathOf(timeout)).toBe("derive confirm blocked");
    expect(timeout.called("write_tests")).toHaveLength(0);
  });

  it("[default] test-gen with today's inputs (gaps given) runs main's classify path and asks no person", async () => {
    const r = await runSim("test-gen", { input: { scope: "src/a.ts", gaps: [{ file: "src/a.ts", layer: "L1", priority: "high" }] }, stubs: { write_tests: { state: "accepted" }, run: { ok: false }, classify: { converged: true, test_defects: [], code_defects: [] } } });
    expect(costly(r)).toEqual(["write_tests", "classify"]);
    expect(r.skipped).toEqual(["derive", "confirm"]);
  });

  it("[sma:k_c_addtodo] two todos the same day without a title land in two folders, both intact; the folder name and the meta.yaml id are one id", async () => {
    const t = await setup(); dispose = t.dispose;
    stubModels(t, { shape: { title: "A todo", body: "the first body", priority: "normal", line: "todo added" } });
    const first = await t.start(wf("todo-add.json"), { thought: "fix the flaky payments test", estimate: 3 }).done;
    stubModels(t, { shape: { title: "A todo", body: "the second body", priority: "high", line: "todo added" } });
    const second = await t.start(wf("todo-add.json"), { thought: "move metrics to ClickHouse" }).done;
    expect(first.status).toBe("succeeded"); expect(second.status).toBe("succeeded");
    const items = join(t.checkout, ".agents/todos/items");
    const folders = readdirSync(items);
    expect(folders).toHaveLength(2);
    const metas = folders.map((folder) => ({ folder, meta: parseTodoMeta(readFileSync(join(items, folder, "meta.yaml"), "utf8"))!, body: readFileSync(join(items, folder, "README.md"), "utf8") }));
    expect(metas.map((m) => m.body).sort()).toEqual(["the first body", "the second body"]);
    for (const m of metas) expect(m.folder).toBe(`${new Date().toISOString().slice(0, 10)}-${m.meta.id}`);
    expect(new Set(metas.map((m) => m.meta.id)).size).toBe(2);
    const one = metas.find((m) => m.body === "the first body")!;
    expect(one.meta).toMatchObject({ title: "A todo", status: "ready", estimate: 3 });
    expect(first.output).toMatchObject({ status: "done", todo_id: one.meta.id, line: "todo added" });
    // The same title twice (the shape node is skipped when a title is given) is two folders as well.
    await t.start(wf("todo-add.json"), { thought: "x", title: "Same title" }).done;
    await t.start(wf("todo-add.json"), { thought: "y", title: "Same title" }).done;
    expect(readdirSync(items)).toHaveLength(4);
    expect(pathOf(await runSim("todo-add", { input: { thought: "t" }, stubs: { shape: { title: "T", body: "b" } } }))).toBe("shape write done");
  });

  it("[sma:k_wst_map] lp.tree_counts counts a fixture tree when the switch is on and reads nothing when it is off; the value map opens with the counts", async () => {
    const t = await setup(); dispose = t.dispose;
    commitFile(t, "src/a.ts", "a\n"); commitFile(t, "src/b.ts", "b\n"); commitFile(t, "src/c.ts", "c\n");
    commitFile(t, "tests/a.test.ts", "a\n"); commitFile(t, "tests/b.test.ts", "b\n");
    commitFile(t, ".agents/planning/STATE.md", "s\n");
    const outs = { enabled: "string", sources: "int", tests: "int", docs: "int", planning: "int", commits: "int", counts_note: "string" };
    const params = { counts_note: "Open VALUE-MAP.md with these five lines counted from the tree itself, verbatim:" };
    t.set("project.start_research", "off");
    const off = (await t.start(actionChain("lp.tree_counts", outs, params)).done).output as Row;
    expect(off).toMatchObject({ enabled: "off", sources: 0, counts_note: "" });
    t.set("project.start_research", "maybe"); // not a word of the switch: the default, on
    const on = (await t.start(actionChain("lp.tree_counts", outs, params)).done).output as Row;
    expect(on).toMatchObject({ enabled: "on", sources: 3, tests: 2, docs: 2, planning: 1 });
    expect(on.commits).toBeGreaterThanOrEqual(6);
    expect(on.counts_note).toBe(`${params.counts_note} sources 3, tests 2, docs 2, planning artifacts 1, commits ${on.commits}.`);
    // Through the graph: the value map prompt carries the five counts.
    const calls = stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" }, requirements: { requirements: [] } });
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true }); writeFileSync(join(t.checkout, ".agents/planning/PROFILE.md"), "host: h\n");
    await t.start(wf("project-start.json"), {}).done;
    expect(calls.find((c) => c.node === "value_map")!.prompt).toMatch(/verbatim: sources 3, tests 2, docs 2, planning artifacts 2, commits \d+\./);
  });

  it("[sma:k_wst_quick] with the switch on an install with map, roadmap and profile ends at a resume-project pointer; one missing piece runs the rest", async () => {
    const t = await setup(); dispose = t.dispose;
    t.set("project.start_research", "on");
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    for (const file of ["VALUE-MAP.md", "ROADMAP.md", "PROFILE.md"]) writeFileSync(join(t.checkout, ".agents/planning", file), "x\n");
    const calls = stubModels(t, startStubs);
    const resumed = await t.start(wf("project-start.json"), {}).done;
    expect(executed(t, resumed.runId)).toEqual(["tree", "probe", "resumed"]);
    expect((resumed.output!.next_steps as string[])[0]).toMatch(/project-resume/);
    expect(calls).toHaveLength(0);
    const missing = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "on" }, "lp.state_probe": { has_value_map: true, has_roadmap: false, has_profile: true }, "lp.profile_write": { refused: [], set: [] }, research: { research_notes: "n" }, requirements: { requirements: [] }, recap: { next_steps: ["a"] } } });
    expect(missing.skipped).toEqual(expect.arrayContaining(["value_map", "ask"]));
    expect(costly(missing)).toEqual(["preview", "research", "requirements", "recap"]);
  });

  it("[sma:k_lib_profilewriter] key names that hold a secret are refused as whole words; ordinary names pass", () => {
    for (const key of ["db_password", "DB_PASSWORD", "dbPassword", "passwd", "root-passwd", "client_secret", "clientSecret", "secrets", "api_token", "accessToken", "tokens", "api_key", "apiKey", "API-KEY", "APIKey", "api key", "private_key", "privateKey", "credentials", "aws_credential"]) expect(secretKeyName(key), key).toBe(true);
    for (const key of ["monkey", "keyboard_layout", "key", "host", "deploy", "start_command", "logs", "turkey", "tokenizer", "secretary", "passport", "primary_key_hint"]) expect(secretKeyName(key), key).toBe(false);
  });

  it("[sma:k_lib_profilewriter] a refused pair is skipped and named by key only, the rest is written, and the start goes on", async () => {
    const t = await setup(); dispose = t.dispose;
    const out = { refused: "string[]", set: "string[]" };
    const profile = { host: "local", db_password: "hunter2", apiKey: "plain", monkey: "ape", note: `sk-${"a".repeat(24)}`, deploy: "manual" };
    const written = (await t.start(actionChain("lp.profile_write", out, { profile })).done).output as Row;
    // `host` and `monkey` are not among the eight profile keys (k_pl_infra): refused with a reason, the other pairs are kept.
    expect(written.refused).toEqual(["host", "db_password", "apiKey", "monkey", "note"]);
    expect(written.set).toEqual(["deploy"]);
    expect(JSON.stringify(written)).not.toMatch(/hunter2|plain|sk-/);
    expect(t.writes.map((w) => w.content).join("\n")).not.toMatch(/hunter2|plain|sk-/);
    // All pairs refused: nothing written, no failure.
    const none = (await t.start(actionChain("lp.profile_write", out, { profile: { token: "x" } })).done).output as Row;
    expect(none).toMatchObject({ refused: ["token"], set: [] });
    // Through project-start: the start does not end, it names the key in its output and goes on to the roadmap.
    startOn(t);
    stubModels(t, { ...startStubs, preview: { stack: {}, memory: {}, profile: { host: "h1", db_password: "hunter2" } }, research: { research_notes: "n" }, requirements: { requirements: [] } });
    const summary = await t.start(wf("project-start.json"), {}).done;
    expect(summary.status).toBe("succeeded");
    expect(executed(t, summary.runId)).toEqual(Object.values(startFlow).filter((id) => id !== "ask"));
    expect(summary.output).toMatchObject({ status: "done", refused: ["host", "db_password"] });
    expect(JSON.stringify(summary.output)).not.toContain("hunter2");
  });

  it("[sma:k_ag_uiauditor] ui-audit: review_file is on when unset and the six pillars review is written by its own node; review_file=false runs main's audit and writes no file", async () => {
    const stubs = { capture: { status: "pass", screenshots: ["a.png"] }, audit: { score_40: 30, score_20: 14, findings: [] } };
    const off = await runSim("ui-audit", { input: { url: "http://localhost:4173", review_file: false }, stubs });
    expect(costly(off)).toEqual(["capture", "audit"]);
    expect(off.skipped).toEqual(["review_doc"]);
    expect(node("ui-audit.json", "audit").prompt).not.toMatch(/UI-REVIEW/);
    const on = await runSim("ui-audit", { input: { url: "http://localhost:4173" }, stubs: { ...stubs, review_doc: { review_path: ".agents/ui/pricing/UI-REVIEW.md" } } });
    expect(costly(on)).toEqual(["capture", "audit", "review_doc"]);
    expect(on.called("review_doc")).toHaveLength(1);
    const prompt = node("ui-audit.json", "review_doc").prompt!;
    for (const pillar of ["visual hierarchy", "interaction states", "accessibility", "responsiveness", "micro-interactions", "edge cases"]) expect(prompt).toContain(pillar);
    expect(prompt).toMatch(/0-4/);
    expect(prompt).toContain(".agents/ui/<slug>/UI-REVIEW.md");
    expect(prompt).not.toContain("UI-REVIEW.new.md");
    expect(prompt).toMatch(/created or replaced at that exact path/);
  });
});
