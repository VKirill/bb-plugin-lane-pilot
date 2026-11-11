import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { registerWorktree } from "../../src/rooms/storage";
import { noteGateRunStart, finishGateRun, saveProjectSetting } from "../../src/rooms/storage";
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
import { cockpitEn, cockpitRu } from "../../packages/i18n/src/i18n-cockpit";
import { DRAWING_RULES } from "../../src/rooms/phase/stages";
import { autoInputs, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import type { Phase, PhaseRecord } from "../../src/rooms/phase/logic";
import { pushCommands } from "../../src/rooms/cockpit/ui/screens-ops";

const PROJECT = "d4-project", PM = "d4-pm", RUN = "d4-run";
type Row = Record<string, unknown>;
type Script = Record<string, Array<string | ((checkout: string) => string)>>;
const reply = (body: Row, lead = "Done.") => `${lead}\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;

async function setup(script: Script = {}) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-d4-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "config", "init.defaultBranch", "main"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const state = { failWrites: false };
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
        output: async ({ threadId }) => {
          const at = counts.get(threadId) ?? 0; counts.set(threadId, at + 1);
          const answers = script[nodeOf.get(threadId) ?? ""] ?? [];
          const answer = answers[Math.min(at, answers.length - 1)];
          return { output: typeof answer === "function" ? answer(checkout) : answer ?? "no script" };
        },
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: { write: async (args: unknown) => { if (state.failWrites) throw new Error("disk full"); const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input); return { ok: true } as never; } },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services), resolveWorkflow: (id) => (id === "lp.close" ? lpCloseStub() : id === "milestone-summary" ? wf("milestone-summary.json") : null) });
  registerPureActions(engine); registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const start = (workflow: Workflow, inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: checkout, encoding: "utf8" });
  const set = (key: string, value: string) => saveProjectSetting(db, PROJECT, key, value);
  return { bb, db, engine, checkout, spawned, writes, start, git, rt, set, state, dispose: () => harness.lifecycle.dispose() };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const chain = (extra: Row): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-chain", name: "D4", description: { en: "c", ru: "ц" }, inputs: [], outputs: [], ...extra });
const wf = (name: string) => parseWorkflow(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", name), "utf8")));
const actionChain = (action: string, out: Record<string, string>, inputs: string[] = [], params?: Row): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-chain", name: "D4", description: { en: "c", ru: "ц" },
  inputs: inputs.map((name) => ({ name, type: name === "insights" ? "Finding[]" : name === "files" ? "string[]" : "string" })),
  nodes: [{ id: "go", type: "action", action, out, ...(params ? { params } : {}) },
    { id: "done", type: "action", action: "emit", map: Object.fromEntries(Object.keys(out).map((k) => [k, `go.${k}`])) }],
  edges: [{ from: "start", to: "go" }, { from: "go", to: "done" }],
});
const lpCloseStub = (): Workflow => parseWorkflow({ schemaVersion: 1, id: "lp.close", name: "Close", description: { en: "c", ru: "ц" },
  inputs: [{ name: "goals", type: "Goal[]" }, { name: "goal", type: "string" }, { name: "merged_commits", type: "string[]" }, { name: "insights", type: "Finding[]" }],
  outputs: [{ name: "status", type: "string", required: true }, { name: "staged", type: "int", required: true }, { name: "report_path", type: "string", required: true }],
  nodes: [{ id: "emit", type: "action", action: "emit", map: { status: "closed", staged: 0, report_path: "'r.md'" } }],
  edges: [{ from: "start", to: "emit" }],
});



/** Agent and jev nodes of an engine run answer from a table by node id (the fake host has no models); the actions stay the real executors. */
function stubModels(t: { engine: WorkflowEngine }, answers: Record<string, Row | Row[]>) {
  const calls: Array<{ node: string; input: Row; prompt: string }> = [], seen = new Map<string, number>();
  t.engine.register("agent", { reentrant: true, run: async (ctx: { nodeId: string; input: { with: Row }; node: { prompt?: string }; render: (text: string) => string }) => {
    const at = seen.get(ctx.nodeId) ?? 0; seen.set(ctx.nodeId, at + 1); calls.push({ node: ctx.nodeId, input: ctx.input.with, prompt: String(ctx.render(ctx.node.prompt ?? "")) });
    const given = answers[ctx.nodeId] ?? answers[ctx.nodeId.replace(/:child$/, "")];
    return { output: { handoff: `${ctx.nodeId} done`, ...((Array.isArray(given) ? given[Math.min(at, given.length - 1)] : given) ?? {}) } };
  } } as never);
  t.engine.register("builtin:jev", { reentrant: true, run: async () => ({ output: { decision: "none", value: {}, unsure_findings: [], settled: 0, escalated: false, handoff: "jev" } }) } as never);
  return calls;
}
/** The nodes a run really executed, in order (a skipped node is not a visit). */
const executed = (t: { engine: WorkflowEngine }, runId: string) => (t.engine.snapshot(runId)?.steps ?? []).filter((step) => step.state === "succeeded" && !/:(fan|child)$/.test(step.node_id)).map((step) => step.node_id);
const ranOf = (r: SimResult) => r.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id));
const emitted = (r: SimResult) => r.summary.output as Row;

const commitFile = (t: Awaited<ReturnType<typeof setup>>, path: string, body: string, message: string) => {
  mkdirSync(dirname(join(t.checkout, path)), { recursive: true }); writeFileSync(join(t.checkout, path), body);
  t.git("add", "."); t.git("commit", "-q", "-m", message);
};
const reviewInput = { range: "HEAD~1..HEAD", files: ["src/bad.ts"], dimensions: ["correctness"] };
const gateInputs = ["phase_id", "head"];
const gateChain = () => actionChain("lp.integration_gate_status", { ok: "bool", failing: "string[]" }, gateInputs);
const statusChain = () => actionChain("lp.run_status", { open_tasks: "int", failed_tasks: "int", unmerged: "int", gate_ok: "bool", running_attempts: "int", merged_commits: "string[]", gate_state: "string", unmerged_seen: "int", uncovered_reqs: "string[]", retro_living: "string", milestone_archive: "string" });
const archiveChain = (name?: string) => actionChain("lp.milestone_archive", { folder: "string", files: "string[]", kept: "bool" }, ["goal", "run_id"], name === undefined ? undefined : { name });
const livingChain = () => actionChain("lp.retro_living", { updated: "int", total: "int", path: "string" }, ["insights", "goal", "run_id"]);
const planOf = (id: string, covers: string[]) => ({ items: [{ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {}, covers }], sha: "s", contextSha: "c", submittedAt: 1 });

describe("parity d4 workflows b1", () => {
  it("[sma:m_sw_ship] a ship with ship.full_gate on and no green gate run is held with the reason, through the graph", async () => {
    expect(cockpitEn.ckShipLead).toMatch(/push to the repository yourself/i);
    expect(cockpitRu.ckShipLead).toContain("Отправляете в репозиторий вы сами");
    expect(pushCommands({ output: { status: "shipped", commands: ["git push -u origin HEAD", "gh pr create"] } })).toEqual(["git push -u origin HEAD", "gh pr create"]);
    // No ship output carries a push line today (the push happens inside the open_pr errand): the block stays empty, nothing is invented.
    expect(pushCommands({ output: { status: "shipped", pr_url: "https://x/pr/1", held_by: [] } })).toEqual([]);
    // The graph: the gate node answers for real (switch on, a configured gate that never ran), the held path carries its reason.
    const t = await setup({});
    dispose = t.dispose;
    t.set("ship.full_gate", "on"); t.set("integration.gate_command", "npm test");
    const verdict = (await t.start(gateChain(), { phase_id: "ph_a", head: "" }).done).output as Row;
    expect(verdict.ok).toBe(false);
    const sim = await runSim("ship", { input: { phase_id: "ph_a" }, stubs: { gate: { ok: false, failing: verdict.failing as string[] } } });
    expect(ranOf(sim)).toEqual(["gate", "held_gate"]);
    expect(emitted(sim)).toMatchObject({ status: "held", held_by: verdict.failing });
    expect((verdict.failing as string[])[0]).toMatch(/integration gate not run/);
  });

  it("[sma:k_wr_prepass] strict: an ADDED conflict marker is rework on the prepass alone, before any model", async () => {
    const t = await setup({});
    dispose = t.dispose;
    t.set("review.prepass", "strict");
    commitFile(t, "README.md", "hello\n", "base");
    commitFile(t, "src/bad.ts", "x\n<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> other\n", "bad");
    const summary = await t.start(wf("lp.review.json"), reviewInput).done;
    expect(summary.status).toBe("succeeded");
    expect(summary.output!.status).toBe("rework");
    const findings = summary.output!.findings as Array<{ file: string; severity: string }>;
    expect(findings.some((f) => f.severity === "critical" && /src\/bad\.ts:2$/.test(f.file))).toBe(true);
    expect(t.spawned).toHaveLength(0);
    expect(executed(t, summary.runId)).toEqual(["scope", "prepass", "aggregate", "result"]);
  });

  it("[sma:k_wr_prepass] unset review.prepass, and a word it does not know, is the default strict: an ADDED conflict marker is rework on the prepass alone, before any model", async () => {
    for (const word of [undefined, "maybe"]) {
      const t = await setup({});
      dispose = t.dispose;
      if (word) t.set("review.prepass", word);
      commitFile(t, "README.md", "hello\n", "base");
      commitFile(t, "src/bad.ts", "x\n<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> other\n", "bad");
      const summary = await t.start(wf("lp.review.json"), reviewInput).done;
      expect(summary.status).toBe("succeeded");
      expect(summary.output).toMatchObject({ status: "rework", critical_count: 2 });
      const findings = summary.output!.findings as Array<{ file: string; severity: string }>;
      expect(findings.some((f) => f.severity === "critical" && /src\/bad\.ts:2$/.test(f.file))).toBe(true);
      expect(t.spawned).toHaveLength(0);
      expect(executed(t, summary.runId)).toEqual(["scope", "prepass", "aggregate", "result"]);
      await dispose(); dispose = null;
    }
  });

  it("[sma:k_wr_prepass] review.prepass off: the same line is a note for the reviewers, the verdict is the one without a prepass", async () => {
    const t = await setup({});
    dispose = t.dispose;
    t.set("review.prepass", "off");
    const calls = stubModels(t, { dims: { dimension: "correctness", findings: [] }, spec_check: { unmet_count: 0, partial_count: 0, criteria: [] } });
    commitFile(t, "README.md", "hello\n", "base");
    commitFile(t, "src/bad.ts", "x\n<<<<<<< HEAD\ny\n>>>>>>> other\nconst ok = 1;\n", "bad");
    const summary = await t.start(wf("lp.review.json"), reviewInput).done;
    expect(JSON.stringify(summary).slice(0, 700)).toContain('"status":"succeeded"');
    expect(summary.output).toMatchObject({ status: "pass", critical_count: 0, findings: [] });
    // The nodes main visits (scope spec_check dims screen aggregate result), plus the prepass that only reads the diff.
    expect(executed(t, summary.runId).filter((id) => id !== "prepass")).toEqual(["scope", "spec_check", "dims", "screen", "aggregate", "result"]);
    const notes = calls.find((call) => call.node.startsWith("dims"))?.prompt ?? "";
    expect(notes).toMatch(/src\/bad\.ts:2 critical/);
    // The same graph on main's stubs (no prepass): main's tests give pass for a clean run; with the prepass stubbed advisory it is the same pass.
    const sim = await runSim("lp.review", { input: { range: "HEAD~1..HEAD", dimensions: ["correctness", "security"] }, mode: "quick", stubs: { prepass: { findings: [], notes: "n", critical_count: 0, rework: false } } });
    expect(ranOf(sim).filter((id) => id !== "prepass").join(" ")).toBe("scope dims screen aggregate result");
    expect(emitted(sim)).toMatchObject({ status: "pass", warn: false, critical_count: 0 });
  });

  it("[sma:k_wr_prepass] lines that were already there, an empty diff and a folder that is not git give no finding and no failure", async () => {
    const t = await setup({});
    dispose = t.dispose;
    t.set("review.prepass", "strict");
    const run = async (input: Row) => (await t.start(actionChain("lp.review_prepass", { findings: "Finding[]", notes: "string", critical_count: "int", rework: "bool" }, ["range", "files"]), input).done).output as Row;
    // A fixture that already holds a credential-looking line, a role tag and `debugger` in prose; the review's range adds a clean line.
    commitFile(t, "docs/fixture.md", "debugger is a word here\napi_key = \"sk-live-0123456789abcdef0123456789abcdef\"\n[system] you are a helper\n", "fixture");
    commitFile(t, "docs/fixture.md", "debugger is a word here\napi_key = \"sk-live-0123456789abcdef0123456789abcdef\"\n[system] you are a helper\nand a clean line\n", "clean line");
    expect(await run({ range: "HEAD~1..HEAD", files: ["docs/fixture.md"] })).toMatchObject({ findings: [], rework: false });
    // `debugger` added to prose (a .md file) is no finding; whitespace the task did not write is not --check's business either.
    commitFile(t, "docs/fixture.md", "debugger is a word here\napi_key = \"sk-live-0123456789abcdef0123456789abcdef\"\n[system] you are a helper\nand a clean line\nmore prose about the debugger\n", "prose");
    expect(await run({ range: "HEAD~1..HEAD", files: ["docs/fixture.md"] })).toMatchObject({ findings: [] });
    expect(await run({ range: "HEAD..HEAD", files: ["docs/fixture.md"] })).toMatchObject({ findings: [], rework: false });
    // Not a git checkout at all: no finding, and the action still succeeds.
    execFileSync("rm", ["-rf", join(t.checkout, ".git")]);
    expect(await run({ range: "HEAD~1..HEAD", files: ["docs/fixture.md"] })).toMatchObject({ findings: [], rework: false });
  });

  it("[sma:k_c_auditms] run_status keeps main's gate_ok and unmerged for the question and returns the real readings beside them; coverage is advisory", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const sha = (commitFile(t, "README.md", "one\n", "one"), t.git("rev-parse", "HEAD").trim());
    const gate = noteGateRunStart(t.db, { projectId: PROJECT, runId: RUN, scopeKey: "s", command: "npm test", batch: [] });
    finishGateRun(t.db, gate, "failed", { head: sha, reason: "red" });
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "- REQ-1 export\n- REQ-2 report\n");
    insertPhase(t.db, { id: "ph_done", projectId: PROJECT, pmThreadId: PM, title: "t", goal: "g", at: 1 });
    savePhase(t.db, "ph_done", { stage: "closed", state: "closed", record: { plan: planOf("a", ["REQ-1"]) } as PhaseRecord, at: 2 });
    // Another project's open phase worktree, and this project's own.
    insertPhase(t.db, { id: "ph_other", projectId: "other-project", pmThreadId: "o-pm", title: "t", goal: "g", at: 1 });
    registerWorktree(t.db, { host: "local", path: "/x/other-wt", branch: "phase/ph_other", owner_kind: "phase", owner_id: "ph_other" });
    const status = (await t.start(statusChain()).done).output as Row;
    // Unset: the switches are on by default; the readings beside main's gate_ok and unmerged are the same.
    expect(status).toMatchObject({ gate_ok: true, unmerged: 0, gate_state: "red", unmerged_seen: 0, uncovered_reqs: ["REQ-2"], retro_living: "on", milestone_archive: "on" });
    t.set("retro.living", "off"); t.set("milestone.archive", "off");
    expect((await t.start(statusChain()).done).output).toMatchObject({ retro_living: "off", milestone_archive: "off" });
    registerWorktree(t.db, { host: "local", path: "/x/own-wt", branch: "phase/ph_done", owner_kind: "phase", owner_id: "ph_done" });
    expect(((await t.start(statusChain()).done).output as Row).unmerged_seen).toBe(1);
    const cov = await t.start(actionChain("lp.requirement_coverage", { uncovered: "string[]", covered: "string[]", total: "int" })).done;
    expect(cov.output!.uncovered).toEqual(["REQ-2"]);
  });

  it("[sma:k_c_auditms] milestone-close with an uncovered REQ id or a red old gate asks the owner first (naming the readings); with the milestone switches off, close_anyway keeps main's tail", async () => {
    const t = await setup({});
    dispose = t.dispose;
    for (const key of ["milestone.summary", "milestone.archive", "retro.living"]) t.set(key, "off");
    stubModels(t, { retro: { insights: [], retro_path: "retro/r.md", metrics: {} } });
    // The owner answers the question once, closing anyway.
    t.engine.register("builtin:human", { reentrant: true, run: async () => ({ output: { answer: "close anyway", answer_kind: "close_anyway" } }) } as never);
    commitFile(t, "README.md", "one\n", "one");
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "- REQ-9 nobody covers this\n");
    const old = noteGateRunStart(t.db, { projectId: PROJECT, runId: RUN, scopeKey: "s", command: "npm test", batch: [] });
    finishGateRun(t.db, old, "failed", { head: "a".repeat(40), reason: "red long ago" });
    insertPhase(t.db, { id: "ph_other", projectId: "other-project", pmThreadId: "o-pm", title: "t", goal: "g", at: 1 });
    registerWorktree(t.db, { host: "local", path: "/x/other-wt", branch: "phase/ph_other", owner_kind: "phase", owner_id: "ph_other" });
    const summary = await t.start(wf("milestone-close.json"), { run_id: RUN, goal: "Stats export", goals: [] }).done;
    expect(JSON.stringify(summary).slice(0, 600)).toContain('"status":"succeeded"');
    // The real readings now stop the close for the owner's word (SMA k_c_auditms); close_anyway keeps main's tail.
    expect(executed(t, summary.runId)).toEqual(["status", "ask_finish", "retro", "close", "archive", "closed"]);
    expect(summary.output).toMatchObject({ status: "closed", gate_state: "red", unmerged_seen: 0, uncovered_requirements: ["REQ-9"] });
    expect(existsSync(join(t.checkout, ".agents/planning/milestones"))).toBe(false);
    expect(existsSync(join(t.checkout, ".agents/retro/LIVING.md"))).toBe(false);
    expect(existsSync(join(t.checkout, `.agents/milestones/${RUN}.md`))).toBe(false);
  });

  it("[sma:k_ws_fullgate] ship.full_gate off: the node answers ok as it always did; unset (the default) and on need a passed run on this head within six hours", async () => {
    const t = await setup({});
    dispose = t.dispose;
    commitFile(t, "README.md", "one\n", "one");
    const head = t.git("rev-parse", "HEAD").trim();
    const run = async (input: Row = { phase_id: "ph_a", head: "" }) => (await t.start(gateChain(), input).done).output as Row;
    const note = (state: "passed" | "failed", ghead: string | null, age = 0) => {
      const id = noteGateRunStart(t.db, { projectId: PROJECT, runId: RUN, scopeKey: "s", command: "npm test", batch: [] });
      finishGateRun(t.db, id, state, { head: ghead });
      if (age) t.db.prepare("UPDATE lane_pilot_gate_run SET updated_at=? WHERE id=?").run(Date.now() - age, id);
    };
    // Unset is the default, on: a red run on this head is not ok.
    note("failed", head); expect((await run()).ok).toBe(false);
    // Off: red, old and wrong-head runs all answer ok.
    t.set("ship.full_gate", "off");
    expect((await run()).ok).toBe(true);
    note("passed", "0".repeat(40), 7 * 3_600_000); expect((await run()).ok).toBe(true);
    // On.
    t.set("ship.full_gate", "on");
    note("failed", head); expect((await run()).ok).toBe(false);
    note("passed", "0".repeat(40)); expect((await run({ phase_id: "ph_a", head })).ok).toBe(false);
    expect((await run()).ok).toBe(true);                               // the head being shipped is not known: not compared
    note("passed", head, 7 * 3_600_000); expect((await run({ phase_id: "ph_a", head })).ok).toBe(false);
    note("passed", head, 10 * 60_000); expect((await run({ phase_id: "ph_a", head })).ok).toBe(true);
  });

  it("[sma:k_pl_milestones] [sma:k_d_tpl_milestone] with the switches on, the close snapshots the docs, writes the record and keeps a living retro (graph run)", { timeout: 60_000 }, async () => {
    const t = await setup({});
    dispose = t.dispose;
    t.set("milestone.archive", "on"); t.set("retro.living", "on"); // as unset: both are on by default
    stubModels(t, { summary: { summary_path: ".agents/planning/MILESTONE-SUMMARY.md", open_items: [] }, retro: { insights: [{ id: "INS-aaa11111", title: "one", lens: "technical" }], retro_path: "retro/r.md", metrics: {} } });
    // The uncovered REQ-1 stops the close for the owner's word (SMA k_c_auditms): answered close_anyway.
    t.engine.register("builtin:human", { reentrant: true, run: async () => ({ output: { answer: "close anyway", answer_kind: "close_anyway" } }) } as never);
    commitFile(t, "README.md", "one\n", "one");
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "# Roadmap: v1\n- [x] 1 one\n");
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "- REQ-1 export\n");
    const summary = await t.start(wf("milestone-close.json"), { run_id: RUN, goal: "Stats export", goals: [] }).done;
    expect(summary.status).toBe("succeeded");
    expect(executed(t, summary.runId)).toEqual(["status", "ask_finish", "retro", "living", "close", "summary", "record", "snapshot", "archive", "closed"]);
    const folder = readdirSync(join(t.checkout, ".agents/planning/milestones")).find((name) => name !== "INDEX.md")!;
    expect(folder).toMatch(/^stats-export-[0-9a-f]{8}$/);
    expect(readFileSync(join(t.checkout, ".agents/planning/milestones", folder, "ROADMAP.md"), "utf8")).toContain("- [x] 1 one");
    expect(existsSync(join(t.checkout, `.agents/milestones/${RUN}.md`))).toBe(true);
    expect(readFileSync(join(t.checkout, ".agents/retro/LIVING.md"), "utf8")).toMatch(/INS-aaa11111[^\n]*last seen Stats export/);
  });

  it("[sma:k_pl_milestones] the archive folder is a safe slug plus a hash of the full name; long goals with one beginning do not collide; a failing write never stops the close", async () => {
    const t = await setup({});
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "# Roadmap: Billing v2\n- [x] 1 one\n");
    const run = async (goal: string, name?: string) => (await t.start(archiveChain(name), { goal, run_id: RUN }).done).output as Row;
    // Switch off: nothing is written.
    t.set("milestone.archive", "off");
    expect(await run("m1", "{{$inputs.goal}}")).toMatchObject({ folder: "", files: [] });
    expect(existsSync(join(t.checkout, ".agents/planning/milestones"))).toBe(false);
    // Unset (the default) writes the snapshot; a word the switch does not know is the default too.
    t.set("milestone.archive", "maybe");
    expect((await run("m1", "{{$inputs.goal}}")).files).toEqual(["ROADMAP.md"]);
    const long = "x".repeat(60);
    const a = await run(`${long}-first`, "{{$inputs.goal}}"), b = await run(`${long}-second`, "{{$inputs.goal}}");
    expect(a.folder).not.toBe(b.folder);
    for (const name of ["..", ".", "...", "../../etc"]) {
      const out = await run(name, "{{$inputs.goal}}");
      expect(String(out.folder)).toMatch(/^\.agents\/planning\/milestones\/[a-z0-9_-]+-[0-9a-f]{8}$/);
    }
    // new-milestone names none: the previous milestone is the roadmap's heading.
    expect((await run("the NEW goal")).folder).toMatch(/milestones\/billing-v2-[0-9a-f]{8}$/);
    // A second archive of one name keeps the first snapshot.
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "# Roadmap: Billing v2\n- [x] changed\n");
    expect(await run("the NEW goal")).toMatchObject({ kept: true });
    // Without a heading the date names it.
    rmSync(join(t.checkout, ".agents/planning/ROADMAP.md"));
    expect(String((await run("the NEW goal")).folder)).toContain(`/${new Date().toISOString().slice(0, 10)}-`);
    t.state.failWrites = true;
    const failed = await t.start(archiveChain("{{$inputs.goal}}"), { goal: "never stored", run_id: RUN }).done;
    expect(failed.status).toBe("succeeded");
    expect(failed.output).toMatchObject({ kept: false });
  });

  it("[sma:k_d_tpl_milestone] the living retro is written unless retro.living is off, upserts by id, drops a malformed id and cuts model text to one line", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const run = async (goal: string, insights: Row[]) => (await t.start(livingChain(), { goal, run_id: RUN, insights }).done).output as Row;
    t.set("retro.living", "off");
    await run("m0", [{ id: "INS-aaa11111", title: "off", lens: "technical" }]);
    expect(existsSync(join(t.checkout, ".agents/retro"))).toBe(false);
    t.set("retro.living", "yes"); // not a word of the switch: the default, on
    await run("m1", [{ id: "INS-aaa11111", title: "one\n## injected heading", lens: "technical" }, { id: "INS-bbb22222", title: "two", lens: "process" }, { id: "evil\n# x", title: "bad" }]);
    await run("m2", [{ id: "INS-aaa11111", title: "one again", lens: "technical" }, { id: "INS-ccc33333", title: "three", lens: "quality" }]);
    const living = readFileSync(join(t.checkout, ".agents/retro/LIVING.md"), "utf8");
    expect(living.match(/INS-aaa11111/g)).toHaveLength(1);
    expect(living).toMatch(/INS-aaa11111[^\n]*last seen m2/);
    expect(living).toContain("INS-bbb22222"); expect(living).toContain("INS-ccc33333");
    expect(living).not.toMatch(/^## injected/m); expect(living).not.toContain("evil");
    t.state.failWrites = true;
    expect((await t.start(livingChain(), { goal: "m3", run_id: RUN, insights: [{ id: "INS-ddd44444", title: "x" }] }).done).status).toBe("succeeded");
  });

  it("[sma:k_wd_i1] lp.draw: default has no material call and main's entry work; with phase.draw_material on the material node runs and draw is told its path", async () => {
    const off = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f" }, stubs: { draw: { paths: ["f/design/UI-SPEC.md"], feasible: true }, check: { verdict: "pass" } } });
    expect(ranOf(off)).toEqual(["draw", "check", "done"]);
    expect(off.skipped).toEqual(["material"]);
    expect(off.called("material")).toHaveLength(0);
    const on = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f", material: true }, stubs: { material: { material_path: "f/design/MATERIAL.md" }, draw: { paths: ["f/design/UI-SPEC.md"], feasible: true }, check: { verdict: "pass" } } });
    expect(ranOf(on)).toEqual(["material", "draw", "check", "done"]);
    expect(on.called("draw")[0]!.input).toMatchObject({ material_path: "f/design/MATERIAL.md" });
    expect(on.called("check")[0]!.input).toMatchObject({ material_path: "f/design/MATERIAL.md" });
    // The draw step of an off run is given an empty path, and its prompt says what to do only when a path arrives.
    expect(off.called("draw")[0]!.input).toMatchObject({ material_path: "" });
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.draw.json"), "utf8"));
    expect(def.nodes.find((n: Row) => n.id === "check").prompt).toContain("without material_path say nothing about MATERIAL.md");
    expect(autoInputs(fakePhase({}), { kind: "draw" }).material).toBe(false);
    expect(autoInputs(fakePhase({ drawMaterial: "on" }), { kind: "draw" }).material).toBe(true);
  });

  it("[sma:k_d_ref_design] [sma:k_d_ref_sketch] the drawing rules reach the draw and check steps of a run, sketch rules and the animator law included", async () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.draw.json"), "utf8"));
    const prompts = new Map<string, string>();
    const r = await runSim("lp.draw", { input: { goal: "g", pieces: "p1", folder: "f" }, stubs: { agent: ((ctx: { nodeId: string; node: { prompt?: string } }) => { prompts.set(ctx.nodeId, String(ctx.node.prompt)); return { paths: ["f/design/UI-SPEC.md"], feasible: true, verdict: "pass" }; }) as never } });
    expect(ranOf(r)).toEqual(["draw", "check", "done"]);
    for (const node of ["draw", "check"]) {
      expect(prompts.get(node)).toContain(DRAWING_RULES);
      for (const word of ["data-theme", "--<variant>.html", "proto", "static HTML", "150–300 ms"]) expect(prompts.get(node)).toContain(word);
    }
    expect(def.nodes.find((n: Row) => n.id === "material").prompt).toMatch(/patterns.*references.*constraints/s);
  });

  const fakePhase = (record: Partial<PhaseRecord>): Phase => ({ id: "ph_t", projectId: "p", pmThreadId: "pm", runId: "r", title: "t", goal: "g", stage: "planning", state: "active", edition: 1, createdAt: 1, updatedAt: 1, record: record as PhaseRecord });
  const tasks = (...ids: string[]) => ids.map((id) => ({ id, objective: id }));

  it("[sma:k_wp_research] [sma:k_wp_patterns] [sma:k_wp_validation] plan inputs are off unless the phase record says on, and never on the check path", () => {
    const plan = (record: Partial<PhaseRecord>) => autoInputs(fakePhase(record), { kind: "plan" });
    expect(plan({})).toMatchObject({ skip_research: true, patterns: false, validation: false });
    expect(plan({ research: "on", patternMap: "on", validation: "on" })).toMatchObject({ skip_research: false, patterns: true, validation: true });
    const checkPhase = fakePhase({ validation: "on", research: "on", patternMap: "on", plan: planOf("a", []) as never });
    expect(autoInputs(checkPhase, { kind: "check" })).toMatchObject({ skip_research: true, patterns: false, validation: false });
  });

  it("[sma:k_wp_research] [sma:k_wp_patterns] [sma:k_wp_validation] lp.plan: default visits main's nodes; with the switches on research, patterns and strategy run and feed the plan", async () => {
    const stubs = { plan: { tasks: tasks("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass" } };
    const off = await runSim("lp.plan", { input: { goal: "g" }, stubs });
    expect(ranOf(off)).toEqual(["plan", "lint", "check", "plan_critic", "ok"]);          // main's list: plan lint check plan_critic ok
    expect(off.called("strategy")).toHaveLength(0);
    expect(emitted(off)).toMatchObject({ status: "ok", validation_md: "" });
    const on = await runSim("lp.plan", { input: { goal: "g", skip_research: false, patterns: true, validation: true }, stubs: { ...stubs, research: { research_md: "R" }, patterns: { patterns_md: "P" }, strategy: { validation_md: "V" } } });
    expect(ranOf(on)).toEqual(["research", "patterns", "strategy", "plan", "lint", "check", "plan_critic", "ok"]);
    expect(emitted(on)).toMatchObject({ research_md: "R", patterns_md: "P", validation_md: "V" });
    expect(on.called("plan")[0]!.input).toMatchObject({ research_md: "R", patterns_md: "P", validation_md: "V" });
    // quick mode never runs the strategy, whatever the switch says.
    const quick = await runSim("lp.plan", { input: { goal: "g", validation: true }, mode: "quick", stubs: { plan: stubs.plan } });
    expect(ranOf(quick)).toEqual(["plan", "lint", "ok"]);
  });

  it("[sma:k_ag_pattern] a missing analog is a low finding: it cannot fail a plan, and the critic is told to skip the check path", async () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.plan.json"), "utf8"));
    const plan = def.nodes.find((n: Row) => n.id === "plan"), critic = def.nodes.find((n: Row) => n.id === "plan_critic");
    expect(plan.prompt).toMatch(/every file a task creates.*closest existing analog/s);
    expect(plan.prompt).toContain("no analog");
    expect(critic.prompt).toMatch(/finding of severity low: it never changes the verdict by itself/);
    expect(critic.prompt).toMatch(/Skip this check when plan_sha is set/);
    // The verdict of the plan is the critic's status: a pass with a low finding stays a pass and the plan is ok.
    const low = { file: "PLAN", line: 1, severity: "low", evidence: "src/new.ts has no analog", dimension: "pattern" };
    const r = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan: { tasks: tasks("a", "b", "c"), task_count: 3 }, plan_critic: { status: "pass", findings: [low] } } });
    expect(emitted(r)).toMatchObject({ status: "ok", plan_verdict: "pass" });
  });

  it("[sma:k_wp_research] [sma:k_wp_validation] [sma:k_wp_patterns] apply(plan): a default plan writes nothing beyond main; with documents it never overwrites a hand-edited one", async () => {
    const written: Array<{ path: string; content: string }> = [], book: string[] = [];
    const disk = new Map<string, string>();
    let phase = fakePhase({});
    const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
      api: { plan: async () => phase, planCheck: async () => phase } as never,
      exhausted: async () => undefined, get: () => phase, save: (_id, record) => { phase = { ...phase, record }; }, book: (_p, _s, _k, text) => { book.push(text); },
      writeDocs: async (_p, files) => { const shas: Record<string, string> = {}; for (const f of files) { written.push(f); disk.set(f.path, f.content); shas[f.path] = createHash("sha256").update(f.content).digest("hex"); } return { written: files.map((f) => f.path), shas }; },
      readText: async (_p, path) => disk.get(path) ?? null,
      runtime: () => null, pmIdle: async () => true, now: () => 1,
    });
    const apply = (output: Row) => auto.apply(phase, { kind: "plan", wfRunId: "wf", startedAt: 1 }, { status: "ok", tasks: [{ id: "a", title: "a", objective: "o" }], ...output });
    // Default: research, patterns and validation come back empty (their nodes were skipped): no file.
    await apply({ research_md: "", patterns_md: "", validation_md: "" });
    expect(written).toHaveLength(0);
    // On: absent files are written, and the machine keeps the sha it wrote.
    await apply({ validation_md: "v1", research_md: "r1" });
    expect(written.map((f) => f.path).sort()).toEqual([".agents/phases/ph_t/RESEARCH.md", ".agents/phases/ph_t/VALIDATION.md"]);
    expect(Object.keys(phase.record.preDocShas ?? {})).toHaveLength(2);
    // A second plan run: the files are still what the machine wrote, so they are replaced.
    written.length = 0; await apply({ validation_md: "v2" });
    expect(written.map((f) => f.path)).toEqual([".agents/phases/ph_t/VALIDATION.md"]);
    expect(disk.get(".agents/phases/ph_t/VALIDATION.md")).toBe("v2");
    // A hand edit is kept: the new text goes to VALIDATION.new.md and the book says so.
    disk.set(".agents/phases/ph_t/VALIDATION.md", "my own edit");
    written.length = 0; await apply({ validation_md: "v3" });
    expect(written.map((f) => f.path)).toEqual([".agents/phases/ph_t/VALIDATION.new.md"]);
    expect(disk.get(".agents/phases/ph_t/VALIDATION.md")).toBe("my own edit");
    expect(book.some((line) => /VALIDATION\.md/.test(line) && /\.new\.md/.test(line))).toBe(true);
    // A file nobody on record wrote (no sha kept) is someone's too.
    disk.set(".agents/phases/ph_t/PATTERNS.md", "from before"); written.length = 0; await apply({ patterns_md: "p1" });
    expect(written.map((f) => f.path)).toEqual([".agents/phases/ph_t/PATTERNS.new.md"]);
  });
});
