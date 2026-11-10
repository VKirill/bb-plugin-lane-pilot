import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { noteGateRunStart, finishGateRun } from "../../src/rooms/storage";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
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
      files: { write: async (args: unknown) => { const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input); return { ok: true } as never; } },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services) });
  registerPureActions(engine); registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const start = (workflow: Workflow, inputs: Row = {}) => engine.start({ workflow, inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: checkout, encoding: "utf8" });
  return { bb, db, engine, checkout, spawned, writes, start, git, rt, dispose: () => harness.lifecycle.dispose() };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const chain = (extra: Row): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-chain", name: "D4", description: { en: "c", ru: "ц" }, inputs: [], outputs: [], ...extra });
const wf = (name: string) => parseWorkflow(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", name), "utf8")));
const actionChain = (action: string, out: Record<string, string>): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-chain", name: "D4", description: { en: "c", ru: "ц" },
  inputs: [],
  nodes: [{ id: "go", type: "action", action, out },
    { id: "done", type: "action", action: "emit", map: Object.fromEntries(Object.keys(out).map((k) => [k, `go.${k}`])) }],
  edges: [{ from: "start", to: "go" }, { from: "go", to: "done" }],
});
const lpCloseStub = (): Workflow => parseWorkflow({ schemaVersion: 1, id: "lp.close", name: "Close", description: { en: "c", ru: "ц" },
  inputs: ["goals", "goal", "merged_commits", "insights"].map((name) => ({ name, type: "string" })),
  outputs: [{ name: "status", type: "string", required: true }, { name: "staged", type: "int", required: true }, { name: "report_path", type: "string", required: true }],
  nodes: [{ id: "emit", type: "action", action: "emit", map: { status: "closed", staged: 0, report_path: "'r.md'" } }],
  edges: [{ from: "start", to: "emit" }],
});


