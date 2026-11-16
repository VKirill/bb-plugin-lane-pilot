// Region 16 (slash commands and workflows), batch h: project start, workspaces and the profile (n1349 … n1367).
// The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_h_probe.ts) share. Each `observeH.<smaId>()` runs the REAL code of the node
// (the real workflow engine on the real graph files with the real lp.* executors against a temp git checkout, the real host handlers, the real `profile` CLI verb, the real
// worktree removal on a temp repository) and returns plain data. No vitest import: the probe loads this file under vite-node. No model (agent nodes answer from a table and
// keep the prompt as rendered), no hub, nothing outside the machine. Batches a to d keep their observations in r16-world*.ts (not edited here).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import plugin from "../../server";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { createRun, loadProjectSettings, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { PROFILE_KEYS } from "../../src/rooms/anamnesis";
import { ownsPathProblems } from "../../src/rooms/phase";
import { readBoundedFile, runCommand, gitRemoveWorktree } from "../../src/rooms/host-worker/host-handlers";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { runSim } from "../workflow/chain-harness";
import type { SimResult } from "../workflow/chain-harness";

type Row = Record<string, unknown>;
const PROJECT = "h-project", OTHER = "h-other", PM = "h-pm", RUN = "h-run";

const wfPath = (name: string) => join(process.cwd(), "workflows", name);
export const wfFile = (name: string) => parseWorkflow(JSON.parse(readFileSync(wfPath(name), "utf8")));
export const wfSource = (name: string) => JSON.parse(readFileSync(wfPath(name), "utf8")) as { nodes: Array<Row & { id: string; prompt?: string; params?: Row }> };
const pathOf = (r: SimResult) => r.path.join(" ");
const out = (r: SimResult) => r.summary.output as Row;
const costly = (r: SimResult) => r.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id))
  .filter((id) => ["agent", "human", "lp-task", "subworkflow", "parallel"].includes(String(r.workflow.nodes.find((n) => n.id === id)?.type)));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// ---------------------------------------------------------------- the real engine on a temp git checkout (project-start and its executors)
/** As BB core's write: a null hash only creates (a file that exists answers `conflict` and stays), a hash must match, no hash replaces. */
const bbWrite = (writes: Array<{ path: string; content: string; expectedSha256?: string | null }>) => async (args: unknown) => {
  const input = args as { path: string; content: string; expectedSha256?: string | null };
  const now = existsSync(input.path) ? createHash("sha256").update(readFileSync(input.path)).digest("hex") : null;
  if (input.expectedSha256 !== undefined && input.expectedSha256 !== now) return { outcome: "conflict", currentSha256: now } as never;
  mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input);
  return { outcome: "written", currentSha256: createHash("sha256").update(input.content).digest("hex") } as never;
};

async function startRig() {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "lp-h-start-")));
  git(checkout, "init", "-q");
  writeFileSync(join(checkout, "README.md"), "hello\n");
  git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", "init");
  const writes: Array<{ path: string; content: string; expectedSha256?: string | null }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      if (call.method === "readBoundedFile") return readBoundedFile(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async () => { throw new Error("no thread is spawned in this world"); },
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async () => [] }, send: async () => ({}) as never, stop: async () => ({ ok: true }) as never, output: async () => ({ output: "no script" }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        write: bbWrite(writes),
        // As BB core's read: a missing path throws file_not_found; a present one answers exact utf8 bytes and hash.
        read: async (args: unknown) => {
          const input = args as { path: string };
          if (!existsSync(input.path)) { const error = new Error("file_not_found") as Error & { code?: string; serverCode?: string }; error.code = "not_found"; error.serverCode = "file_not_found"; throw error; }
          const content = readFileSync(input.path, "utf8");
          return { content, sha256: createHash("sha256").update(content, "utf8").digest("hex"), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8" } as never;
        },
      },
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
  const set = (key: string, value: string) => saveProjectSetting(db, PROJECT, key, value);
  const put = (path: string, text: string) => { mkdirSync(dirname(join(checkout, path)), { recursive: true }); writeFileSync(join(checkout, path), text); };
  const commit = (path: string, text: string) => { put(path, text); git(checkout, "add", "."); git(checkout, "commit", "-q", "-m", path); };
  return { db, engine, checkout, writes, start, set, put, commit, rt, dispose: () => harness.lifecycle.dispose() };
}
type StartRig = Awaited<ReturnType<typeof startRig>>;

