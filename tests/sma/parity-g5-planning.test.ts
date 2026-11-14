import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import type { Services } from "../../server";
import { bundledAgents, planningHomeOf, resetPlanningHomeChecks, resolvePlanningHome } from "../../src/rooms/contracts";
import { createCore } from "../../src/rooms/core/server/core";
import { docsCompletenessGaps } from "../../src/rooms/docs/docs-lint";
import { gateRun, gitCommitDocs, readBoundedFile, runCommand, writePhaseBook } from "../../src/rooms/host-worker/host-handlers";
import { nextAction, planSignature, phaseFolder, type PhaseRecord } from "../../src/rooms/phase/logic";
import { autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { runPhaseCli } from "../../src/rooms/phase/server/cli";
import { installDocs } from "../../src/rooms/phase/server/driver-docs";
import { getPhase, insertPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { createPhaseDriver } from "../phase-driver";
import { createRun, getSettingVersions, loadProjectSettings, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { planningHomeInputs } from "../../src/rooms/storage";
import { pmBoardBlock } from "../../src/rooms/learning/pm-rules";
import { issueMessage } from "../../src/rooms/backlog/logic";
import { createBacklog } from "../../src/rooms/backlog/server";
import { projectLifePrompt } from "../../src/rooms/project-life/project-life";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import { taskUsage, registerDispatchExecutors } from "../../src/rooms/writer/server";
import { sha256Hex } from "@lane-pilot/kit";

type Row = Record<string, unknown>;
const PROJECT = "g5-project", OTHER = "g5-other", PM = "g5-pm", RUN = "g5-run", PHASE = "ph_g5plan";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
/** A real git work tree with one commit, so a commit made in it is visible with `git log`. */
function repo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
/** On for the tests that need BB's real hash rule on a write; the older tests re-write a file with a null hash. */
const STRICT_WRITES = { on: false };
const put = (root: string, path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const changedBy = (cwd: string) => git(cwd, "show", "--name-only", "--format=", "HEAD").trim().split("\n").filter(Boolean);
const config = (projectId: string, checkout: string) => ({ projectId, hostId: "local", pmWorkspacePath: checkout, writerWorkspacePath: checkout, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "claude-code", writerModel: "m" });

/** One workflow of a single action node, in the format the engine validates: the action's `out` is mapped to the run's outputs. */
const OUT_TYPES: Record<string, string> = { bool: "boolean", int: "number", string: "string", "string[]": "array" };
function actionWorkflow(action: string, node: Row, out: Record<string, string>, inputNames: string[] = []) {
  return parseWorkflow({ schemaVersion: 1, id: "g5-action", name: "G5 action", description: { en: action, ru: action }, inputs: inputNames.map((name) => ({ name, type: "string", required: false })),
    outputs: Object.entries(out).map(([name, type]) => ({ name, type: OUT_TYPES[type]!, required: false })),
    nodes: [{ id: "a", type: "action", action, title: { en: action, ru: action }, ...node, out }, { id: "end", type: "action", action: "emit", map: Object.fromEntries(Object.keys(out).map((key) => [key, `a.${key}`])) }],
    edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }] } as never);
}

let disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); resetPlanningHomeChecks(); });

/** One project on a real temp checkout, a real host (its own handlers run against real directories and real git), and every host call logged. */
function rig(options: { home?: string; settings?: Record<string, unknown> } = {}) {
  const checkout = repo("g5-checkout-");
  const hostLog: Array<{ method: string; cwd?: string; command?: string }> = [];
  const spawned: Row[] = [];
  const threadProject: Record<string, string> = { [PM]: PROJECT };
  const threadRole: Record<string, string> = { [PM]: "pm" };
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => {
      const input = call.input;
      hostLog.push({ method: call.method, cwd: (input.cwd ?? input.projectCwd ?? input.basePath) as string | undefined, command: input.command as string | undefined });
      if (call.method === "runCommand") return runCommand(input as never, undefined as never);
      if (call.method === "readBoundedFile") return readBoundedFile(input as never, undefined as never);
      if (call.method === "writePhaseBook") return writePhaseBook(input as never, undefined as never);
      if (call.method === "gitCommitDocs") return gitCommitDocs(input as never, undefined as never);
      if (call.method === "gateRun") return gateRun(input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => ({ role: threadRole[threadId] ?? "writer", lanePilotRunId: RUN }),
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId: threadProject[threadId] ?? PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        spawn: async (args) => { spawned.push(args as unknown as Row); throw new Error("SPAWNED"); },
        events: { list: async () => [] }, send: async () => ({}) as never, stop: async () => ({ ok: true }) as never, output: async () => ({ output: "" }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }), list: async () => [{ id: PROJECT, name: "Project", kind: "standard" }] as never },
      // As BB core's write: a null hash only creates, a given hash must match the file, no hash at all replaces.
      files: { write: async (args: unknown) => {
        const input = args as { path: string; content: string; expectedSha256?: string | null };
        const now = existsSync(input.path) ? createHash("sha256").update(readFileSync(input.path)).digest("hex") : null;
        if (STRICT_WRITES.on && input.expectedSha256 !== undefined && input.expectedSha256 !== now) return { outcome: "conflict", currentSha256: now } as never;
        mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); return { ok: true } as never;
      } },
    },
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  savePrototypeConfig(db, config(PROJECT, checkout));
  if (options.home) saveProjectSetting(db, PROJECT, "project.planning_home", options.home);
  const ctx = createCore(bb, db);
  const warn = vi.spyOn(bb.log, "warn");
  disposers.push(() => harness.lifecycle.dispose());
  const services = {
    readWriterWorkspaceFile: async (i: { path: string }) => {
      const file = join(checkout, i.path);
      if (!existsSync(file)) throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${file}'`), { code: "ENOENT" });
      const content = readFileSync(file, "utf8");
      return { content, sha256: sha256Hex(content), sizeBytes: content.length, truncated: false };
    },
    runBudgets: { get: () => undefined }, rollback: { noteStopped: async () => ({ recorded: true }) },
    dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage,
  } as unknown as Services;
  const docs = installDocs({ ctx, services: services as never, db, bb, now: () => Date.parse("2026-11-01T10:00:00Z"), reactions: {} as never });
  insertPhase(db, { id: PHASE, projectId: PROJECT, pmThreadId: PM, title: "Plan", goal: "plan the thing", runId: RUN, at: 1 });
  const phase = () => getPhase(db, PHASE)!;
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  return { checkout, db, bb, harness, ctx, services, docs, phase, hostLog, spawned, warn, rt, threadProject, threadRole };
}

