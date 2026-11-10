import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { runSim } from "../workflow/chain-harness";
import type { SimResult } from "../workflow/chain-harness";
import { out, pathOf } from "../workflow/chain-helpers";
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
  return { db, engine, checkout, writes, start, git, dispose: () => harness.lifecycle.dispose() };
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
/** Agent nodes of an engine run answer from a table by node id (the fake host has no models). */
function stubModels(t: { engine: WorkflowEngine }, answers: Record<string, Row>) {
  const seen = new Map<string, number>();
  t.engine.register("agent", { reentrant: true, run: async (ctx: { nodeId: string }) => {
    const at = seen.get(ctx.nodeId) ?? 0; seen.set(ctx.nodeId, at + 1);
    return { output: { handoff: `${ctx.nodeId} done`, ...(answers[ctx.nodeId] ?? {}) } };
  } } as never);
}
const emitted = (r: SimResult) => r.summary.output as Row;
const commitFile = (t: Awaited<ReturnType<typeof setup>>, path: string, body: string) => {
  mkdirSync(dirname(join(t.checkout, path)), { recursive: true }); writeFileSync(join(t.checkout, path), body);
  t.git("add", "."); t.git("commit", "-q", "-m", path);
};

describe("parity d4 workflows b-2", () => {
  it("[sma:k_c_mssummary] milestone-summary ends done from the milestone artifacts and milestone-close runs it after close", async () => {
    const sim = await runSim("milestone-summary", { input: { milestone: "Stats export" }, stubs: { summary: { summary_path: ".agents/planning/MILESTONE-SUMMARY.md", open_items: [] } } });
    expect(pathOf(sim)).toBe("summary goal_check done");
    expect(emitted(sim)).toMatchObject({ status: "done", summary_path: ".agents/planning/MILESTONE-SUMMARY.md" });
    expect(node("milestone-summary.json", "summary").prompt).toMatch(/ROADMAP\.md.*STATE\.md.*SUMMARY\.md.*UAT\.md.*REVIEW\.md/s);
    // The close calls it as an optional node after close on the closed path.
    const close = src("milestone-close.json");
    const summary = close.nodes.find((n) => n.id === "summary")!;
    expect(summary.type).toBe("subworkflow");
    expect(summary.workflow).toBe("milestone-summary");
    expect(close.edges.some((e) => e.from === "close" && e.to === "summary")).toBe(true);
    const r = await runSim("milestone-close", { input: { goal: "Stats export", goals: [{ id: "g1", done_when: "d", evidence: "e" }] },
      stubs: { "lp.run_status": { open_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0 }, "lp.close": { status: "closed", staged: 0 } } });
    expect(pathOf(r)).toContain("summary");
  });

  it("[sma:k_c_mvp] mvp-phase: a rework verdict loops once to story, a pass emits a story with who, what and why", async () => {
    const story = { who: "owner", what: "sees stats", why: "to decide", slice: "report page", out_of_scope: ["pdf"] };
    const r = await runSim("mvp-phase", { input: { goal: "export stats" }, stubs: { story, split_check: [{ verdict: "rework", notes: "not vertical" }, { verdict: "pass", notes: "ok" }] } });
    expect(pathOf(r)).toBe("story split_check story split_check goal_check done");
    const out1 = emitted(r)!.story as Row;
    expect(out1).toMatchObject({ who: "owner", what: "sees stats", why: "to decide" });
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

  it("[sma:k_c_newproject] project-start asks, researches, writes requirements and a roadmap in one flow", async () => {
    const r = await runSim("project-start", { input: {}, stubs: {
      "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false }, "lp.profile_write": { refused: [], set: [] },
      value_map: { value_map: "v" }, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" },
      requirements: { requirements: ["REQ-1"] }, recap: { next_steps: ["a"] } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(r)).toBe("probe tree value_map preview profile_write ask research requirements recap done");
    expect(emitted(r)).toMatchObject({ status: "done" });
  });

  it("[sma:k_pl_project] recap writes .agents/planning/PROJECT.md with Vision, Value and Limits, and the close's retro refreshes it", () => {
    const recap = node("project-start.json", "recap").prompt!;
    expect(recap).toContain(".agents/planning/PROJECT.md");
    expect(recap).toMatch(/Vision.*Value.*Limits/s);
    const retro = node("milestone-close.json", "retro").prompt!;
    expect(retro).toContain(".agents/planning/PROJECT.md");
  });

  it("[sma:k_pl_researchdir] a research node before recap names the four files and the graph validates", () => {
    const research = node("project-start.json", "research");
    for (const file of ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]) expect(research.prompt).toContain(file);
    const edges = src("project-start.json").edges;
    expect(edges.some((e) => e.from === "research" && e.to === "requirements")).toBe(true);
    expect(edges.some((e) => e.from === "requirements" && e.to === "recap")).toBe(true);
    expect(node("project-start.json", "recap").prompt).toContain("research/STACK.md");
  });

  it("[sma:k_c_secure] secure-phase: an open threat ends in gaps, all mitigated ends in done", async () => {
    const open = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: ["T1"], security_path: ".agents/phases/ph_a/SECURITY.md" } } });
    expect(emitted(open)).toMatchObject({ status: "gaps", open: ["T1"] });
    const clean = await runSim("secure-phase", { input: { phase_id: "ph_a" }, stubs: { audit: { open: [], security_path: ".agents/phases/ph_a/SECURITY.md" } } });
    expect(pathOf(clean)).toBe("audit goal_check done");
    expect(emitted(clean)).toMatchObject({ status: "done" });
  });

  it("[sma:k_ag_security] security-audit takes phase_id, scans threat_model and reports per threat into SECURITY.md", () => {
    const w = src("security-audit.json");
    expect(w.inputs.phase_id).toBeDefined();
    const scan = w.nodes.find((n) => n.id === "scan")! as Row & { for_each: Record<string, string[]>; child: { prompt: string } };
    for (const tier of ["quick", "standard", "deep"]) expect(scan.for_each[tier]).toContain("threat_model");
    expect(scan.child.prompt).toContain("mitigated|partial|missing");
    expect(scan.child.prompt).toContain("file:line");
    expect(scan.child.prompt).toContain("severity high");
    expect(node("security-audit.json", "report").prompt).toContain("## Verified against the code");
    expect(node("security-audit.json", "report").prompt).toContain("SECURITY.md");
  });

  it("[sma:k_ws_review] ship with review true and a rework verdict is held; with review false it ships", async () => {
    const held = await runSim("ship", { input: { phase_id: "ph_a", review: true }, stubs: { "code-review": { status: "rework" }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" } } });
    expect(emitted(held)).toMatchObject({ status: "held" });
    expect(emitted(held)!.held_by![0]).toMatch(/review/);
    const shipped = await runSim("ship", { input: { phase_id: "ph_a", review: false }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" }, post_ship: { hooks_run: [], hooks_failed: [] } } });
    expect(pathOf(shipped)).toBe("gate preflight review open_pr post_ship goal_check shipped");
    expect(emitted(shipped)).toMatchObject({ status: "shipped" });
  });

  it("[sma:k_ws_post] after open_pr the path includes post_ship and a failed hook is listed without holding the ship", async () => {
    const r = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "u" }, post_ship: { hooks_run: ["h1"], hooks_failed: ["h2"] } } });
    expect(pathOf(r)).toContain("post_ship");
    expect(emitted(r)).toMatchObject({ status: "shipped", hooks_failed: ["h2"] });
    expect(node("ship.json", "open_pr").prompt).not.toContain("post-ship");
  });

  it("[sma:k_c_spec] spec-phase: ambiguity 0.6 then 0.15 is score, ask, score, spec; always 0.6 ends low_confidence", async () => {
    const ok = await runSim("spec-phase", { input: { phase_id: "ph_a", goal: "export" }, stubs: { score: [{ ambiguity: 0.6, weakest: "goal", questions: ["q"] }, { ambiguity: 0.15, weakest: "", questions: [] }], spec: { spec_path: ".agents/phases/ph_a/SPEC.md" } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(ok)).toBe("score ask score spec done");
    expect(emitted(ok)).toMatchObject({ status: "done", spec_path: ".agents/phases/ph_a/SPEC.md" });
    const low = await runSim("spec-phase", { input: { phase_id: "ph_a", goal: "export" }, stubs: { score: { ambiguity: 0.6, weakest: "goal", questions: ["q"] }, spec: { spec_path: "s.md" } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(low)).toBe("score ask score ask score spec low_confidence");
    expect(emitted(low)).toMatchObject({ status: "low_confidence" });
  });

  it("[sma:k_c_addtests] test-gen with a phase and no gaps passes derive and confirm first; with gaps derive is skipped", async () => {
    const derived = await runSim("test-gen", { input: { phase_id: "ph_a" }, stubs: { derive: { gaps: [{ file: "a.ts" }] }, write_tests: { state: "accepted" }, run: { ok: true } }, humans: { confirm: { answer_kind: "agree" } } });
    expect(pathOf(derived)).toBe("derive confirm write_tests run done");
    expect(derived.skipped).not.toContain("derive");
    const given = await runSim("test-gen", { input: { gaps: [{ file: "a.ts" }] }, stubs: { write_tests: { state: "accepted" }, run: { ok: true } }, humans: { confirm: { answer_kind: "agree" } } });
    expect(pathOf(given)).toBe("derive confirm write_tests run done");
    expect(given.skipped).toContain("derive");
  });

  it("[sma:k_c_addtodo] the todo workflow writes a meta.yaml the backlog parses, and the emit carries the id", async () => {
    const t = await setup(); dispose = t.dispose;
    stubModels(t, { shape: { id: "flaky-payments", title: "Fix the flaky payments test", body: "fix the flaky payments test", priority: "normal", line: "todo flaky-payments added" } });
    const summary = await t.start(wf("todo-add.json"), { thought: "fix the flaky payments test", estimate: 3 }).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({ status: "done", todo_id: "flaky-payments", line: "todo flaky-payments added" });
    const meta = t.writes.find((w) => w.path.endsWith("meta.yaml"))!;
    expect(meta.path).toContain(".agents/todos/items/");
    const parsed = parseTodoMeta(meta.content)!;
    expect(parsed).toMatchObject({ id: "flaky-payments", title: "Fix the flaky payments test", status: "ready", estimate: 3 });
    expect(t.writes.some((w) => w.path.endsWith("README.md") && w.content.includes("fix the flaky payments test"))).toBe(true);
  });

  it("[sma:k_wst_map] lp.tree_counts on a fixture tree returns its counts and project-start runs tree before value_map", async () => {
    const t = await setup(); dispose = t.dispose;
    commitFile(t, "src/a.ts", "a\n"); commitFile(t, "src/b.ts", "b\n"); commitFile(t, "src/c.ts", "c\n");
    commitFile(t, "tests/a.test.ts", "a\n"); commitFile(t, "tests/b.test.ts", "b\n");
    commitFile(t, ".agents/planning/STATE.md", "s\n");
    const verdict = (await t.start(actionChain("lp.tree_counts", { sources: "int", tests: "int", docs: "int", planning: "int", commits: "int" })).done).output as Row;
    expect(verdict).toMatchObject({ sources: 3, tests: 2, docs: 2, planning: 1 });
    expect(verdict.commits).toBeGreaterThanOrEqual(6);
    // The graph runs tree before value_map and the value map opens with the five lines.
    const edges = src("project-start.json").edges;
    expect(edges.some((e) => e.from === "tree" && e.to === "value_map")).toBe(true);
    const prompt = node("project-start.json", "value_map").prompt!;
    for (const ref of ["{{tree.sources}}", "{{tree.tests}}", "{{tree.docs}}", "{{tree.planning}}", "{{tree.commits}}"]) expect(prompt).toContain(ref);
  });

  it("[sma:k_wst_quick] an install with map, roadmap and profile ends at a resume-project pointer; without them runs the full path", async () => {
    const ready = await runSim("project-start", { input: {}, stubs: { "lp.state_probe": { has_value_map: true, has_roadmap: true, has_profile: true } } });
    expect(pathOf(ready)).toBe("probe resumed");
    expect(emitted(ready)!.next_steps![0]).toMatch(/resume-project/);
    const fresh = await runSim("project-start", { input: {}, stubs: {
      "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false }, "lp.profile_write": { refused: [], set: [] },
      value_map: { value_map: "v" }, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n" },
      requirements: { requirements: [] }, recap: { next_steps: [] } }, humans: { ask: { answer_kind: "answered" } } });
    expect(pathOf(fresh)).toBe("probe tree value_map preview profile_write ask research requirements recap done");
  });

  it("[sma:k_lib_profilewriter] a secret-looking value is refused by key name; clean values are written by the one writer", async () => {
    const t = await setup(); dispose = t.dispose;
    const out = { refused: "string[]", set: "string[]" };
    const refused = (await t.start(actionChain("lp.profile_write", out, { profile: { host: "local", api_key: `sk-${"a".repeat(24)}` } })).done).output as Row;
    expect(refused.refused).toEqual(["api_key"]);
    expect(refused.set).toEqual([]);
    expect(t.writes).toHaveLength(0);
    expect(JSON.stringify(refused)).not.toContain("sk-");
    const clean = (await t.start(actionChain("lp.profile_write", out, { profile: { host: "local", deploy: "manual" } })).done).output as Row;
    expect(clean.refused).toEqual([]);
    expect(clean.set).toEqual(["host", "deploy"]);
  });
});