/** Agent nodes answer from a table by node id (the fake host has no models); every call keeps the prompt as the engine rendered it. */
function stubModels(t: { engine: WorkflowEngine }, answers: Record<string, Row>) {
  const seen = new Map<string, number>(), calls: Array<{ node: string; prompt: string }> = [];
  t.engine.register("agent", { reentrant: true, run: async (ctx: { nodeId: string; node: { prompt?: string }; render: (text: string) => string }) => {
    seen.set(ctx.nodeId, (seen.get(ctx.nodeId) ?? 0) + 1); calls.push({ node: ctx.nodeId, prompt: String(ctx.render(ctx.node.prompt ?? "")) });
    return { output: { handoff: `${ctx.nodeId} done`, ...(answers[ctx.nodeId] ?? {}) } };
  } } as never);
  return calls;
}
const executed = (t: { engine: WorkflowEngine }, runId: string) => (t.engine.snapshot(runId)?.steps ?? []).filter((step) => step.state === "succeeded" && !/:(fan|child)$/.test(step.node_id)).map((step) => step.node_id);
const skippedOf = (t: { engine: WorkflowEngine }, runId: string) => (t.engine.snapshot(runId)?.steps ?? []).filter((step) => step.state === "skipped").map((step) => step.node_id);
const actionChain = (action: string, outs: Record<string, string>, params?: Row): Workflow => parseWorkflow({ schemaVersion: 1, id: "h-chain", name: "H", description: { en: "c", ru: "ц" },
  nodes: [{ id: "go", type: "action", action, out: outs, ...(params ? { params } : {}) },
    { id: "done", type: "action", action: "emit", map: Object.fromEntries(Object.keys(outs).map((k) => [k, `go.${k}`])) }],
  edges: [{ from: "start", to: "go" }, { from: "go", to: "done" }],
});
const STUBS = { value_map: { document: "for shop owners" }, preview: { stack: {}, memory: {}, profile: {} }, research: { research_notes: "n", stack: "", features: "", architecture: "", pitfalls: "" }, requirements: { requirements: [], document: "" }, recap: { next_steps: ["a", "b", "c"], roadmap_draft: "# roadmap\n", project_document: "# project\n", phases: ["1 first"] } };
const planning = (t: StartRig, ...files: string[]) => { for (const file of files) t.put(`.agents/planning/${file}`, "x\n"); };

// ---------------------------------------------------------------- the real `bb lane-pilot profile` verb on the plugin
async function cliRig() {
  const threadProject: Record<string, string> = {}, threadRole: Record<string, string> = {};
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async ({ threadId }) => ({ role: threadRole[threadId] ?? "writer" }),
    get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: threadProject[threadId] ?? PROJECT }),
  } } });
  await plugin(bb);
  const db = openDatabase(bb);
  const run = async (args: string[], threadId?: string) => {
    const result = await harness.behavior.runCli(["profile", ...args], threadId ? { threadId } : undefined);
    return { exitCode: result.exitCode, text: `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`, stdout: String(result.stdout ?? "") };
  };
  const profile = () => Object.fromEntries(Object.entries(loadProjectSettings(db, PROJECT)).filter(([key]) => key.startsWith("profile.")));
  return { db, run, profile, threadProject, threadRole, dispose: () => harness.lifecycle.dispose() };
}

async function within<T>(rig: { dispose: () => Promise<void> | void }, body: () => Promise<T>): Promise<T> {
  try { return await body(); } finally { await rig.dispose(); }
}

// ---------------------------------------------------------------- plan-import: the owner's external plan
const IMPORT_STUBS = { "grill-plan": { open: ["conflicts with locked decision D3"], risk_register: [] }, pieces: { pieces: [{ id: "p1", task: { owns_paths: ["src/**"] } }], waves: [["p1"]] } };
const ADR = "# ADR-7: orders move to Postgres\n\nStatus: accepted. Orders are written to Postgres; the queue stays Redis.";