describe("parity d4 workflows b1", () => {
  it("[sma:m_sw_ship] the ship screen says the push stays with a person and hands them the command", () => {
    expect(cockpitEn.ckShipLead).toMatch(/push to the repository yourself/i);
    expect(cockpitRu.ckShipLead).toContain("Отправляете в репозиторий вы сами");
    expect(pushCommands({ output: { status: "shipped", commands: ["git push -u origin HEAD", "gh pr create"] } })).toEqual(["git push -u origin HEAD", "gh pr create"]);
    expect(pushCommands({ output: { note: "prepared" } })).toEqual([]);
  });

  it("[sma:k_wr_prepass] a diff with a conflict marker is rework on the prepass alone, before any model", async () => {
    const t = await setup({});
    dispose = t.dispose;
    mkdirSync(join(t.checkout, "src")); writeFileSync(join(t.checkout, "src/bad.ts"), "x\n<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> other\n");
    t.git("add", "."); t.git("commit", "-q", "-m", "bad");
    const summary = await t.start(wf("lp.review.json"), { files: ["src/bad.ts"], dimensions: ["correctness"] }).done;
    console.log("DBG review", JSON.stringify(summary).slice(0, 2000), JSON.stringify(t.engine.snapshot(summary.runId)?.steps.map((s) => [s.node_id, s.state, s.output_json])).slice(0, 2000));
    expect(summary.status).toBe("succeeded");
    expect(summary.output!.status).toBe("rework");
    const findings = summary.output!.findings as Array<{ file: string; severity: string }>;
    expect(findings.some((f) => f.severity === "critical" && /src\/bad\.ts:\d+/.test(f.file))).toBe(true);
    expect(t.spawned).toHaveLength(0);
  });

  it("[sma:k_c_auditms] run_status reads the gate ledger and requirement coverage names uncovered ids", async () => {
    const t = await setup({});
    dispose = t.dispose;
    const head = t.git("add", "."), sha = (t.git("commit", "-q", "-m", "one"), t.git("rev-parse", "HEAD").trim());
    const gate = noteGateRunStart(t.db, { projectId: PROJECT, runId: RUN, scopeKey: "s", command: "npm test", batch: [] });
    finishGateRun(t.db, gate, "failed", { head: sha, reason: "red" });
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "- REQ-1 export\n- REQ-2 report\n");
    insertPhase(t.db, { id: "ph_done", projectId: PROJECT, pmThreadId: PM, title: "t", goal: "g", at: 1 });
    savePhase(t.db, "ph_done", { stage: "closed", state: "closed", record: { plan: { items: [{ id: "a", title: "a", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {}, covers: ["REQ-1"] }], sha: "s", contextSha: "c", submittedAt: 1 } } as PhaseRecord, at: 2 });
    const status = await t.start(actionChain("lp.run_status", { open_tasks: "int", failed_tasks: "int", unmerged: "int", gate_ok: "bool", running_attempts: "int", merged_commits: "string[]" })).done;
    expect(status.output!.gate_ok).toBe(false);
    const cov = await t.start(actionChain("lp.requirement_coverage", { uncovered: "string[]", covered: "string[]", total: "int" })).done;
    expect(cov.output!.uncovered).toEqual(["REQ-2"]);
  });

  it("[sma:k_ws_fullgate] the gate mark is ok only for a passed run on this head within six hours", async () => {
    const t = await setup({});
    dispose = t.dispose;
    t.git("add", "."); t.git("commit", "-q", "-m", "one");
    const head = t.git("rev-parse", "HEAD").trim();
    const run = async () => (await t.start(actionChain("lp.integration_gate_status", { ok: "bool", failing: "string[]", reason: "string" })).done).output! as Row;
    const note = (state: "passed" | "failed", ghead: string | null, age = 0) => {
      const id = noteGateRunStart(t.db, { projectId: PROJECT, runId: RUN, scopeKey: "s", command: "npm test", batch: [] });
      finishGateRun(t.db, id, state, { head: ghead });
      if (age) t.db.prepare("UPDATE lane_pilot_gate_run SET updated_at=? WHERE id=?").run(Date.now() - age, id);
    };
    note("failed", head); expect((await run()).ok).toBe(false);
    note("passed", "0".repeat(40)); expect((await run()).ok).toBe(false);
    note("passed", head, 7 * 3_600_000); expect((await run()).ok).toBe(false);
    note("passed", head, 10 * 60_000); expect((await run()).ok).toBe(true);
  });

  it("[sma:k_pl_milestones] [sma:k_d_tpl_milestone] the close snapshots the docs, writes the record and keeps a living retro", { timeout: 30_000 }, async () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "milestone-close.json"), "utf8"));
    const ids = def.nodes.map((n: Row) => n.id);
    for (const id of ["coverage", "living", "record", "snapshot"]) expect(ids).toContain(id);
    expect(def.nodes.find((n: Row) => n.id === "snapshot").action).toBe("lp.milestone_archive");
    expect(def.nodes.find((n: Row) => n.id === "living").action).toBe("lp.retro_living");
    expect(def.nodes.find((n: Row) => n.id === "record").params.path).toContain(".agents/milestones/");
    const ask = def.edges.find((e: Row) => e.to === "ask_finish" && e.from === "coverage");
    expect(ask.when).toContain("coverage.uncovered.length > 0");
    expect(ids.indexOf("record")).toBeLessThan(ids.indexOf("archive"));
    const nm = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "new-milestone.json"), "utf8"));
    expect(nm.entry).toBe("archive");
    expect(nm.nodes.find((n: Row) => n.id === "archive").action).toBe("lp.milestone_archive");

    const t = await setup({});
    dispose = t.dispose;
    mkdirSync(join(t.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "- [x] 1 one\n- [ ] 2 two\n");
    writeFileSync(join(t.checkout, ".agents/planning/REQUIREMENTS.md"), "- REQ-1 export\n");
    const archiveChain = (extra: Row = {}): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-arch", name: "A", description: { en: "c", ru: "ц" },
      inputs: [{ name: "goal", type: "string" }, { name: "run_id", type: "string" }],
      nodes: [{ id: "snap", type: "action", action: "lp.milestone_archive", params: { name: "{{$inputs.goal}}" }, out: { folder: "string", files: "string[]", kept: "bool" } },
        { id: "rec", type: "action", action: "fs.write", params: { path: ".agents/milestones/{{$inputs.run_id}}.md" }, reads: ["$inputs.goal"], out: { record_path: "string" }, ...extra },
        { id: "done", type: "action", action: "emit", map: { folder: "snap.folder", kept: "snap.kept" } }],
      edges: [{ from: "start", to: "snap" }, { from: "snap", to: "rec" }, { from: "rec", to: "done" }] });
    const first = await t.start(archiveChain(), { goal: "m1", run_id: RUN }).done;
    expect(first.status).toBe("succeeded");
    const dir = join(t.checkout, ".agents/planning/milestones/m1");
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toBe(readFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "utf8"));
    expect(readFileSync(join(dir, "REQUIREMENTS.md"), "utf8")).toContain("REQ-1");
    expect(existsSync(join(t.checkout, `.agents/milestones/${RUN}.md`))).toBe(true);
    writeFileSync(join(t.checkout, ".agents/planning/ROADMAP.md"), "- [x] 1 one\n- [x] 2 two\n");
    const second = await t.start(archiveChain(), { goal: "m1", run_id: RUN }).done;
    expect(second.output!.kept).toBe(true);
    expect(readFileSync(join(dir, "ROADMAP.md"), "utf8")).toBe("- [x] 1 one\n- [ ] 2 two\n");

    const livingChain = (): Workflow => parseWorkflow({ schemaVersion: 1, id: "d4-living", name: "L", description: { en: "c", ru: "ц" },
      inputs: [{ name: "insights", type: "Finding[]" }, { name: "goal", type: "string" }, { name: "run_id", type: "string" }],
      nodes: [{ id: "live", type: "action", action: "lp.retro_living", out: { updated: "int", total: "int", path: "string" } },
        { id: "done", type: "action", action: "emit", map: { total: "live.total" } }],
      edges: [{ from: "start", to: "live" }, { from: "live", to: "done" }] });
    await t.start(livingChain(), { goal: "m1", run_id: RUN, insights: [{ id: "INS-aaa11111", title: "one", lens: "technical" }, { id: "INS-bbb22222", title: "two", lens: "process" }] }).done;
    await t.start(livingChain(), { goal: "m2", run_id: RUN, insights: [{ id: "INS-aaa11111", title: "one again", lens: "technical" }, { id: "INS-ccc33333", title: "three", lens: "quality" }] }).done;
    const living = readFileSync(join(t.checkout, ".agents/retro/LIVING.md"), "utf8");
    expect(living.match(/INS-aaa11111/g)).toHaveLength(1);
    expect(living).toMatch(/INS-aaa11111[^\n]*last seen m2/);
    expect(living).toContain("INS-bbb22222");
    expect(living).toContain("INS-ccc33333");
  });

  it("[sma:k_wd_i1] lp.draw gathers material (patterns, references, constraints) before drawing", () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.draw.json"), "utf8"));
    expect(def.entry).toBe("material");
    const ids = def.edges.map((e: Row) => `${e.from}->${e.to}`);
    expect(ids).toEqual(expect.arrayContaining(["material->draw", "draw->check"]));
    const material = def.nodes.find((n: Row) => n.id === "material"), draw = def.nodes.find((n: Row) => n.id === "draw");
    for (const word of ["patterns", "references", "constraints"]) expect(material.prompt).toContain(word);
    expect(draw.consumes).toEqual([{ kind: "report", version: 1, from: "material" }]);
    expect(draw.prompt).toContain("MATERIAL.md");
  });

  it("[sma:k_d_ref_design] [sma:k_d_ref_sketch] draw and check share the drawing rules incl. sketch rules and the animator law", () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.draw.json"), "utf8"));
    const draw = def.nodes.find((n: Row) => n.id === "draw"), check = def.nodes.find((n: Row) => n.id === "check");
    expect(draw.prompt).toContain(DRAWING_RULES);
    expect(check.prompt).toContain(DRAWING_RULES);
    for (const word of ["data-theme", "--<variant>.html", "proto", "static HTML"]) expect(draw.prompt).toContain(word);
    expect(draw.prompt).toContain("150–300 ms");
  });

  const fakePhase = (record: Partial<PhaseRecord>): Phase => ({ id: "ph_t", projectId: "p", pmThreadId: "pm", runId: "r", title: "t", goal: "g", stage: "planning", state: "active", edition: 1, createdAt: 1, updatedAt: 1, record: record as PhaseRecord });

  it("[sma:k_wp_research] [sma:k_wp_patterns] plan inputs skip research by default and map patterns only when the capability is on", () => {
    expect(autoInputs(fakePhase({}), { kind: "plan" }).skip_research).toBe(true);
    expect(autoInputs(fakePhase({ research: "on" }), { kind: "plan" }).skip_research).toBe(false);
    expect(autoInputs(fakePhase({}), { kind: "plan" }).patterns).toBe(false);
    expect(autoInputs(fakePhase({ patternMap: "on" }), { kind: "plan" }).patterns).toBe(true);
  });

  it("[sma:k_wp_research] [sma:k_wp_validation] [sma:k_wp_patterns] apply(plan) writes the pre-plan docs it produced", async () => {
    const written: Array<{ path: string; content: string }> = [];
    const phase = fakePhase({});
    const auto = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
      api: { plan: async () => phase, planCheck: async () => phase } as never,
      exhausted: async () => undefined, get: () => phase, save: () => undefined, book: () => undefined,
      writeDocs: async (_p, files) => { written.push(...files); return { written: files.map((f) => f.path) }; },
      runtime: () => null, pmIdle: async () => true, now: () => 1,
    });
    await auto.apply(phase, { kind: "plan", wfRunId: "wf1", startedAt: 1 }, { status: "ok", tasks: [{ id: "a", title: "a", objective: "o" }], research_md: "research!", validation_md: "validate!", patterns_md: "patterns!" });
    expect(written.map((f) => f.path).sort()).toEqual([".agents/phases/ph_t/PATTERNS.md", ".agents/phases/ph_t/RESEARCH.md", ".agents/phases/ph_t/VALIDATION.md"]);
    written.length = 0;
    await auto.apply(phase, { kind: "plan", wfRunId: "wf2", startedAt: 1 }, { status: "ok", tasks: [{ id: "b", title: "b", objective: "o" }], research_md: "" });
    expect(written).toHaveLength(0);
  });

  it("[sma:k_wp_validation] lp.plan has the strategy step before the plan and still validates", () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.plan.json"), "utf8"));
    const order = def.edges.map((e: Row) => `${e.from}->${e.to}`);
    expect(def.entry).toBe("research");
    expect(order.slice(0, 4)).toEqual(expect.arrayContaining(["research->patterns", "patterns->strategy", "strategy->plan"]));
    expect(() => wf("lp.plan.json")).not.toThrow();
  });

  it("[sma:k_ag_pattern] the planner names an analog per new file and the critic checks it", () => {
    const def = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.plan.json"), "utf8"));
    const plan = def.nodes.find((n: Row) => n.id === "plan"), critic = def.nodes.find((n: Row) => n.id === "plan_critic");
    expect(plan.prompt).toMatch(/every file a task creates.*closest existing analog/s);
    expect(plan.prompt).toContain("no analog");
    expect(critic.prompt).toMatch(/no analog.*finding|analog.*finding/s);
  });
});
