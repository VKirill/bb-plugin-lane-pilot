import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/contracts";
import {
  createAttempt, createRun, createTask, listAttemptsForTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt,
} from "../src/database";
import { lintContract, lintProbePaths, lintReply, runnerFilterArgs, type LintInput, type PathKind } from "../src/server/contract-lint";

const root = "/tmp/writer";
const baseTask: TaskV2 = {
  schema_version:2, id:"lint-task", title:"Lint", risk:"low", lane:"writer", project_cwd:root,
  read_first:["src/a.ts"], interfaces:["i"], invariants:["inv"], out_of_scope:["out"], expected_outputs:["src/b.ts"],
  owns_paths:["src/"], never_touch:[".git/**"], depends_on:[], objective:"change a", acceptance:["done"],
  verify:"tests", verification:[{ command:"npx vitest run tests/a.test.ts", cwd:root }],
};
const lint = (task:Partial<TaskV2> = {}, input:Partial<LintInput> = {}, kinds:Record<string, PathKind> | null = {}) =>
  lintContract({ task:{ ...baseTask, ...task }, workspacePath:root, hostId:"host-1", sandboxUnsafe:[], openTasks:[], deadDependencies:[],
    kinds:kinds ? new Map(Object.entries(kinds).map(([path, kind]) => [`${root}/${path}`, kind])) : null, ...input });
const codes = (result:ReturnType<typeof lint>) => result.errors.map((error) => error.code);