export const observeH = {
  // ---- /sma-import (n1349)
  async k_c_import() {
    const conflicted = await runSim("plan-import", { input: { plan: "step 1: move orders", goal: "g" }, stubs: IMPORT_STUBS, humans: { resolve: { answer_kind: "resolved", answer: "keep D3" } } });
    const clean = await runSim("plan-import", { input: { plan: "step 1", goal: "g" }, stubs: { ...IMPORT_STUBS, "grill-plan": { open: [], risk_register: [] } } });
    const refused = await runSim("plan-import", { input: { plan: "step 1", goal: "g" }, stubs: IMPORT_STUBS, humans: { resolve: { answer_kind: "abort", answer: "" } } });
    const invalid = await runSim("plan-import", { input: { plan: "step 1", goal: "g" }, stubs: { ...IMPORT_STUBS, "lp.plan_import_check": { ok: false, problems: ["p1: owns_paths «../x» is not a path inside the checkout"] } }, humans: { resolve: { answer_kind: "resolved", answer: "keep D3" } } });
    return {
      conflicted: { path: pathOf(conflicted), out: out(conflicted), asked: conflicted.called("resolve").length },
      clean: { path: pathOf(clean), skipped: clean.skipped, out: out(clean) },
      aborted: { path: pathOf(refused), out: out(refused), piecesAsked: refused.called("pieces").length },
      invalid: { path: pathOf(invalid), out: out(invalid) },
      ownsEscaping: ownsPathProblems("p1", ["../x", "/etc/**", "src/**"]),
      ownsInside: ownsPathProblems("p1", ["src/**", "docs/a.md"]),
    };
  },
  // ---- /sma-ingest-docs (n1350): the repository's ADRs and specs enter as the plan text of plan-import
  async k_c_ingest() {
    const stubs = { ...IMPORT_STUBS, "grill-plan": { open: ["ADR-7 contradicts the locked decision D3 (the queue is Redis)"], risk_register: [{ id: "r1" }] } };
    const run = await runSim("plan-import", { input: { plan: ADR, goal: "move orders to Postgres" }, stubs, humans: { resolve: { answer_kind: "resolved", answer: "D3 stands" } } });
    const asked = run.called("grill")[0]?.input ?? {};
    return { grillSaw: asked, path: pathOf(run), out: out(run), hasIngestGraph: existsSync(wfPath("ingest-docs.json")) };
  },
  // ---- remove-workspace (n1353): a real repository with two Lane Pilot worktrees under <root>/<repo>/<id>
  async k_c_rmws() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "lp-h-rmws-")));
    const base = join(dir, "projects", "app");
    mkdirSync(base, { recursive: true });
    git(base, "init", "-q", "-b", "main");
    writeFileSync(join(base, "a.txt"), "a\n"); git(base, "add", "."); git(base, "commit", "-qm", "init");
    const laneRoot = join(dir, ".lane-pilot", "worktrees");
    const add = (name: string) => { const path = join(laneRoot, "app", name); git(base, "worktree", "add", "-q", "-b", `lane/${name}`, path, "HEAD"); return path; };
    const first = add("lpattempt_h1"), second = add("lpattempt_h2");
    writeFileSync(join(first, "work.txt"), "w\n"); git(first, "add", "."); git(first, "commit", "-qm", "work");
    // the work of the first copy is in main (cherry-picked); the second holds nothing new
    git(base, "cherry-pick", git(first, "rev-parse", "HEAD").trim());
    const listed = () => git(base, "worktree", "list", "--porcelain");
    const gone = async (path: string) => { const answer = await gitRemoveWorktree({ requestedHostId: "h1", basePath: base, worktreePath: path }, {} as never); return answer; };
    const one = await gone(first);
    const after1 = { removed: one.removed, folder: existsSync(first), listed: listed().includes(first), otherKept: existsSync(second) && listed().includes(second), branch: git(base, "branch", "--list", "lane/lpattempt_h1").trim(), parent: existsSync(join(laneRoot, "app")) };
    const two = await gone(second);
    const after2 = { removed: two.removed, folder: existsSync(second), listed: listed().includes(second), branch: git(base, "branch", "--list", "lane/lpattempt_h2").trim(), parent: existsSync(join(laneRoot, "app")), main: readdirSync(base).filter((name) => !name.startsWith(".")).sort() };
    return { after1, after2 };
  },
  // ---- the start of a project: value map before any question (n1354), the five numbers counted from the tree (n1361)
  async k_wst_map() {
    const t = await startRig();
    return within(t, async () => {
      for (const [file, body] of [["src/a.ts", "a\n"], ["src/b.ts", "b\n"], ["src/c.ts", "c\n"], ["tests/a.test.ts", "a\n"], ["tests/b.test.ts", "b\n"], [".agents/planning/STATE.md", "s\n"]] as const) t.commit(file, body);
      t.set("project.start_research", "on");
      planning(t, "PROFILE.md");
      const calls = stubModels(t, STUBS);
      const summary = await t.start(wfFile("project-start.json"), {}).done;
      const prompt = calls.find((call) => call.node === "value_map")?.prompt ?? "";
      const commits = Number(/commits (\d+)\./.exec(prompt)?.[1] ?? -1);
      // a person is asked only after the map: the sim of the same graph with no profile on disk
      const asked = await runSim("project-start", { input: {}, stubs: { "lp.tree_counts": { enabled: "on" }, "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false }, "lp.profile_write": { refused: [], set: [] }, ...STUBS }, humans: { ask: { answer_kind: "answered" } } });
      return { status: summary.status, order: executed(t, summary.runId), prompt, tail: prompt.slice(prompt.indexOf("verbatim:")), commits, askOrder: costly(asked), askPath: pathOf(asked) };
    });
  },
  async k_v_startmap() {
    const t = await startRig();
    return within(t, async () => {
      for (const [file, body] of [["src/a.ts", "a\n"], ["src/b.ts", "b\n"], ["src/c.tsx", "c\n"], ["tests/a.test.ts", "a\n"], ["tests/b.test.ts", "b\n"], ["docs/x.md", "x\n"], ["logo.png", "png\n"], [".agents/planning/STATE.md", "s\n"]] as const) t.commit(file, body);
      const outs = { enabled: "string", sources: "int", tests: "int", docs: "int", planning: "int", commits: "int", counts_note: "string" };
      const params = { counts_note: "Open VALUE-MAP.md with these five lines counted from the tree itself, verbatim:" };
      t.set("project.start_research", "off");
      const off = (await t.start(actionChain("lp.tree_counts", outs, params)).done).output as Row;
      t.set("project.start_research", "on");
      const on = (await t.start(actionChain("lp.tree_counts", outs, params)).done).output as Row;
      return { off, on, headCommits: Number(git(t.checkout, "rev-list", "--count", "HEAD").trim()) };
    });
  },
  // ---- quick path (n1355): an existing install is asked only for what is missing
  async k_wst_quick() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      planning(t, "VALUE-MAP.md", "ROADMAP.md", "PROFILE.md");
      const calls = stubModels(t, STUBS);
      const resumed = await t.start(wfFile("project-start.json"), {}).done;
      const probe = { "lp.tree_counts": { enabled: "on" }, "lp.profile_write": { refused: [], set: [] }, research: STUBS.research, requirements: STUBS.requirements, recap: STUBS.recap, preview: STUBS.preview };
      const roadmapMissing = await runSim("project-start", { input: {}, stubs: { ...probe, "lp.state_probe": { has_value_map: true, has_roadmap: false, has_profile: true } } });
      const profileMissing = await runSim("project-start", { input: {}, stubs: { ...probe, "lp.state_probe": { has_value_map: true, has_roadmap: true, has_profile: false } }, humans: { ask: { answer: "audience: shop owners", answer_kind: "answered" } } });
      const nothing = await runSim("project-start", { input: {}, stubs: { ...probe, "lp.state_probe": { has_value_map: false, has_roadmap: false, has_profile: false } }, humans: { ask: { answer: "x", answer_kind: "answered" } } });
      return {
        resumed: { executed: executed(t, resumed.runId), modelCalls: calls.length, output: resumed.output },
        roadmapMissing: { costly: costly(roadmapMissing), skipped: roadmapMissing.skipped },
        profileMissing: { costly: costly(profileMissing), skipped: profileMissing.skipped },
        nothing: { costly: costly(nothing) },
      };
    });
  },
  // ---- Project: PROJECT.md and the roadmap skeleton are the recap's (n1356)
  async k_wst_project() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      planning(t, "PROFILE.md");
      const calls = stubModels(t, STUBS);
      const fresh = await t.start(wfFile("project-start.json"), {}).done;
      const prompt = calls.find((call) => call.node === "recap")?.prompt ?? "";
      planning(t, "ROADMAP.md");
      const again = await t.start(wfFile("project-start.json"), {}).done;
      return { fresh: { executed: executed(t, fresh.runId), nextSteps: (fresh.output as Row).next_steps, prompt }, withRoadmap: { executed: executed(t, again.runId), skipped: skippedOf(t, again.runId), nextSteps: (again.output as Row).next_steps } };
    });
  },
  // ---- Stack, tests and the preview: what the preview answers becomes the project's profile (n1357)
  async k_wst_stack() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      planning(t, "PROFILE.md");
      const preview = { stack: { language: "typescript" }, memory: { areas: ["src"] }, profile: { stack: "typescript, vitest", test_command: "npm test" } };
      const calls = stubModels(t, { ...STUBS, preview });
      const summary = await t.start(wfFile("project-start.json"), {}).done;
      const order = executed(t, summary.runId);
      const settings = loadProjectSettings(t.db, PROJECT);
      return { status: summary.status, order, previewBeforeWriter: order.indexOf("preview") < order.indexOf("profile_write") && order.indexOf("value_map") < order.indexOf("preview"), modelCalls: calls.map((call) => call.node),
        stored: Object.fromEntries(Object.entries(settings).filter(([key]) => key.startsWith("profile."))), refused: (summary.output as Row).refused };
    });
  },
  // ---- Infra profile: the eight keys the preview is told to return are the ones the writer takes (n1358)
  async k_wst_infra() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      planning(t, "PROFILE.md");
      const profile = { stack: "node", test_command: "npm test", release: "tag", hosts: "ovh", start: "pm2 start", deploy: "scripts/deploy.sh", logs: "pm2 logs", style: "terse", flavour: "x" };
      const calls = stubModels(t, { ...STUBS, preview: { stack: {}, memory: {}, profile } });
      const summary = await t.start(wfFile("project-start.json"), {}).done;
      const prompt = calls.find((call) => call.node === "preview")?.prompt ?? "";
      const told = /only these keys: ([a-z_, ]+);/.exec(prompt)?.[1]?.split(",").map((key) => key.trim()) ?? [];
      const stored = Object.fromEntries(Object.entries(loadProjectSettings(t.db, PROJECT)).filter(([key]) => key.startsWith("profile.")));
      return { told, accepted: [...PROFILE_KEYS], stored, refused: (summary.output as Row).refused };
    });
  },
  // ---- Working style and risk: the style goes into the starter notes (n1359)
  async k_wst_style() {
    const t = await startRig();
    return within(t, async () => {
      const outs = { refused: "string[]", set: "string[]", reasons: "string[]" };
      t.put("AGENTS.md", "# mine\nwritten by a person\n");
      const done = (await t.start(actionChain("lp.profile_write", outs, { profile: { stack: "typescript", test_command: "npm test", style: "small functions, no comments" } })).done).output as Row;
      const read = (path: string) => (existsSync(join(t.checkout, path)) ? readFileSync(join(t.checkout, path), "utf8") : null);
      return { done, projectMd: read(".agents/planning/PROJECT.md"), agentsMd: read("AGENTS.md"), claudeMd: read("CLAUDE.md"), copilot: read(".github/copilot-instructions.md") };
    });
  },
  // ---- Recap and next steps (n1360)
  async k_wst_close() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      planning(t, "PROFILE.md");
      const calls = stubModels(t, STUBS);
      const summary = await t.start(wfFile("project-start.json"), {}).done;
      const noteOf = (id: string) => String(wfSource("project-start.json").nodes.find((n) => n.id === "tree")?.params?.[id] ?? "");
      return { output: summary.output, prompt: calls.find((call) => call.node === "recap")?.prompt ?? "", recapNote: noteOf("recap_note"), profileNote: noteOf("profile_note"), order: executed(t, summary.runId) };
    });
  },
  // ---- the value map builder: «show first, ask later» (n1364)
  async k_lib_startmap() {
    const t = await startRig();
    return within(t, async () => {
      t.set("project.start_research", "on");
      t.commit("src/a.ts", "a\n");
      planning(t, "PROFILE.md");
      const calls = stubModels(t, STUBS);
      const fresh = await t.start(wfFile("project-start.json"), {}).done;
      planning(t, "VALUE-MAP.md");
      // Only the map is present: the first run's ROADMAP.md/PROJECT.md/PROFILE.md go away, so this start is not resumed
      // and the value-map skip is what shows (an all-present install is the resumed case of k_wst_quick).
      for (const file of ["ROADMAP.md", "PROJECT.md", "REQUIREMENTS.md", "ROADMAP.new.md", "PROJECT.new.md", "REQUIREMENTS.new.md", "profile.json"]) rmSync(join(t.checkout, ".agents/planning", file), { force: true });
      const had = await t.start(wfFile("project-start.json"), {}).done;
      return { fresh: { executed: executed(t, fresh.runId), valueMap: (fresh.output as Row).value_map, prompt: calls.find((call) => call.node === "value_map")?.prompt ?? "" },
        had: { skipped: skippedOf(t, had.runId), valueMap: (had.output as Row).value_map }, valueMapCalls: calls.filter((call) => call.node === "value_map").length };
    });
  },
  // ---- the profile verb (n1363) and its reader (n1366)
  async k_v_profile() {
    const m = await cliRig();
    return within(m, async () => {
      const empty = JSON.parse((await m.run([PROJECT])).stdout) as Row;
      const set = await m.run([PROJECT, "--set", "test_command=npm test -- --grep=a=b", "--set", "stack=typescript"]);
      const read = JSON.parse((await m.run([PROJECT])).stdout) as Row;
      const secret = await m.run([PROJECT, "--set", "release=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
      const unknown = await m.run([PROJECT, "--set", "flavour=x"]);
      const afterRefusals = m.profile();
      m.threadRole["thr-writer"] = "writer"; m.threadProject["thr-writer"] = PROJECT;
      const fromWriter = await m.run([PROJECT, "--set", "stack=go"], "thr-writer");
      const reset = await m.run([PROJECT, "--set", "stack="]);
      const noProject = await m.run([]);
      return { emptyKeys: Object.keys(empty), emptyValues: [...new Set(Object.values(empty))], set: set.exitCode, read, secret: { exitCode: secret.exitCode, text: secret.text }, unknown: { exitCode: unknown.exitCode, text: unknown.text },
        afterRefusals, fromWriter: { exitCode: fromWriter.exitCode, text: fromWriter.text }, resetExit: reset.exitCode, afterReset: m.profile(), noProject: { exitCode: noProject.exitCode, text: noProject.text } };
    });
  },
  async k_lib_profile() {
    const m = await cliRig();
    return within(m, async () => {
      saveProjectSetting(m.db, GLOBAL_SETTINGS_PROJECT_ID, "profile.style", "terse");
      saveProjectSetting(m.db, GLOBAL_SETTINGS_PROJECT_ID, "profile.hosts", "global-host");
      saveProjectSetting(m.db, PROJECT, "profile.hosts", "project-host");
      saveProjectSetting(m.db, PROJECT, "profile.stack", "typescript");
      saveProjectSetting(m.db, OTHER, "profile.stack", "php");
      const loaded = loadProjectSettings(m.db, PROJECT);
      const viaVerb = JSON.parse((await m.run([PROJECT])).stdout) as Row;
      const other = JSON.parse((await m.run([OTHER])).stdout) as Row;
      return { loaded: Object.fromEntries(Object.entries(loaded).filter(([key]) => key.startsWith("profile."))), viaVerb, otherStack: other["profile.stack"], otherStyle: other["profile.style"], otherHosts: other["profile.hosts"] };
    });
  },
  // ---- the one profile writer (n1367)
  async k_lib_profilewriter() {
    const t = await startRig();
    return within(t, async () => {
      const outs = { refused: "string[]", set: "string[]", reasons: "string[]" };
      const profile = { stack: "typescript", test_command: "npm test", db_password: "hunter2", release: `sk-${"a".repeat(24)}`, flavour: "x", deploy: "manual" };
      const written = (await t.start(actionChain("lp.profile_write", outs, { profile })).done).output as Row;
      const stored = Object.fromEntries(Object.entries(loadProjectSettings(t.db, PROJECT)).filter(([key]) => key.startsWith("profile.")));
      const files = t.writes.map((w) => w.content).join("\n");
      const none = (await t.start(actionChain("lp.profile_write", outs, { profile: { token: "x" } })).done).output as Row;
      return { written, stored, secretsInRows: JSON.stringify(stored) + JSON.stringify(written), secretsInFiles: files, none };
    });
  },
};