describe("the planning home is one resolver for every reader and writer of .agents/phases, planning, todos, plans", () => {
  it("[sma:m_pj_register] a home is refused where it is SET (setting verb, save_setting, save_settings) with a reason, and an invalid stored value reads as unset and is logged once", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    savePrototypeConfig(db, config(OTHER, "/w/other-checkout"));
    const run = (args: string[]) => harness.behavior.runCli(["setting", ...args], undefined);
    const text = (result: { stdout?: unknown; stderr?: unknown }) => `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;

    expect((await run(["proj_1", "project.planning_home=/plans/proj_1"])).exitCode).toBe(0);
    expect(loadProjectSettings(db, "proj_1")["project.planning_home"]).toBe("/plans/proj_1");
    for (const [value, reason] of [["docs/plan", /absolute/], ["/a/../b", /\.\./], ["/", /root/], [homedir(), /home directory/], ["/w/other-checkout/plans", /another project/]] as const) {
      const refused = await run(["proj_2", `project.planning_home=${value}`]);
      expect(refused.exitCode, value).not.toBe(0);
      expect(text(refused), value).toMatch(reason);
    }
    expect(loadProjectSettings(db, "proj_2")["project.planning_home"]).toBeUndefined();

    // The settings window's two save paths run the same checks.
    const save = await harness.behavior.callRpc("save_setting", { projectId: "proj_2", key: "project.planning_home", value: "/w/other-checkout", expectedVersion: 0 }) as { ok: boolean; validation?: { params: string[] } };
    expect(save.ok).toBe(false);
    expect(save.validation?.params.join(" ")).toMatch(/another project/);
    const many = await harness.behavior.callRpc("save_settings", { projectId: "proj_2", changes: [{ key: "project.planning_home", value: "relative/dir", expectedVersion: 0 }] }) as { ok: boolean; validation?: { params: string[] } };
    expect(many.ok).toBe(false);
    expect(many.validation?.params.join(" ")).toMatch(/absolute/);
    const hub = await harness.behavior.callRpc("save_setting", { projectId: "*", key: "project.planning_home", value: "/plans/all", expectedVersion: getSettingVersions(db, "*", ["project.planning_home"])["project.planning_home"] }) as { ok: boolean; validation?: { params: string[] } };
    expect(hub.ok).toBe(false);
    expect(hub.validation?.params.join(" ")).toMatch(/one project/);
    const good = await harness.behavior.callRpc("save_setting", { projectId: "proj_3", key: "project.planning_home", value: "/plans/proj_3", expectedVersion: 0 }) as { ok: boolean };
    expect(good.ok).toBe(true);

    // A value stored before (or by another door) that breaks a rule reads as no home, with one log line however often it is read.
    saveProjectSetting(db, "proj_4", "project.planning_home", "../escape");
    const log = { warn: vi.fn() };
    const host = { call: vi.fn() };
    for (let i = 0; i < 3; i += 1) expect(await resolvePlanningHome({ host: host as never, hostId: "h", cwd: "/w", inputs: planningHomeInputs(db, "proj_4"), log })).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(host.call).not.toHaveBeenCalled();
    expect(planningHomeOf({}, {}, log)).toBeNull();
  });

  it("[sma:m_pj_planning] the phase driver reads and writes its documents in the home's own repository and commits only the files it wrote; with no home it does exactly what it did", async () => {
    // UNSET: the checkout, relative paths, no home check on the host, and a commit in the checkout.
    const plain = rig();
    const planPath = `${phaseFolder(PHASE)}/PLAN.md`;
    const wrote = await plain.docs.writeDocs(plain.phase(), [{ path: planPath, content: "# plan\n" }, { path: ".agents/planning/STATE.md", content: "# state\n" }], "phase: docs");
    expect(wrote.written).toEqual([planPath, ".agents/planning/STATE.md"]);
    expect(readFileSync(join(plain.checkout, planPath), "utf8")).toBe("# plan\n");
    expect(changedBy(plain.checkout)).toEqual([".agents/phases/ph_g5plan/PLAN.md", ".agents/planning/STATE.md"]);
    expect(await plain.docs.readText(plain.phase(), planPath)).toBe("# plan\n");
    expect(plain.hostLog.filter((call) => call.method === "runCommand")).toEqual([]);
    expect(plain.hostLog.filter((call) => call.method === "writePhaseBook").map((call) => call.cwd)).toEqual([plain.checkout]);
    expect(plain.hostLog.filter((call) => call.method === "gitCommitDocs").map((call) => call.cwd)).toEqual([plain.checkout]);

    // SET: the files and the commit live in the home; a dirty file already there is not swept into the commit; the checkout stays clean.
    const home = repo("g5-home-");
    put(home, "notes.txt", "mine\n"); git(home, "add", "-A"); git(home, "commit", "-qm", "notes");
    put(home, "notes.txt", "mine, edited\n"); put(home, "junk.txt", "untracked\n");
    const set = rig({ home });
    const wroteHome = await set.docs.writeDocs(set.phase(), [{ path: planPath, content: "# plan\n" }, { path: ".agents/planning/STATE.md", content: "# state\n" }], "phase: docs");
    expect(wroteHome.written).toEqual([planPath, ".agents/planning/STATE.md"]);
    expect(readFileSync(join(home, planPath), "utf8")).toBe("# plan\n");
    expect(existsSync(join(set.checkout, ".agents"))).toBe(false);
    expect(git(set.checkout, "log", "--oneline").trim().split("\n")).toHaveLength(1);
    expect(changedBy(home)).toEqual([".agents/phases/ph_g5plan/PLAN.md", ".agents/planning/STATE.md"]);
    expect(git(home, "status", "--porcelain").split("\n").filter(Boolean).sort()).toEqual([" M notes.txt", "?? junk.txt"]);
    // A read of a planning file goes to the home (the checkout has none); a read of a code file stays in the checkout.
    expect(await set.docs.readText(set.phase(), planPath)).toBe("# plan\n");
    put(set.checkout, "DESIGN.md", "# design\n");
    expect(await set.docs.readText(set.phase(), "DESIGN.md")).toBe("# design\n");
    // A batch that mixes the two: each part is committed in its own repository, nothing leaks across.
    put(home, ".agents/phases/ph_g5plan/design/index.html", "<p>drawing</p>\n");
    put(set.checkout, "docs/drawing.png", "png\n");
    await set.docs.commitFiles(set.phase(), [".agents/phases/ph_g5plan/design/index.html", "docs/drawing.png"], "phase: drawing");
    expect(changedBy(home)).toEqual([".agents/phases/ph_g5plan/design/index.html"]);
    expect(changedBy(set.checkout)).toEqual(["docs/drawing.png"]);
    // The home's machine check ran once for all of it.
    expect(set.hostLog.filter((call) => call.method === "runCommand" && /rev-parse/.test(call.command ?? ""))).toHaveLength(1);
    // The driver's file listing (phase_files) is asked in the home.
    const phases = createPhaseDriver(set.ctx, set.services).phases;
    const listed = await phases.phaseFiles(PHASE);
    expect(listed.files.map((file) => file.path)).toEqual(expect.arrayContaining([planPath]));
    expect((await phases.phaseFiles(PHASE, planPath)).content?.text).toBe("# plan\n");
  });

  it("[sma:m_pj_planning] a home the host refuses (not a git work tree, the user's home, a folder that is not there) is ignored: the checkout is used and one line says why", async () => {
    const notGit = mkdtempSync(join(tmpdir(), "g5-notgit-"));
    const refused = rig({ home: notGit });
    const planPath = `${phaseFolder(PHASE)}/PLAN.md`;
    await refused.docs.writeDocs(refused.phase(), [{ path: planPath, content: "# plan\n" }], "phase: docs");
    await refused.docs.writeDocs(refused.phase(), [{ path: ".agents/planning/STATE.md", content: "# s\n" }], "phase: state");
    expect(readFileSync(join(refused.checkout, planPath), "utf8")).toBe("# plan\n");
    expect(existsSync(join(notGit, ".agents"))).toBe(false);
    expect(refused.warn.mock.calls.filter(([line]) => String(line).includes("project.planning_home"))).toHaveLength(1);
    expect(String(refused.warn.mock.calls.find(([line]) => String(line).includes("project.planning_home"))?.[0])).toMatch(/not inside a git work tree/);
    // A home inside another project's checkout is refused at use time too (a value stored before the other project was bound).
    const other = repo("g5-other-");
    const inside = rig({ home: join(other, "plans") });
    savePrototypeConfig(inside.db, config(OTHER, other));
    expect(await inside.docs.planningHome(inside.phase(), planPath)).toBeNull();
    // A folder that is not there.
    const missing = rig({ home: join(tmpdir(), "g5-no-such-folder") });
    expect(await missing.docs.planningHome(missing.phase(), planPath)).toBeNull();
  });

  it("[sma:d_project_planning] unset leaves the texts the PM, the drawer and the backlog get exactly as they were; a home turns the folders into its absolute path", async () => {
    const rec: PhaseRecord = { context: { docs: [], sha: "ctx", signedAt: 1, legacy: true } } as never;
    const phase = { id: PHASE, projectId: PROJECT, pmThreadId: PM, runId: RUN, title: "Plan", goal: "g", stage: "design", state: "active", record: rec, edition: 1, createdAt: 0, updatedAt: 0 } as never;
    const home = "/plans/g5";
    // The drawer's folder input (the model writes the mock-ups there).
    expect(autoInputs(phase, { kind: "draw" }).folder).toBe(".agents/phases/ph_g5plan");
    expect(autoInputs(phase, { kind: "draw" }, undefined, null, undefined, null).folder).toBe(".agents/phases/ph_g5plan");
    expect(autoInputs(phase, { kind: "draw" }, undefined, null, undefined, home).folder).toBe("/plans/g5/.agents/phases/ph_g5plan");
    // The PM's next step names the files it reads and the folder it draws into.
    const plain = nextAction(phase, new Map());
    expect(plain.text).toContain(".agents/phases/ph_g5plan/design/");
    expect(plain.text).not.toContain(home);
    expect(nextAction(phase, new Map(), null).text).toBe(plain.text);
    const moved = nextAction(phase, new Map(), home);
    expect(moved.text).toContain("/plans/g5/.agents/phases/ph_g5plan/design/");
    expect(moved.key).toBe(plain.key);
    // The discussion stage is the one that names the roadmap files (the design stage names only its own folder).
    const discussion = { ...(phase as object), stage: "discussion" } as never;
    expect(nextAction(discussion, new Map()).text).toContain("Read first: .agents/planning/ROADMAP.md");
    expect(nextAction(discussion, new Map(), null).text).toBe(nextAction(discussion, new Map()).text);
    expect(nextAction(discussion, new Map(), home).text).toContain("Read first: /plans/g5/.agents/planning/ROADMAP.md");
    // The backlog message and the project-life agent.
    const item = { id: "fix-it", title: "Fix it", status: "ready", priority: "normal", estimate: 3, created: "2026-11-01", dependsOn: [] } as never;
    expect(issueMessage(item)).toContain("Описание и подход: .agents/todos/items/fix-it/AGENT.md и README.md.");
    expect(issueMessage(item, home)).toContain("Описание и подход: /plans/g5/.agents/todos/items/fix-it/AGENT.md");
    const lifeInput = { workspace: "/w", runId: "run1", artifactDirs: [], tasks: [], nowIso: "2026-11-01T00:00:00Z" };
    const lifeText = projectLifePrompt(lifeInput);
    expect(projectLifePrompt({ ...lifeInput, planningHome: null })).toBe(lifeText);
    expect(lifeText).toContain("active plans from .agents/plans/");
    const lifeMoved = projectLifePrompt({ ...lifeInput, planningHome: home });
    expect(lifeMoved).toContain("/plans/g5/.agents/plans/**");
    expect(lifeMoved).toContain("/plans/g5/.agents/todos/INDEX.md");
    expect(lifeMoved).toContain("git -C /plans/g5");
    expect(lifeMoved).toContain(".agents/plans/items/*/PLAN.md");
  });

  it("[sma:d_project_planning] the PM's board names the home (reads there; its editor writes only in the checkout) once the host confirmed it, and says nothing when none is set", async () => {
    const plain = rig();
    expect(pmBoardBlock(plain.db as never, RUN) ?? "").not.toContain("Planning home");
    const home = repo("g5-home-");
    const set = rig({ home });
    expect(pmBoardBlock(set.db as never, RUN) ?? "").not.toContain("Planning home");
    await set.docs.planningHome(set.phase(), ".agents/planning/STATE.md");
    const board = pmBoardBlock(set.db as never, RUN) ?? "";
    expect(board).toContain(`Planning home: ${home}.`);
    expect(board).toMatch(/editor write only inside the checkout.*todo-add and note-add/);
  });

  it("[sma:d_project_planning] a workflow step's prompt (lp.clarify's, as the real helper spawner sends it) names the home's folders when a home is set and is today's text when none is", async () => {
    const workflow = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", "lp.clarify.json"), "utf8")) as { nodes: Array<Row & { prompt?: string }> };
    const prompt = workflow.nodes.find((node) => typeof node.prompt === "string" && String(node.prompt).includes(".agents/phases/*/BOOK.md"))!.prompt!;
    const send = async (r: ReturnType<typeof rig>, text: string) => {
      await createWorkflowAgents().run({ rt: r.rt, workflowRunId: "wf1", stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: text, fields: [], role: "analyst", resolved: true } as never).catch(() => null);
      return JSON.stringify(r.spawned.at(-1) ?? {});
    };
    const plain = rig();
    const unset = await send(plain, prompt);
    expect(unset).toContain(JSON.stringify(prompt).slice(1, -1));
    const home = repo("g5-home-");
    const set = rig({ home });
    const moved = await send(set, prompt);
    expect(moved).toContain(`${home}/.agents/phases/*/BOOK.md`);
    // The writer's task folders are not part of the home: that path keeps its text.
    expect(moved).toContain(".agents/plans/items/*/PLAN.md");
    expect(moved).not.toContain(JSON.stringify(prompt).slice(1, -1));
    // pr-branch names these folders as paths to leave out of a cherry-pick: never rewritten.
    const branch = rig({ home });
    await createWorkflowAgents().run({ rt: branch.rt, workflowRunId: "wf2", stepKey: "s", nodeId: "n", spawnKey: "k2", title: "t", prompt: "drop .agents/planning/** and .agents/phases/**", fields: [], role: "analyst", workflowId: "pr-branch", resolved: true } as never).catch(() => null);
    expect(JSON.stringify(branch.spawned.at(-1))).toContain("drop .agents/planning/** and .agents/phases/**");
  });

  it("[sma:d_project_planning] the backlog board reads the todo items from the home when one is set, from the checkout when none is", async () => {
    const meta = (id: string) => `id: ${id}\ntitle: Task ${id}\nstatus: ready\npriority: normal\nestimate: 2\ncreated: 2026-11-01\n`;
    const plain = rig();
    put(plain.checkout, ".agents/todos/items/in-checkout/meta.yaml", meta("in-checkout"));
    expect((await createBacklog(plain.ctx).backlog.board(PROJECT)).issuable.map((row) => row.id)).toEqual(["in-checkout"]);
    const home = repo("g5-home-");
    const set = rig({ home });
    put(set.checkout, ".agents/todos/items/in-checkout/meta.yaml", meta("in-checkout"));
    put(home, ".agents/todos/items/in-home/meta.yaml", meta("in-home"));
    expect((await createBacklog(set.ctx).backlog.board(PROJECT)).issuable.map((row) => row.id)).toEqual(["in-home"]);
  });

  it("[sma:d_project_planning] the workflow actions that read or write planning files (state probe, roadmap park, debug session, quick STATE.md row, requirements) go to the home", async () => {
    const home = repo("g5-home-");
    const r = rig({ home });
    put(home, ".agents/planning/ROADMAP.md", "# Roadmap\n- [ ] 1 first\n");
    put(home, ".agents/planning/STATE.md", "# State\n\n## Quick Tasks Completed\n\n| Date | Task | Commit |\n|---|---|---|\n");
    put(r.checkout, ".agents/planning/ROADMAP.md", "# checkout roadmap must not be touched\n");
    saveProjectSetting(r.db, PROJECT, "project.start_research", "on");
    const engine = new WorkflowEngine({ db: r.db, harnessVersion: "test", runtimeFor: chainRuntimeFor(r.ctx, r.services), resolveWorkflow: () => null });
    registerPureActions(engine); registerReducers(engine);
    registerChainExecutors(engine, r.ctx, r.services, createWorkflowAgents());
    registerDispatchExecutors(engine, r.ctx.bb);
    const OUTS: Record<string, Record<string, string>> = { "lp.state_probe": { has_roadmap: "bool", has_profile: "bool" }, "lp.roadmap_park": { n: "string", path: "string" }, "lp.debug_session": { found: "bool", path: "string" } };
    const run = async (id: string, params: Row = {}, inputs: Row = {}) => (await engine.start({ workflow: actionWorkflow(id, { with: params }, OUTS[id]!, Object.keys(inputs)), inputs, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done) as { status: string; output?: Row; error?: unknown };
    const probe = await run("lp.state_probe");
    expect(probe.output).toMatchObject({ has_roadmap: true });
    const parked = await run("lp.roadmap_park", {}, { name: "later" });
    expect(parked.status, JSON.stringify(parked)).toBe("succeeded");
    expect(readFileSync(join(home, ".agents/planning/ROADMAP.md"), "utf8")).toMatch(/999\.1/);
    expect(readFileSync(join(r.checkout, ".agents/planning/ROADMAP.md"), "utf8")).toBe("# checkout roadmap must not be touched\n");
    const debug = await run("lp.debug_session", {}, { session: "flaky", symptom: "it flakes" });
    expect(debug.status).toBe("succeeded");
    expect(existsSync(join(home, ".agents/planning/debug/flaky.md"))).toBe(true);
    expect(existsSync(join(r.checkout, ".agents/planning/debug"))).toBe(false);
    // fs.write (todo-add, note-add, audit-uat): a planning folder goes to the home; the writer's task folder and any other path stay in the checkout.
    const wrote = async (path: string) => (await engine.start({ workflow: actionWorkflow("fs.write", { params: { path, contents: { "note.md": "hello" } } }, { note_path: "string" }), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done) as { status: string };
    expect((await wrote(".agents/todos/notes/n1/")).status).toBe("succeeded");
    expect(readFileSync(join(home, ".agents/todos/notes/n1/note.md"), "utf8")).toBe("hello");
    expect(existsSync(join(r.checkout, ".agents/todos"))).toBe(false);
    expect((await wrote(".agents/plans/items/t1/")).status).toBe("succeeded");
    expect(readFileSync(join(r.checkout, ".agents/plans/items/t1/note.md"), "utf8")).toBe("hello");
    expect((await wrote("docs/out/")).status).toBe("succeeded");
    expect(existsSync(join(r.checkout, "docs/out/note.md"))).toBe(true);
    // The quick path's STATE.md row and the post-ship hook list: the home's files, not the checkout's.
    put(home, ".agents/planning/hooks/post-ship-a.md", "hook\n");
    put(r.checkout, ".agents/planning/hooks/post-ship-b.md", "not mine\n");
    const hooks = (await engine.start({ workflow: actionWorkflow("lp.post_ship_hooks", {}, { count: "int", files: "string[]" }), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done) as { output?: Row };
    expect(hooks.output).toMatchObject({ count: 1, files: [".agents/planning/hooks/post-ship-a.md"] });
    const quick = (await engine.start({ workflow: actionWorkflow("lp.quick_state", { with: { title: "fix the typo", commits: ["abc1234"], comment: "ok" } }, { ok: "bool", note: "string", comment: "string" }), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done) as { output?: Row };
    expect(quick.output).toMatchObject({ ok: true });
    expect(readFileSync(join(home, ".agents/planning/STATE.md"), "utf8")).toContain("fix the typo");
    expect(git(home, "log", "--format=%s", "-1")).toMatch(/state: quick task done/);
    expect(existsSync(join(r.checkout, ".agents/planning/STATE.md"))).toBe(false);
    // None set: the same write lands in the checkout, as it always did.
    const plain = rig();
    const plainEngine = new WorkflowEngine({ db: plain.db, harnessVersion: "test", runtimeFor: chainRuntimeFor(plain.ctx, plain.services), resolveWorkflow: () => null });
    registerPureActions(plainEngine); registerReducers(plainEngine); registerChainExecutors(plainEngine, plain.ctx, plain.services, createWorkflowAgents());
    await plainEngine.start({ workflow: actionWorkflow("fs.write", { params: { path: ".agents/todos/notes/n1/", contents: { "note.md": "hello" } } }, { note_path: "string" }), inputs: {}, runtime: plain.rt, link: { projectId: PROJECT, runId: RUN } }).done;
    expect(readFileSync(join(plain.checkout, ".agents/todos/notes/n1/note.md"), "utf8")).toBe("hello");
    expect(plain.hostLog.filter((call) => call.method === "runCommand")).toEqual([]);
  });

  it("[sma:k_t_validate] `phase validate` reads the roadmap through the planning home and exits 1 with one line per finding, 0 when the planning files agree", async () => {
    const home = repo("g5-home-");
    const r = rig({ home });
    for (const id of Object.keys(bundledAgents)) put(r.checkout, `.claude/agents/${id}.md`, "agent\n");
    const phases = createPhaseDriver(r.ctx, r.services).phases;
    // No roadmap anywhere: a finding.
    const none = await runPhaseCli(phases, ["validate", PHASE]);
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toContain("no .agents/planning/ROADMAP.md");
    // The roadmap lives in the home (the checkout's own copy is a broken one that must not be read): rows 1, 2, 2, 4.
    put(r.checkout, ".agents/planning/ROADMAP.md", "- [ ] 1 only\n");
    put(home, ".agents/planning/ROADMAP.md", ["- [ ] 1 first", "- [ ] 2 second", "- [x] 2 second done", "- [ ] 4 fourth"].join("\n"));
    const bad = await runPhaseCli(phases, ["validate", PHASE]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stdout).toContain("duplicate roadmap row 2");
    expect(bad.stdout).toContain("skipped roadmap row(s) between 2 and 4");
    // A consistent roadmap: nothing to report, exit 0.
    put(home, ".agents/planning/ROADMAP.md", ["- [ ] 1 first", "- [ ] 2 second", "- [ ] 3 third"].join("\n"));
    // The phase on disk is the roadmap's row 1 (a phase folder whose phase has no roadmap row is a finding, by the card).
    expect((await runPhaseCli(phases, ["validate", PHASE])).stdout).toContain("phase folder with no roadmap row: ph_g5plan");
    savePhase(r.db, PHASE, { record: { ...r.phase().record, roadmapRow: "1" }, at: 3 });
    const good = await runPhaseCli(phases, ["validate", PHASE]);
    expect(good).toMatchObject({ exitCode: 0 });
    // A bundled agent that is not installed is a finding too.
    const [anAgent] = Object.keys(bundledAgents);
    unlinkSync(join(r.checkout, `.claude/agents/${anAgent}.md`));
    const missing = await runPhaseCli(phases, ["validate", PHASE]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain(`bundled agent not installed: ${anAgent}`);
  });
});

describe("the infra profile: one writer, one reader, who may write and what counts as «has a profile»", () => {
  const mount = async () => {
    const r = rig();
    await plugin(r.bb);
    const run = (args: string[], threadId?: string) => r.harness.behavior.runCli(["profile", ...args], threadId ? { threadId } : undefined);
    const out = (result: { stdout?: unknown; stderr?: unknown }) => `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
    return { ...r, run, out, profile: () => Object.fromEntries(Object.entries(loadProjectSettings(r.db, PROJECT)).filter(([key]) => key.startsWith("profile."))) };
  };

  it("[sma:k_pl_infra] --set splits at the first =, refuses secrets, unknown keys, long values and any thread but the project's own PM chat; an empty value resets the key", async () => {
    const m = await mount();
    // The owner at a terminal: the value keeps every = after the first.
    expect((await m.run([PROJECT, "--set", "test_command=npm test -- --grep=a=b"])).exitCode).toBe(0);
    expect(m.profile()).toEqual({ "profile.test_command": "npm test -- --grep=a=b" });
    // Refused with the reason, nothing written (the whole call is judged first).
    for (const [pair, reason] of [["unknown_key=1", /stack, test_command, release, hosts, start, deploy, logs, style/], ["stack=sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", /secret/], [`style=${"x".repeat(1001)}`, /1000/], ["db_password=x", /unknown profile key/], ["stack", /<value>/]] as const) {
      const refused = await m.run([PROJECT, "--set", "release=ok", "--set", pair]);
      expect(refused.exitCode, pair).toBe(1);
      expect(m.out(refused), pair).toMatch(reason);
    }
    expect(m.profile()).toEqual({ "profile.test_command": "npm test -- --grep=a=b" });
    // Threads: a writer, another project's PM, the project's own PM.
    m.threadRole["thr-writer"] = "writer"; m.threadProject["thr-writer"] = PROJECT;
    m.threadRole["thr-pm-other"] = "pm"; m.threadProject["thr-pm-other"] = OTHER;
    m.threadRole["thr-pm"] = "pm"; m.threadProject["thr-pm"] = PROJECT;
    expect(m.out(await m.run([PROJECT, "--set", "stack=ts"], "thr-writer"))).toMatch(/refused.*PM chat/);
    expect(m.out(await m.run([PROJECT, "--set", "stack=ts"], "thr-pm-other"))).toMatch(/refused.*own PM chat/);
    expect(m.profile()).toEqual({ "profile.test_command": "npm test -- --grep=a=b" });
    expect((await m.run([PROJECT, "--set", "stack=ts"], "thr-pm")).exitCode).toBe(0);
    expect(m.profile()).toMatchObject({ "profile.stack": "ts" });
    // Any thread may read.
    expect(JSON.parse(String((await m.run([PROJECT], "thr-writer")).stdout))).toMatchObject({ "profile.stack": "ts", "profile.release": "" });
    // An empty value resets the key.
    expect((await m.run([PROJECT, "--set", "stack="])).exitCode).toBe(0);
    expect(m.profile()["profile.stack"]).toBeUndefined();
  });

  it("[sma:k_pl_infra] with the settings empty, the read shows what an earlier profile.json holds and says the values come from the file", async () => {
    const m = await mount();
    put(m.checkout, ".agents/planning/profile.json", JSON.stringify({ stack: "php", deploy: "ftp", extra: "ignored" }));
    const read = JSON.parse(String((await m.run([PROJECT])).stdout)) as Row;
    expect(read).toMatchObject({ "profile.stack": "php", "profile.deploy": "ftp", "profile.release": "" });
    expect(String(read.source)).toMatch(/come from .agents\/planning\/profile.json/);
    expect(read).not.toHaveProperty("profile.extra");
    // Set values win and carry no source line.
    await m.run([PROJECT, "--set", "stack=go"]);
    const own = JSON.parse(String((await m.run([PROJECT])).stdout)) as Row;
    expect(own).toMatchObject({ "profile.stack": "go", "profile.deploy": "" });
    expect(own).not.toHaveProperty("source");
  });

  it("[sma:k_pl_infra] lp.profile_write keeps the good pairs and names a refused one with its reason (the eight keys); lp.state_probe counts a profile only for a non-empty value or a profile.json", async () => {
    const r = rig();
    saveProjectSetting(r.db, PROJECT, "project.start_research", "on");
    const engine = new WorkflowEngine({ db: r.db, harnessVersion: "test", runtimeFor: chainRuntimeFor(r.ctx, r.services), resolveWorkflow: () => null });
    registerPureActions(engine); registerReducers(engine);
    registerChainExecutors(engine, r.ctx, r.services, createWorkflowAgents());
    const OUTS: Record<string, Record<string, string>> = { "lp.state_probe": { has_profile: "bool" }, "lp.profile_write": { refused: "string[]", set: "string[]", reasons: "string[]" } };
    const call = async (id: string, params: Row = {}) => (await engine.start({ workflow: actionWorkflow(id, { params }, OUTS[id]!), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done).output as Row;
    const probe = async () => (await call("lp.state_probe")).has_profile;
    expect(await probe()).toBe(false);
    saveProjectSetting(r.db, PROJECT, "profile.stack", "");
    expect(await probe()).toBe(false);
    const written = await call("lp.profile_write", { profile: { stack: "ts", flavour: "x", release: "sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(written.set).toEqual(["stack"]);
    expect(written.refused).toEqual(["flavour", "release"]);
    expect((written.reasons as string[]).join("\n")).toMatch(/flavour: unknown profile key.*stack, test_command, release, hosts, start, deploy, logs, style/);
    expect((written.reasons as string[]).join("\n")).toMatch(/release: the value looks like a secret/);
    expect(JSON.stringify(written)).not.toContain("sk-aaaa");
    expect(await probe()).toBe(true);
    saveProjectSetting(r.db, PROJECT, "profile.stack", "");
    expect(await probe()).toBe(false);
    put(r.checkout, ".agents/planning/profile.json", "{}");
    expect(await probe()).toBe(true);
  });
});

describe("phase_control: the owner's per-piece decisions go through the phase and land in its book", () => {
  async function phaseRig(stage: "planning" | "execution" | "design" | "closed" = "planning") {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    createRun(db, RUN, PROJECT, "bb", "/w");
    const item = (id: string, wave: number) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: `then ${id}` }, task: { id, project_cwd: "/repo", owns_paths: [`src/${id}/**`], verification: [{ command: "npm test" }], acceptance: ["ok"] } });
    const items = [item("a", 1), item("b", 1), item("c", 2)];
    insertPhase(db, { id: PHASE, projectId: PROJECT, pmThreadId: PM, title: "P", goal: "g", runId: RUN, at: 1 });
    const sha = planSignature(items as never, "ctx");
    const word = (turn: string) => ({ turn, decision: "yes", by: "owner", text: "yes", at: 1 });
    savePhase(db, PHASE, { stage: stage === "closed" ? "execution" : stage, state: stage === "closed" ? "closed" : "active", at: 2,
      record: { context: { docs: [], sha: "ctx", signedAt: 1, legacy: true }, plan: { items, sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { a: "a" }, startedAt: 1 }, words: [word("issue")] } as never });
    const control = (input: Row) => harness.behavior.callRpc("phase_control", { phaseId: PHASE, ...input }) as Promise<Row>;
    return { db, control, harness };
  }

  it("[sma:d_batch_decide] a withdraw on a planning phase takes the piece out, revokes the old issue word and says the owner must give a new one", async () => {
    const p = await phaseRig("planning");
    const answer = await p.control({ action: "withdraw", piece: "b", note: "out of scope" });
    expect(String(answer.notice)).toMatch(/b: убрано из плана/);
    expect(String(answer.notice)).toMatch(/дайте новое слово «выдать»/);
    const after = getPhase(p.db, PHASE)!;
    expect(after.record.plan!.items.map((row) => row.id)).toEqual(["a", "c"]);
    expect(after.record.words ?? []).toEqual([]);
    expect(after.record.plan!.admittedSha).toBe(after.record.plan!.sha);
    expect(listParts(p.db, PHASE).map((part) => part.kind)).toContain("scope_withdrawn");
    // The card's list of offers: the issued piece and the plan's last pieces are not offered.
    const view = await p.harness.behavior.callRpc("phase_get", { phaseId: PHASE }) as { withdrawable: string[] };
    expect(view.withdrawable).toEqual(["c"]);
  });

  it("[sma:d_batch_decide] a withdraw is refused, with its reason and no change, on a closed phase, at the design stage, for an unknown piece and for an issued one", async () => {
    for (const [stage, piece, reason] of [["closed", "b", /closed.*open/], ["design", "b", /at design/], ["planning", "nope", /no piece nope/], ["execution", "a", /issued/]] as const) {
      const p = await phaseRig(stage);
      const before = JSON.stringify(getPhase(p.db, PHASE)!.record);
      await expect(p.control({ action: "withdraw", piece, note: "why" }), `${stage}/${piece}`).rejects.toThrow(reason);
      expect(JSON.stringify(getPhase(p.db, PHASE)!.record), `${stage}/${piece}`).toBe(before);
    }
    const p = await phaseRig("planning");
    await expect(p.control({ action: "withdraw", piece: "b", note: "  " })).rejects.toThrow(/note/);
  });

  it("[sma:d_batch_decide] «Повторить» (decide retry) and «Отменить» (cancel_piece) put a line in the phase book; a piece not at work cannot be canceled", async () => {
    const p = await phaseRig("execution");
    p.db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES ('a','g5-run','bb','{}',1)").run?.();
    await expect(p.control({ action: "cancel_piece", piece: "b" })).rejects.toThrow(/not at work/);
    await expect(p.control({ action: "decide", piece: "b", choice: "retry" })).rejects.toThrow(/not stopped/);
    await expect(p.control({ action: "cancel_piece", piece: "zzz" })).rejects.toThrow(/no piece zzz/);
  });
});

describe("plans-health: the planning indexes against the folders on disk", () => {
  const mountCli = async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    openDatabase(bb);
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    return (args: string[], threadId?: string) => harness.behavior.runCli(["plans-health", ...args], threadId ? { threadId } : undefined);
  };
  const INDEX = ["# Todos", "", "Pick the next item from the list below; closed ones leave.", "", "- real-one — the live item", "- ghost-item — the folder was deleted", "- Remember to review this weekly", "- [ ] other-ghost", "", "", "## Notes", "ghost-prose: this line is a sentence, not an entry", ""].join("\n");

  it("[sma:k_c_health] --fix removes only the dead entry lines, keeps prose, headings and blank runs byte for byte, backs up INDEX.md first, and adds no README", async () => {
    const run = await mountCli();
    const root = join(mkdtempSync(join(tmpdir(), "g5-project-")), ".agents");
    put(root, "todos/items/real-one/meta.yaml", "status: open\n");
    put(root, "todos/items/unlisted/meta.yaml", "status: open\n");
    put(root, "todos/INDEX.md", INDEX);
    put(root, "plans/README.md", "# how plans work\n");
    put(root, "plans/2026-11-01-big-plan.md", "# plan\n");
    put(root, "plans/INDEX.md", "# Plans\n- 2026-11-01-big-plan\n");
    const report = await run([root]);
    expect(report.exitCode).toBe(1);
    expect(String(report.stdout)).toContain("not in INDEX.md: unlisted");
    expect(String(report.stdout)).toContain("ghost-item");
    expect(String(report.stdout)).not.toContain("README");
    expect(String(report.stdout)).not.toContain("Remember");
    expect(readFileSync(join(root, "todos/INDEX.md"), "utf8")).toBe(INDEX);
    // From a thread the fix is refused and nothing changes.
    const refused = await run([root, "--fix"], "thr-any");
    expect(refused.exitCode).toBe(1);
    expect(String(refused.stderr)).toMatch(/owner runs it at a terminal/);
    expect(readFileSync(join(root, "todos/INDEX.md"), "utf8")).toBe(INDEX);
    expect(existsSync(join(root, "todos/INDEX.md.bak"))).toBe(false);
    // The owner's fix.
    const fixed = await run([root, "--fix"]);
    expect(fixed.exitCode).toBe(0);
    expect(readFileSync(join(root, "todos/INDEX.md.bak"), "utf8")).toBe(INDEX);
    const expected = INDEX.split("\n").filter((line) => !/^- (ghost-item|\[ \] other-ghost)/.test(line)).join("\n") + "- unlisted\n";
    expect(readFileSync(join(root, "todos/INDEX.md"), "utf8")).toBe(expected);
    expect(readFileSync(join(root, "todos/INDEX.md"), "utf8")).toContain("\n\n\n## Notes");
    expect(readFileSync(join(root, "plans/INDEX.md"), "utf8")).toBe("# Plans\n- 2026-11-01-big-plan\n");
    expect(existsSync(join(root, "plans/INDEX.md.bak"))).toBe(false);
    expect((await run([root])).exitCode).toBe(0);
  });

  it("[sma:k_c_health] the usage line says it runs in the directory given, at the owner's terminal", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    openDatabase(bb);
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    const help = await harness.behavior.runCli(["explain", "plans-health"], undefined);
    expect(String(help.stdout)).toMatch(/runs in the directory given/);
    expect(String(help.stdout)).toMatch(/--fix is refused from a thread/);
  });
});

describe("the codebase map's pages", () => {
  it("[sma:k_pl_codebase] a project root owes docs/conventions.md and docs/testing.md; a workspace does not", () => {
    const page = (type: string) => ({ path: `docs/${type}.md`, sha256: "a".repeat(64), modifiedAt: 0, content: `---\ntitle: t\ntype: ${type}\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: active\nconfidence: high\ntags: []\nsources: []\n---\n` });
    const gaps = docsCompletenessGaps([page("overview"), page("architecture"), page("gotchas")], { tables: [], core: [] });
    expect(gaps.missingPages).toEqual(expect.arrayContaining(["docs/conventions.md", "docs/testing.md"]));
    const ws = docsCompletenessGaps([page("overview")], { tables: [], core: [], workspace: true });
    expect(ws.missingPages).toEqual([]);
    const full = docsCompletenessGaps([page("overview"), page("architecture"), page("gotchas"), page("conventions"), page("testing")], { tables: [], core: [] });
    expect(full.missingPages).toEqual([]);
  });
  it("[sma:k_d_tpl_instructions] the start's profile write creates CLAUDE.md and the Copilot instructions as pointers to PROJECT.md, seeds a minimal canon on a fresh start and appends the preferences once; a person's CLAUDE.md is never replaced", async () => {
    STRICT_WRITES.on = true;
    try {
      const r = rig();
      const engine = new WorkflowEngine({ db: r.db, harnessVersion: "test", runtimeFor: chainRuntimeFor(r.ctx, r.services), resolveWorkflow: () => null });
      registerPureActions(engine); registerReducers(engine);
      registerChainExecutors(engine, r.ctx, r.services, createWorkflowAgents());
      const write = async () => (await engine.start({ workflow: actionWorkflow("lp.profile_write", { params: { profile: { stack: "ts", test_command: "npm test" } } }, { refused: "string[]", set: "string[]", reasons: "string[]" }), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done).output as Row;
      const at = (path: string) => join(r.checkout, path);
      // A fresh start has no PROJECT.md yet: the pointers still go in, and a minimal PROJECT.md is seeded so they resolve.
      await write();
      expect(existsSync(at("CLAUDE.md"))).toBe(true);
      expect(existsSync(at(".github/copilot-instructions.md"))).toBe(true);
      expect(readFileSync(at(".agents/planning/PROJECT.md"), "utf8")).toMatch(/## Developer preferences[\s\S]*Language: ts[\s\S]*Test command: npm test/);
      // With PROJECT.md and the person's own CLAUDE.md: theirs stays byte for byte, the missing file is created.
      put(r.checkout, ".agents/planning/PROJECT.md", "# Project\n\nVision.\n");
      put(r.checkout, "CLAUDE.md", "@AGENTS.md\n");
      await write();
      expect(readFileSync(at("CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
      expect(readFileSync(at(".github/copilot-instructions.md"), "utf8")).toContain(".agents/planning/PROJECT.md");
      const project = readFileSync(at(".agents/planning/PROJECT.md"), "utf8");
      expect(project.startsWith("# Project\n\nVision.")).toBe(true);
      expect(project).toMatch(/## Developer preferences[\s\S]*Language: ts[\s\S]*Test command: npm test/);
      // A second start appends nothing more.
      await write();
      expect(readFileSync(at(".agents/planning/PROJECT.md"), "utf8")).toBe(project);
    } finally { STRICT_WRITES.on = false; }
  });
  it("[sma:k_d_ref_infra] the start's profile write keeps the eight infra keys as the project's profile.* settings, skips a secret-named key, a secret-looking value, an unknown key and an over-long value by key name, and the rest still lands", async () => {
    const r = rig();
    const engine = new WorkflowEngine({ db: r.db, harnessVersion: "test", runtimeFor: chainRuntimeFor(r.ctx, r.services), resolveWorkflow: () => null });
    registerPureActions(engine); registerReducers(engine);
    registerChainExecutors(engine, r.ctx, r.services, createWorkflowAgents());
    const profile = { stack: "ts, vitest", test_command: "npm test", style: "x".repeat(1001), api_key: "plain-value", deploy: "token=abcdef1234567890abcdef1234567890", hobby: "chess" };
    const done = (await engine.start({ workflow: actionWorkflow("lp.profile_write", { params: { profile } }, { refused: "string[]", set: "string[]", reasons: "string[]" }), inputs: {}, runtime: r.rt, link: { projectId: PROJECT, runId: RUN } }).done).output as Row;
    expect(done.set).toEqual(["stack", "test_command"]);
    expect(done.refused).toEqual(["style", "api_key", "deploy", "hobby"]);
    expect((done.reasons as string[]).join("\n")).not.toContain("plain-value");
    expect((done.reasons as string[]).join("\n")).not.toContain("abcdef1234567890");
    const settings = loadProjectSettings(r.db, PROJECT);
    expect(settings["profile.stack"]).toBe("ts, vitest");
    expect(settings["profile.test_command"]).toBe("npm test");
    for (const key of ["profile.style", "profile.api_key", "profile.deploy", "profile.hobby"]) expect(settings[key]).toBeUndefined();
  });
});