describe("contract lint rules", () => {
  it("passes a sound contract", () => {
    expect(lint({}, {}, { "src/a.ts":"file" })).toEqual({ errors:[], warnings:[] });
  });

  describe("read_first", () => {
    it("rejects a missing file, naming the machine and the fix", () => {
      const { errors } = lint({}, {}, { "src/a.ts":"missing" });
      expect(codes({ errors, warnings:[] })).toEqual(["read_first_missing"]);
      expect(errors[0]!.message).toContain("host-1");
    });
    it("lets a missing file through when the task creates it or waits for the task that does", () => {
      expect(codes(lint({ expected_outputs:["src/a.ts"] }, {}, { "src/a.ts":"missing" }))).toEqual([]);
      expect(codes(lint({ expected_outputs:["src/b.ts"], owns_paths:["src/"], depends_on:["other"] }, {}, { "src/a.ts":"missing" }))).toEqual([]);
    });
    it("marks a folder as a folder, and rejects a symlink", () => {
      expect(lint({ read_first:["src"] }, {}, { src:"directory" }).errors[0]).toMatchObject({ code:"read_first_folder", message:expect.stringContaining("is a directory, not a file: src/") });
      expect(codes(lint({}, {}, { "src/a.ts":"symlink" }))).toEqual(["read_first_not_file"]);
    });
    it("rejects a path that leaves the project", () => {
      expect(codes(lint({ read_first:["../secrets.txt"] }, {}, {}))).toEqual(["read_first_path"]);
    });
    it("stays silent about files when the machine could not be asked", () => {
      expect(codes(lint({}, {}, null))).toEqual([]);
    });
    it("takes line windows off the path", () => {
      expect(lintProbePaths({ ...baseTask, read_first:["src/a.ts:10-20"], verification:[] }, root)).toEqual([`${root}/src/a.ts`]);
    });
  });

  describe("ownership paths", () => {
    it("rejects owns_paths and never_touch that escape the root, all in one go", () => {
      const { errors } = lint({ owns_paths:["../x", "src/a.ts"], expected_outputs:["src/a.ts"], never_touch:["/etc"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["ownership_unsafe", "ownership_unsafe"]);
      expect(errors[0]!.message).toContain("unsafe ownership path pattern: ../x");
    });
    it("rejects an owned path inside never_touch", () => {
      const { errors } = lint({ owns_paths:["src/a.ts"], never_touch:["src/"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toContain("owns_never_touch");
    });
    it("warns, without blocking, when owns_paths overlap an open task", () => {
      const open = { id:"open-1", owns_paths:["src/"], never_touch:[], depends_on:[] };
      const result = lint({}, { openTasks:[open] }, { "src/a.ts":"file" });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([{ code:"owns_overlap_open", message:expect.stringContaining("open-1") }]);
      expect(lint({}, { openTasks:[{ ...open, owns_paths:["docs/"] }] }, { "src/a.ts":"file" }).warnings).toEqual([]);
    });
  });

  describe("expected_outputs", () => {
    it("rejects a file outside owns_paths with the fix", () => {
      const { errors } = lint({ owns_paths:["src/a.ts"], expected_outputs:["src/a.ts", "src/stages/contract.ts"] }, {}, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["output_unowned"]);
      expect(errors[0]!.message).toContain("src/stages/contract.ts");
      expect(errors[0]!.message).toContain("add it (or its folder) to owns_paths");
    });
    it("leaves bare names, prose and a folder under owns_paths alone", () => {
      expect(codes(lint({ expected_outputs:["a.ts", "the page renders", "src/new/"], owns_paths:["src/"] }, {}, { "src/a.ts":"file" }))).toEqual([]);
    });
    it("rejects a file inside never_touch", () => {
      expect(codes(lint({ expected_outputs:["src/a.ts"], owns_paths:["src/"], never_touch:["src/a.ts"] }, {}, { "src/a.ts":"file" }))).toContain("output_never_touch");
    });
  });

  describe("check filters", () => {
    const folder = { "src/a.ts":"file" as const, "tests/server":"directory" as const };
    it("finds the folder words of vitest, jest and npm script filters", () => {
      expect(runnerFilterArgs("npx vitest run tests/server --reporter dot tests/a.test.ts")).toEqual(["run", "tests/server", "tests/a.test.ts"]);
      expect(runnerFilterArgs("npm -w pkg run test -- tests/server/ lib")).toEqual(["tests/server/", "lib"]);
      expect(runnerFilterArgs("npx vitest run --exclude tests/slow --config vite.config.ts && echo done")).toEqual(["run"]);
      expect(runnerFilterArgs("npx tsc --noEmit -p .")).toEqual([]);
    });
    it("requires a trailing slash on a folder", () => {
      const task = { verification:[{ command:"npx vitest run tests/server", cwd:root }] };
      const { errors } = lint(task, {}, folder);
      expect(codes({ errors, warnings:[] })).toEqual(["filter_folder_slash"]);
      expect(errors[0]!.message).toContain("write tests/server/");
      expect(lintProbePaths({ ...baseTask, ...task }, root)).toContain(`${root}/tests/server`);
    });
    it("accepts the slash, a file filter, and a word that is not a folder", () => {
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/server/", cwd:root }] }, {}, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/a.test.ts", cwd:root }] }, {}, folder))).toEqual([]);
      expect(codes(lint({ verification:[{ command:"npx vitest run tests/server", cwd:root }] }, {}, { ...folder, "tests/server":"missing" }))).toEqual([]);
    });
    it("rejects a bare vitest run while verification.sandbox_unsafe lists tests, with the flags to add", () => {
      const { errors } = lint({ verification:[{ command:"npx vitest run", cwd:root }] }, { sandboxUnsafe:["tests/pipeline.test.ts"] }, folder);
      expect(errors).toEqual([{ code:"sandbox_unsafe", message:expect.stringContaining('--exclude "tests/pipeline.test.ts"'),
        data:{ missingExcludes:["tests/pipeline.test.ts"], suggestedFlags:'--exclude "tests/pipeline.test.ts"' } }]);
    });
  });

  describe("depends_on", () => {
    it("sends the PM back to replan when a dependency ended blocked or canceled", () => {
      const { errors } = lint({ depends_on:["P1", "P2"] }, { deadDependencies:[{ id:"P1", state:"blocked" }, { id:"P2", state:"canceled" }] }, { "src/a.ts":"file" });
      expect(codes({ errors, warnings:[] })).toEqual(["depends_dead", "depends_dead"]);
      expect(errors[0]!.message).toMatch(/^replan: depends_on P1 ended blocked/);
      expect(errors[1]!.message).toMatch(/^replan: depends_on P2 ended canceled/);
      expect(lintReply("run", errors)).toMatchObject({ state:"validation_failed", replan:true });
    });
  });

  it("answers every problem in one message", () => {
    const { errors } = lint({ owns_paths:["../x"], expected_outputs:["lib/z.ts"] }, { deadDependencies:[{ id:"P1", state:"blocked" }] }, { "src/a.ts":"missing" });
    const reply = lintReply("run-1", errors) as { reason:string; findings:unknown[] };
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(reply.reason).toMatch(/^contract lint: nothing was dispatched and no attempt was spent/);
    expect(reply.reason.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(errors.length);
    expect(reply.findings).toHaveLength(errors.length);
  });
});

const projectId = "project-lint";
const pmThreadId = "pm-thread";
const runId = "run-lint";
const config = {
  projectId, hostId:"host-test", pmWorkspacePath:"/tmp/pm", writerWorkspacePath:root,
  pmProviderId:"claude-code", pmModel:"claude-test", writerProviderId:"codex", writerModel:"codex-test",
};

/** The dispatch of a task through the real plugin; the host answers snapshotDryRun from `kinds` or fails when it is null. */
async function setup(kinds:Record<string, PathKind> | null) {
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role:"pm", lanePilotRunId:runId } : { role:"writer" },
      spawn: async () => ({ id:"writer-lint" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => ({ id:threadId, status:"idle", projectId }) as never,
      output: async () => ({ text:"" }),
      list: async () => [] as never,
    }, providers:{ list: async () => [] as never, models: async () => ({ models:[] as never }) }, files:{ read: async () => ({ content:"fixture\n" }), write: async () => ({ ok:true }) } },
    experimental_callHostRpc: async (call) => {
      if (call.method === "snapshotDryRun") {
        if (!kinds) throw new Error("host went away");
        const paths = (call.input as { paths:string[] }).paths;
        return { hostId:"host-test", entries:paths.map((path) => ({ path, kind:kinds[path.slice(root.length + 1)] ?? "missing", sha256:null, symlinkTarget:null })) };
      }
      if (call.method === "gitOwnershipBase") return new Promise(() => undefined);
      return { hostId:"host-test", exitCode:0, stdout:String((call.input as { command?:string }).command ?? "").includes("porcelain") ? "[]" : "", stderr:"" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", root);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (next:Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm:true, plan:"Plan for the lint", task:{ ...baseTask, ...next } }, { threadId:pmThreadId, projectId },
  ))) as Record<string, unknown>;
  return { db, harness, dispatch };
}
const taskCount = (db:ReturnType<typeof openDatabase>) => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count:number }).count;

describe("contract lint at dispatch", () => {
  beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50"; });
  afterEach(() => { delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; });

  it("sends every contract error back in one message and creates no task and no attempt", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"missing", tests:"directory" });
    const reply = await dispatch({ owns_paths:["../x"], expected_outputs:["lib/z.ts"], verification:[{ command:"npx vitest run tests", cwd:root }] });
    expect(reply).toMatchObject({ runId, state:"validation_failed" });
    expect(String(reply.reason)).toContain("unsafe ownership path pattern: ../x");
    expect(String(reply.reason)).toContain("read_first source is missing: src/a.ts");
    expect(String(reply.reason)).toContain("write tests/");
    expect(String(reply.reason)).toContain("lib/z.ts");
    expect(taskCount(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) count FROM lane_pilot_attempt WHERE run_id=?").get(runId)).toEqual({ count:0 });
    expect(db.prepare("SELECT state FROM lane_pilot_run WHERE id=?").get(runId)).not.toMatchObject({ state:"blocked" });
    await harness.lifecycle.dispose();
  });

  it("returns replan, and does not start the task, when depends_on names a blocked task", async () => {
    const { db, harness, dispatch } = await setup({ "src/a.ts":"file" });
    createTask(db, { id:"dep-1", runId, kind:"bb", contract:{ ...baseTask, id:"dep-1" } });
    createAttempt(db, { id:"dep-attempt", runId, taskId:"dep-1" });
    transitionAttempt(db, "dep-attempt", "queued");
    transitionAttempt(db, "dep-attempt", "blocked", { reason:"missing expected_outputs: src/a.ts" });
    const reply = await dispatch({ depends_on:["dep-1"] });
    expect(reply).toMatchObject({ state:"validation_failed", replan:true });
    expect(String(reply.reason)).toContain("replan: depends_on dep-1 ended blocked");
    expect(taskCount(db)).toBe(1);
    expect(listAttemptsForTask(db, runId, "lint-task")).toHaveLength(0);
    // Sent again, the dependency is no longer dead: the name follows its redispatch and the dependent is queued.
    createTask(db, { id:"dep-1.2", runId, kind:"bb", contract:{ ...baseTask, id:"dep-1.2", owns_paths:["docs/"], expected_outputs:["docs/x.md"] } });
    createAttempt(db, { id:"dep-attempt-2", runId, taskId:"dep-1.2" });
    transitionAttempt(db, "dep-attempt-2", "queued");
    const queued = await dispatch({ depends_on:["dep-1"] });
    expect(queued).toMatchObject({ taskId:"lint-task", state:"queued" });
    await harness.lifecycle.dispose();
  });

  it("dispatches as before when the machine cannot be asked about the paths", async () => {
    const { db, harness, dispatch } = await setup(null);
    const reply = await dispatch();
    expect(reply).toMatchObject({ taskId:"lint-task", state:"queued" });
    expect(taskCount(db)).toBe(1);
    await harness.lifecycle.dispose();
  });
});
