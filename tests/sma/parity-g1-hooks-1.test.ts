/** @vitest-environment jsdom */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { MoneyScreen } from "../../src/rooms/cockpit/ui/screens-day";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import { createMoney } from "../../src/rooms/money/server";
import { createRun, createTask, createAttempt, loadPrototypeConfig, openDatabase, savePrototypeConfig, saveProjectSetting } from "../../src/rooms/plugin-db";
import { codeMapDrift, pretaskDecision, runStreams, sessionEndDraft, sessionStartText, spentWindows, stallObserve, stallStateOf, type ToolCtx } from "../../src/rooms/session-hooks/logic";
import { mountRateLimitWatch, RATE_LIMIT_PREFIX, readRateLimitSnapshot, snapshotAsBoardWindows } from "../../src/rooms/stability/server/rate-limit-watch";
import { createProviderUsage, limitEventHold, USAGE_LIST_METHOD } from "../../src/rooms/usage/server/provider-usage";
import { mountUsageSnapshots } from "../../src/rooms/usage/server/usage-snapshot";
import { persistTaskFolder } from "../../src/rooms/verification/git-integrate";
import { reflexLinesOf, taskFileCards } from "../../src/rooms/writer/server/writer-knowledge";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import { registerDispatchExecutors, startDispatchRun } from "../../src/rooms/writer/server/dispatch-workflow";
import { gateResolverFor } from "../../src/rooms/verification/server";
import { isTaskSatisfied } from "../../src/rooms/runs/server";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";

// The rules source of the task folder: the project's accepted rules. The rest of the learning room is the real one.
const rules = vi.hoisted(() => ({ list: [] as string[] }));
vi.mock("../../src/rooms/learning", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/rooms/learning")>()), writerDiffRules: () => rules.list }));

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function guard(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const ran = spawnSync("python3", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function hook(payload: Record<string, unknown>, home: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}

const bashPayload = (command: string, cwd: string, extra: Record<string, unknown> = {}) =>
  ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess-test", ...extra });

const newRepo = (prefix: string) => {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
  return repo;
};

const ctx: ToolCtx = { tool: "bash", sid: "s", cwd: "/tmp", command: "true", path: "", denials: {} };
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
const airbagRefs = (repo: string) => spawnSync("git", ["for-each-ref", "refs/lane-airbag/"], { cwd: repo, encoding: "utf8" }).stdout.trim();

/** The guard module itself, with its stream list replaced, run in its own process: the real _run_streams on named streams. */
function pythonStreams(body: string, env: Record<string, string> = {}) {
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(__dirname, "../../lane-stack/hooks"))})
import guard_shell as g
${body}
`;
  const ran = spawnSync("python3", ["-c", script], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: ran.status, out: ran.stdout.trim(), err: ran.stderr };
}

describe("the ordered check streams of one tool call", () => {
  it("[sma:k_h_pre] one guard process runs the streams in order, times each into perf.jsonl, and past the soft budget skips only the advice streams", () => {
    const repo = newRepo("sma-pre-");
    writeFileSync(join(repo, "REFLEXES.md"), "- WHEN git reset → check the airbag ref first\n");
    const home = tmp("sma-pre-home-");
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(out.stdout.indexOf("git-airbag")).toBeLessThan(out.stdout.indexOf("[reflex]"));
    const perf = lines(join(home, ".lane-pilot/session-hooks/sess-test/perf.jsonl")).map((line) => JSON.parse(line) as { stream: string });
    expect(perf.map((row) => row.stream)).toEqual(["deps", "git_airbag", "reflexes", "file_card", "spend", "claims"]);
    const limited = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home, LANE_STREAM_BUDGET_SEC: "0" });
    expect(limited.code).toBe(0);
    const rows = lines(join(home, ".lane-pilot/session-hooks/sess-test/perf.jsonl")).map((line) => JSON.parse(line) as { stream: string; error?: string });
    const lastRun = rows.slice(-6);
    // The airbag is a side effect, not advice: the budget never skips it; the four advice streams are skipped.
    expect(lastRun.filter((row) => row.error === "skipped: soft budget spent").map((row) => row.stream)).toEqual(["reflexes", "file_card", "spend", "claims"]);
    expect(lastRun.find((row) => row.stream === "git_airbag")!.error).toBeUndefined();
  });

  it("[sma:k_h_pre] with a budget of 0 the airbag ref still exists before a git reset --hard is allowed, as on main", () => {
    const repo = newRepo("sma-airbag-budget-");
    writeFileSync(join(repo, "work.txt"), "unsaved work\n");
    const home = tmp("sma-airbag-budget-home-");
    expect(airbagRefs(repo)).toBe("");
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home, LANE_STREAM_BUDGET_SEC: "0" });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("allow");
    expect(airbagRefs(repo)).toContain("refs/lane-airbag/");
    // The ref holds the untracked work.
    const ref = airbagRefs(repo).split(/\s+/)[2]!;
    expect(spawnSync("git", ["show", `${ref}:work.txt`], { cwd: repo, encoding: "utf8" }).stdout).toBe("unsaved work\n");
  });

  it("[sma:k_h_pre] a required stream that raises is not skipped: the error goes up as it did before the streams existed; an advice stream that raises is recorded and skipped", () => {
    const home = tmp("sma-raise-home-");
    const result = pythonStreams(`
def boom(p, name, cmd, path): raise KeyError("airbag broke")
def calm(p, name, cmd, path): return None, "[calm] still here"
g._STREAMS = (("git_airbag", boom, True, False), ("spend", calm, False, False))
try:
    g._run_streams({"session_id": "s-raise"}, "Bash", "git reset --hard", "")
    print("returned")
except KeyError:
    print("raised")
g._STREAMS = (("spend", boom, False, False), ("reflexes", calm, False, False))
print(json.dumps(g._run_streams({"session_id": "s-raise"}, "Bash", "ls", "")))
`, { HOME: home });
    expect(result.out.split("\n").map((line) => (line === "raised" ? line : JSON.parse(line)))).toEqual(["raised", [null, ["[calm] still here"]]]);
  });

  it("[sma:k_hp_merge] in the guard process only a can_deny stream refuses; another stream's deny merges as a [downgraded] warning", () => {
    const home = tmp("sma-merge-home-");
    const result = pythonStreams(`
def refuse(p, name, cmd, path): return "stop it", None
g._STREAMS = (("reflexes", refuse, False, False), ("spend", lambda p, n, c, pa: (None, "[spend] x"), False, False))
print(json.dumps(g._run_streams({"session_id": "s-merge"}, "Bash", "ls", "")))
g._STREAMS = (("deps", refuse, True, True),)
print(json.dumps(g._run_streams({"session_id": "s-merge"}, "Bash", "ls", "")))
`, { HOME: home });
    expect(result.out.split("\n").map((line) => JSON.parse(line))).toEqual([[null, ["[downgraded] stop it", "[spend] x"]], ["stop it", []]]);
    // And end to end: the real deps stream refuses through the real process with its own reason.
    const a = tmp("sma-merge-a-");
    const b = tmp("sma-merge-b-");
    mkdirSync(join(a, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(b, "node_modules"));
    symlinkSync(join(a, "node_modules", "pkg"), join(b, "node_modules", "pkg"));
    const denied = guard(bashPayload("npm install left-pad", b), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(denied.stdout + denied.stderr).toContain("dependency store");
  });

  it("[sma:k_hp_merge] the TS stream runner downgrades a deny of a stream without deny rights and never counts it", () => {
    const result = runStreams(ctx, () => 0, { reflexes: () => ({ deny: "stop it", advice: null }) });
    expect(result.deny).toBeNull();
    expect(result.advice).toEqual(["[downgraded] stop it"]);
    expect(result.denials.reflexes).toBeUndefined();
    const hard = runStreams(ctx, () => 0, { hard_rules: () => ({ deny: "real deny", advice: null }) });
    expect(hard.deny).toBe("real deny");
    expect(hard.denials.hard_rules).toBe(1);
  });
});

/** The dispatch of a task and its update on the real executors and the real update path, with a fake host that records every file write. */
describe("reflexes and file notes reach the task folder", () => {
  const runId = "run-g1";
  const projectId = "proj-g1";
  const pmThreadId = "pm-g1";
  const taskId = "task-g1";
  const baseTask: TaskV2 = {
    schema_version: 2, id: taskId, display_title: "T", kind: "feature", area: "feature:g1", title: "T", risk: "low", lane: "core", project_cwd: "/ws",
    read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["out.txt"], owns_paths: ["src/**"], never_touch: [], depends_on: [],
    objective: "Objective", acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }],
  };

  async function world() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, runId, projectId, "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host-1");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run(pmThreadId, runId);
    savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/ws", writerWorkspacePath: "/ws", pmProviderId: "p1", pmModel: "m1", writerProviderId: "p1", writerModel: "m1" });
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });
    const written = new Map<string, string>();
    const writes: string[] = [];
    const fakeBb = {
      storage: { kv: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] } },
      hosts: { experimental_client: () => ({ call: async () => ({ status: "ready", entries: [] }) }) },
      sdk: {
        files: {
          write: async (input: { path: string; content: string }) => { writes.push(input.path); written.set(input.path, input.content); },
          read: async (input: { path: string }) => (written.has(input.path) ? { content: written.get(input.path) } : null),
        },
        threads: { send: async () => {} },
      },
      log: { warn: () => {}, info: () => {} },
    };
    const ctxCore = { bb: fakeBb as never, db, state: { disposed: false }, configForRun: async (id: string) => loadPrototypeConfig(db, id), log: () => {} } as unknown as ServerCore;
    const services = { resolveIntegrationGate: gateResolverFor(ctxCore), isTaskSatisfied, activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: (id, version) => builtinWorkflow(id, version) });
    registerDispatchExecutors(engine);
    engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false } }) });
    Object.assign(services, { workflowEngine: engine, stageHelperSettings, isLiveFolder: async () => false, startWriterTask: () => undefined });
    const mutable = ctxCore as unknown as { host?: unknown; refreshRun?: unknown };
    mutable.host ??= { call: async (method: string) => (method === "gitOwnershipBase" ? { status: "not-git" } : { status: "ready", entries: [] }) };
    mutable.refreshRun ??= () => undefined;
    const run = startDispatchRun(engine, { ctx: ctxCore, services, threadId: pmThreadId, projectId, runId, taskId, attemptId: "att-1", config: loadPrototypeConfig(db, projectId)!, runConfig: loadPrototypeConfig(db, projectId)!,
      workspacePath: "/ws", task: baseTask, plan: baseTask.objective, lintWarnings: [] });
    return { db, harness, ctxCore, services, run, written, writes };
  }

  afterEach(() => { rules.list = []; });

  it("[sma:k_hs_reflex] [sma:k_lib_reflex] a dispatched task's folder gets REFLEXES.md from the accepted WHEN -> act rules (plain rules stay out), and the guard fires the matching act", async () => {
    rules.list = ["WHEN prisma migrate -> run it on a copy first", "always write tests first"];
    const w = await world();
    expect((await w.run.done).status).toBe("waiting");
    const reflexes = w.written.get("/ws/.agents/plans/items/task-g1/REFLEXES.md");
    expect(reflexes).toContain("- WHEN prisma migrate -> run it on a copy first");
    expect(reflexes).not.toContain("always write tests");
    expect(reflexLinesOf(rules.list)).toEqual(["- WHEN prisma migrate -> run it on a copy first"]);
    const dir = tmp("sma-reflex-prod-");
    mkdirSync(join(dir, ".agents/plans/items/task-g1"), { recursive: true });
    writeFileSync(join(dir, ".agents/plans/items/task-g1/REFLEXES.md"), reflexes!);
    const out = guard(bashPayload("npx prisma migrate dev", dir), { LANE_PILOT_ROLE: "writer", HOME: tmp("sma-reflex-prod-home-") });
    expect(out.stdout).toContain("run it on a copy first");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_reflex] [sma:k_hs_reflex] a rule retired before the task is updated leaves no line in REFLEXES.md: the update rewrites the file that is there, and writes nothing where there was none", async () => {
    rules.list = ["WHEN prisma migrate -> run it on a copy first"];
    const w = await world();
    await w.run.done;
    const file = "/ws/.agents/plans/items/task-g1/REFLEXES.md";
    expect(w.written.get(file)).toContain("WHEN prisma migrate");
    // The rule is retired: the real update path rewrites the folder.
    rules.list = [];
    const { updateTask } = createWriterUpdateTask(w.ctxCore, w.services);
    const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "T2" }, plan: "New plan" });
    expect(res.ok).toBe(true);
    expect(w.written.get(file)).toBe("# Reflexes\n");
    expect(w.written.get("/ws/.agents/plans/items/task-g1/PLAN.md")).toContain("New plan");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_hs_reflex] an install with no rule and no stale file writes no REFLEXES.md and no FILECARDS.md at dispatch or update", async () => {
    rules.list = [];
    const w = await world();
    await w.run.done;
    await createWriterUpdateTask(w.ctxCore, w.services).updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "T3" }, plan: "Plan 3" });
    expect(w.writes.filter((path) => /REFLEXES|FILECARDS/.test(path))).toEqual([]);
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_hs_context] taskFileCards takes only confirmed notes (an observed one past quarantine stays out) and clips the line; the folder write masks a credential in any line", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const limits = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
    storeMemoryRecords(db as never, { projectId: "P", audience: "subagent", sourceSha256: "a".repeat(64), ...limits, trust: "confirmed",
      entries: [{ kind: "note", content: "src/billing.ts keeps the invoice rounding rule and must round half up", concepts: ["billing", "rounding"] }] });
    storeMemoryRecords(db as never, { projectId: "P", audience: "subagent", sourceSha256: "b".repeat(64), ...limits, trust: "observed", now: Date.now() - 400 * 86_400_000,
      entries: [{ kind: "note", content: "src/billing.ts probably double-charges on retry", concepts: ["billing", "retry"] }] });
    const cards = await taskFileCards(db as never, "P", { ...baseTask, owns_paths: ["src/billing.ts"] });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.join("\n")).toContain("invoice rounding rule");
    expect(cards.join("\n")).not.toContain("double-charges");
    expect(cards.every((line) => line.length <= 260)).toBe(true);
    // persistTaskFolder masks a line another caller built, and the folder keeps the file's name.
    const written: Record<string, string> = {};
    await persistTaskFolder({ taskId: "t-2", filecards: ["src/a.ts -> token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 leaked"], writeFile: async (rel, content) => { written[rel] = content; } });
    const card = written[".agents/plans/items/t-2/FILECARDS.md"]!;
    expect(card).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    await harness.lifecycle.dispose();
  });
});

describe("the file notes in the guard", () => {
  const edit = (file: string, dir: string, home: string, env: Record<string, string> = {}) =>
    guard({ tool_name: "Edit", tool_input: { file_path: file }, cwd: dir, session_id: "sess-test" }, { LANE_PILOT_ROLE: "writer", HOME: home, ...env });

  it("[sma:k_hs_context] an Edit of a file with a stored note returns it as [file-note] at most twice; an uncatalogued file gets nothing; the old [file-card] tag is never used", () => {
    const dir = tmp("sma-card-");
    writeFileSync(join(dir, "FILECARDS.md"), "- src/a.ts -> this file is generated; edit the template\n");
    const home = tmp("sma-card-home-");
    expect(edit("src/a.ts", dir, home).stdout).toContain("[file-note] this file is generated");
    expect(edit("src/a.ts", dir, home).stdout).toContain("[file-note]");
    expect(edit("src/a.ts", dir, home).stdout).not.toContain("[file-note]");
    const other = edit("src/b.ts", dir, home);
    expect(other.stdout).not.toContain("[file-note]");
    expect(other.stdout).not.toContain("[file-card]");
  });

  it("[sma:k_hs_context] a note matches by the whole repo-relative path or a glob, never by a short substring", () => {
    const dir = tmp("sma-card-match-");
    writeFileSync(join(dir, "FILECARDS.md"), "- a -> short pattern note\n- src/*.sql -> migration note\n- docs/ -> docs folder note\n- src/exact.ts -> exact note\n");
    const home = tmp("sma-card-match-home-");
    const texts = (file: string) => edit(file, dir, home).stdout;
    expect(texts("src/data.ts")).not.toContain("short pattern note");
    expect(texts(join(dir, "src/exact.ts"))).toContain("exact note");
    expect(texts("src/init.sql")).toContain("migration note");
    expect(texts("docs/guide/x.md")).toContain("docs folder note");
    expect(texts("lib/other.ts")).not.toContain("[file-note]");
  });

  it("[sma:k_hs_context] with several task folders the session's own task is read (LANE_TASK_FILE), else the one written last, never the first in name order", () => {
    const dir = tmp("sma-card-task-");
    const item = (id: string, note: string, age: number) => {
      mkdirSync(join(dir, ".agents/plans/items", id), { recursive: true });
      const file = join(dir, ".agents/plans/items", id, "FILECARDS.md");
      writeFileSync(file, `- src/a.ts -> ${note}\n`);
      const at = new Date(Date.now() - age * 1000);
      utimesSync(file, at, at);
    };
    item("a-first", "note of the first task", 500);
    item("z-last", "note of the newest task", 5);
    const home = tmp("sma-card-task-home-");
    expect(edit("src/a.ts", dir, home).stdout).toContain("note of the newest task");
    expect(edit("src/a.ts", dir, tmp("sma-card-task-home2-"), { LANE_TASK_FILE: "/x/tasks/a-first.yml" }).stdout).toContain("note of the first task");
    // A named task with no card of its own shows nobody else's.
    expect(edit("src/a.ts", dir, tmp("sma-card-task-home3-"), { LANE_TASK_FILE: "/x/tasks/unknown-task.yml" }).stdout).not.toContain("[file-note]");
  });
});

describe("the session's own state folder", () => {
  it("[sma:k_h_pre] the guard and the hook put a session id with a dot in the same folder, and a dot-only id is not a folder name", () => {
    const home = tmp("sma-sid-home-");
    const out = guard(bashPayload("ls", home, { session_id: "run.7" }), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(out.code).toBe(0);
    hook({ hook_event_name: "PostToolUse", session_id: "run.7", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" }, home);
    const folders = readdirSync(join(home, ".lane-pilot/session-hooks"));
    expect(folders).toEqual(["run.7"]);
    // ledger.json (k_hpc_progress) is the session's touched-files/commands record, new in wave G.
    expect(readdirSync(join(home, ".lane-pilot/session-hooks/run.7")).sort()).toEqual(["ledger.json", "perf.jsonl", "stall-trail.json", "stall.json"]);
    // A session id that is only dots would climb out of the folder: both sides use the same fixed name.
    guard(bashPayload("ls", home, { session_id: ".." }), { LANE_PILOT_ROLE: "writer", HOME: home });
    hook({ hook_event_name: "PostToolUse", session_id: "..", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" }, home);
    expect(readdirSync(join(home, ".lane-pilot/session-hooks")).sort()).toEqual(["run.7", "session"]);
    expect(existsSync(join(home, ".lane-pilot/stall.json"))).toBe(false);
  });

  it("[sma:k_h_pre] perf.jsonl past 256 KB keeps its newest 500 lines, on the guard side and on the hook side", () => {
    const home = tmp("sma-perfcap-home-");
    const folder = join(home, ".lane-pilot/session-hooks/sess-test");
    mkdirSync(folder, { recursive: true });
    const old = Array.from({ length: 4000 }, (_, i) => JSON.stringify({ stream: "old", n: i, pad: "x".repeat(60) })).join("\n") + "\n";
    expect(old.length).toBeGreaterThan(256 * 1024);
    writeFileSync(join(folder, "perf.jsonl"), old);
    guard(bashPayload("ls", home), { LANE_PILOT_ROLE: "writer", HOME: home });
    const afterGuard = lines(join(folder, "perf.jsonl"));
    expect(afterGuard.length).toBeLessThanOrEqual(506);
    expect(afterGuard.length).toBeGreaterThan(400);
    expect(JSON.parse(afterGuard[0]!).n).toBeGreaterThanOrEqual(3500);
    writeFileSync(join(folder, "perf.jsonl"), old);
    hook({ hook_event_name: "PreToolUse", session_id: "sess-test", tool_name: "Bash", tool_input: { command: "ls" } }, home);
    const afterHook = lines(join(folder, "perf.jsonl"));
    expect(afterHook.length).toBeLessThanOrEqual(501);
    expect(afterHook.length).toBeGreaterThan(400);
    // Under the cap nothing is cut.
    writeFileSync(join(folder, "perf.jsonl"), "{\"stream\":\"a\"}\n");
    guard(bashPayload("ls", home), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(lines(join(folder, "perf.jsonl")).length).toBe(7);
  });

  it("[sma:k_h_pre] a session start removes at most 50 state folders whose newest file is over 30 days old, never the current one, a recent one, a link or a folder with another name", () => {
    const home = tmp("sma-prune-home-");
    const root = join(home, ".lane-pilot/session-hooks");
    mkdirSync(root, { recursive: true });
    const aged = (name: string, days: number) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "perf.jsonl");
      writeFileSync(file, "x\n");
      const at = new Date(Date.now() - days * 86_400_000);
      utimesSync(file, at, at);
      utimesSync(dir, at, at);
    };
    for (let i = 0; i < 60; i++) aged(`old-${i}`, 40);
    aged("recent", 3);
    aged("current", 90);
    aged("odd name", 90);
    // An old folder with one fresh file is in use, whatever the folder's own age says.
    aged("old-but-used", 90);
    writeFileSync(join(root, "old-but-used", "stall.json"), "{}");
    const outside = tmp("sma-prune-outside-");
    writeFileSync(join(outside, "keep.txt"), "keep");
    const at = new Date(Date.now() - 90 * 86_400_000);
    symlinkSync(outside, join(root, "link-to-outside"));
    const start = () => hook({ hook_event_name: "SessionStart", session_id: "current" }, home);
    expect(start().status).toBe(0);
    const left = readdirSync(root);
    expect(left.filter((name) => name.startsWith("old-") && name !== "old-but-used")).toHaveLength(10);
    for (const kept of ["recent", "current", "odd name", "old-but-used", "link-to-outside"]) expect(left).toContain(kept);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    start();
    expect(readdirSync(root).filter((name) => /^old-\d+$/.test(name))).toHaveLength(0);
    void at;
  });

  it("[sma:k_wp_drift] SessionStart takes the code map's commit only as a plain hex sha: a value that git would read as an option runs nothing", () => {
    const repo = newRepo("sma-drift-safe-");
    mkdirSync(join(repo, ".gitnexus"));
    writeFileSync(join(repo, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: "--output=pwned" }));
    const home = tmp("sma-drift-safe-home-");
    const out = hook({ hook_event_name: "SessionStart", session_id: "s-safe", cwd: repo }, home);
    expect(out.status).toBe(0);
    expect(out.stdout).not.toContain("Code map");
    expect(existsSync(join(repo, "pwned..HEAD"))).toBe(false);
    writeFileSync(join(repo, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: ["abc1234"] }));
    expect(hook({ hook_event_name: "SessionStart", session_id: "s-safe2", cwd: repo }, home).stdout).not.toContain("Code map");
  });
});

describe("stall detection and the one-nudge rule", () => {
  it("[sma:k_hst_detect] ping-pong between two calls and a read-only run give advice and do not block", () => {
    let state = stallStateOf({});
    const feed = (tool: string, input: unknown, response: unknown) => {
      const out = stallObserve(state, tool, input, response);
      state = out.state;
      return out.hint;
    };
    let hint = "";
    for (let i = 0; i < 3; i++) {
      hint = feed("bash", { command: "aa" }, `result A at 1${i}:00`) || hint;
      hint = feed("bash", { command: "bb" }, `result B at 1${i}:00`) || hint;
    }
    expect(hint).toContain("alternating between two calls");
    state = stallStateOf({});
    let mono = "";
    for (let i = 0; i < 8; i++) mono = feed("read", { file_path: `/f${i}.ts` }, `content-${i}`) || mono;
    expect(mono).toContain("read-only calls in a row");
    state = stallStateOf({});
    for (let i = 0; i < 4; i++) feed("read", { file_path: `/r${i}` }, `x${i}`);
    feed("bash", { command: "make" }, "ok");
    mono = "";
    for (let i = 4; i < 8; i++) mono = feed("read", { file_path: `/r${i}` }, `x${i}`) || mono;
    expect(mono).toBe("");
  });

  it("[sma:k_hst_nudge] one nudge per pattern per session; a second pattern still gets its own", () => {
    let state = stallStateOf({});
    const hints: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = stallObserve(state, "read", { file_path: "/same" }, "identical");
      state = out.state;
      hints.push(out.hint);
    }
    expect(hints[2]).toContain("already been returned 3 times");
    expect(hints[3]).toBe("");
    expect(hints[4]).toBe("");
    state = stallObserve(state, "bash", { command: "make" }, "ok").state;
    state = stallObserve(state, "read", { file_path: "/other" }, "different-result").state;
    state = stallObserve(state, "read", { file_path: "/other" }, "different-result").state;
    const third = stallObserve(state, "read", { file_path: "/other" }, "different-result").hint;
    expect(third).toContain("already been returned 3 times");
  });

  it("[sma:k_hp_ctx] stall.json stays the counts map main writes; the trail (recent, readRun, nudged) is in stall-trail.json beside it", () => {
    const home = tmp("sma-stall-home-");
    const post = () => hook({ hook_event_name: "PostToolUse", session_id: "s-stall", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" }, home);
    post(); post();
    const folder = join(home, ".lane-pilot/session-hooks/s-stall");
    const counts = JSON.parse(readFileSync(join(folder, "stall.json"), "utf8")) as Record<string, number>;
    expect(Object.values(counts)).toEqual([2]);
    const trail = JSON.parse(readFileSync(join(folder, "stall-trail.json"), "utf8")) as { recent: string[]; readRun: number; nudged: string[] };
    expect(trail.recent).toHaveLength(2);
    expect(trail.readRun).toBe(0);
    expect(Array.isArray(trail.nudged)).toBe(true);
  });
});

describe("the session's own record", () => {
  it("[sma:k_hse_farewell] a SessionEnd with no files in its payload still names the files PostToolUse journaled, and registers as a native hook event", async () => {
    const home = tmp("sma-farewell-");
    for (const file of ["/w/a.ts", "/w/b.ts"]) {
      const out = hook({ hook_event_name: "PostToolUse", session_id: "s-end", tool_name: "Edit", tool_input: { file_path: file }, tool_response: "ok" }, home);
      expect(out.status).toBe(0);
    }
    hook({ hook_event_name: "SubagentStop", session_id: "s-end", claimed: ["/w/missing.ts"], changed: [] }, home);
    const end = hook({ hook_event_name: "SessionEnd", session_id: "s-end" }, home);
    expect(end.status).toBe(0);
    const farewell = readFileSync(join(home, ".lane-pilot/session-hooks/s-end/farewell.md"), "utf8");
    expect(farewell).toContain("/w/a.ts");
    expect(farewell).toContain("/w/b.ts");
    expect(farewell).toContain("Subagents: 1");
    expect(farewell).toContain("/w/missing.ts");
    const dest = join(tmp("sma-farewell-hooks-"), "launch");
    const result = await materializeNativeHookSession({ destDir: dest });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(settings.hooks.SessionEnd?.[0]?.hooks[0]?.command).toContain("session-hook.mjs");
  });

  it("[sma:k_wd_c2] the farewell draft merges the subagent receipts with their unverified paths", () => {
    const draft = sessionEndDraft({ files: ["a.ts"], at: "t", subagents: { count: 2, missing: ["/x.ts"] } });
    expect(draft).toContain("Subagents: 2");
    expect(draft).toContain("/x.ts");
    expect(sessionEndDraft({ files: [], at: "t" })).not.toContain("Subagents");
  });

  it("[sma:k_wp_drift] a stale code map is named at session start; a fresh one adds nothing", () => {
    expect(codeMapDrift("aaa", "bbb", 3)).toBe(3);
    expect(codeMapDrift("aaa", "aaa", 0)).toBe(0);
    expect(sessionStartText({ codeMapBehind: 3 })).toContain("Code map is 3 commits behind HEAD");
    expect(sessionStartText({ codeMapBehind: 0 })).toBeNull();
    const repo = newRepo("sma-drift-");
    const first = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["commit", "-qm", "two", "--allow-empty"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
    mkdirSync(join(repo, ".gitnexus"));
    writeFileSync(join(repo, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: first }));
    const out = hook({ hook_event_name: "SessionStart", session_id: "s-drift", cwd: repo }, tmp("sma-drift-home-"));
    expect(out.stdout).toContain("Code map is 1 commits behind HEAD");
  });
});

describe("the spend marks and the Task cap", () => {
  const homeWith = (snapshot: Record<string, unknown> | null) => {
    const home = tmp("sma-spend-home-");
    if (snapshot) {
      mkdirSync(join(home, ".lane-pilot"), { recursive: true });
      writeFileSync(join(home, ".lane-pilot/usage-snapshot.json"), JSON.stringify(snapshot));
    }
    return home;
  };
  const future = new Date(Date.now() + 3 * 3_600_000).toISOString();
  const snap = (over: Record<string, unknown> = {}) => ({
    at: new Date().toISOString(), skipPercent: 90, skipSetByHuman: true,
    windows: [{ label: "five-hour", usedPercent: 95, resetsAt: future, model: null }], ...over,
  });
  const task = (home: string, input: Record<string, unknown> = {}, env: Record<string, string> = {}, session = "s-cap") =>
    hook({ hook_event_name: "PreToolUse", session_id: session, tool_name: "Task", tool_input: { subagent_type: "Explore", prompt: "look", ...input } }, home, env);
  const reason = (out: { stdout: string }) => { try { return String((JSON.parse(out.stdout) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? ""); } catch { return ""; } };

  it("[sma:k_hs_spend] a window at 72 warns once, at 92 warns once more, never the same twice", () => {
    const home = homeWith(snap({ skipSetByHuman: false, windows: [{ label: "five-hour", usedPercent: 72, resetsAt: future, model: null }] }));
    const run = () => guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(run().stdout).toContain("[spend] five-hour is at 72%");
    expect(run().stdout).not.toContain("[spend]");
    writeFileSync(join(home, ".lane-pilot/usage-snapshot.json"), JSON.stringify(snap({ windows: [{ label: "five-hour", usedPercent: 92, resetsAt: future, model: null }] })));
    expect(run().stdout).toContain("at 92%");
    expect(run().stdout).not.toContain("[spend]");
  });

  it("[sma:k_hs_spend] an old snapshot, a snapshot with no time and a window that already reset give no spend advice", () => {
    const run = (home: string) => guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home }).stdout;
    const hot = [{ label: "five-hour", usedPercent: 95, resetsAt: future, model: null }];
    expect(run(homeWith(snap({ at: new Date(Date.now() - 3 * 3_600_000).toISOString(), windows: hot })))).not.toContain("[spend]");
    expect(run(homeWith(snap({ at: undefined, windows: hot })))).not.toContain("[spend]");
    expect(run(homeWith(snap({ windows: [{ label: "five-hour", usedPercent: 95, resetsAt: new Date(Date.now() - 60_000).toISOString(), model: null }] })))).not.toContain("[spend]");
    expect(run(homeWith(snap({ windows: hot })))).toContain("[spend] five-hour is at 95%");
  });

  it("[sma:k_h_pre] a Read in a lane session runs no stream and writes no perf line", () => {
    const home = homeWith(snap());
    const out = guard({ tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home, session_id: "sess-read" }, { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(out.stdout).not.toContain("[spend]");
    expect(existsSync(join(home, ".lane-pilot/session-hooks/sess-read/perf.jsonl"))).toBe(false);
  });

  it("[sma:k_hs_spend] a Task is denied past a human-set cap with the window, its percent, the cap, the reset time and the way to lift it", () => {
    const denied = reason(task(homeWith(snap())));
    expect(denied).toContain("[spend-cap]");
    expect(denied).toContain("five-hour");
    expect(denied).toContain("95%");
    expect(denied).toContain("90%");
    expect(denied).toContain(future);
    expect(denied).toContain("usage.skip_percent=0");
    // Without a human-set cap, or without any snapshot, nothing changes.
    expect(reason(task(homeWith(snap({ skipSetByHuman: false }))))).toBe("");
    expect(reason(task(homeWith(null)))).toBe("");
  });

  it("[sma:k_hs_spend] usage.skip_percent = 0 is off: no Task is denied at 0 >= 0, with windows or without", () => {
    expect(reason(task(homeWith(snap({ skipPercent: 0, skipSetByHuman: true }))))).toBe("");
    expect(reason(task(homeWith(snap({ skipPercent: 0, skipSetByHuman: true, windows: [] }))))).toBe("");
    expect(pretaskDecision({ role: "", kind: "Explore", background: false, spawned: 0, usage: { skipSetByHuman: true, skipPercent: 0, windows: [], at: new Date().toISOString() } }).deny).toBeUndefined();
  });

  it("[sma:k_hs_spend] a missing, unreadable or old measurement time decides nothing", () => {
    const home = (over: Record<string, unknown>) => homeWith({ ...snap(), ...over });
    expect(reason(task(home({ at: undefined })))).toBe("");
    expect(reason(task(home({ at: "not a date" })))).toBe("");
    expect(reason(task(home({ at: 12345 })))).toBe("");
    expect(reason(task(home({ at: new Date(Date.now() - 3 * 3_600_000).toISOString() })))).toBe("");
    expect(reason(task(home({ at: new Date(Date.now() - 30 * 60_000).toISOString() })))).toContain("[spend-cap]");
  });

  it("[sma:k_hs_spend] a window that already reset is ignored, and a model window counts only for that model", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(reason(task(homeWith(snap({ windows: [{ label: "five-hour", usedPercent: 99, resetsAt: past, model: null }] }))))).toBe("");
    const opus = snap({ windows: [{ label: "7d Opus", usedPercent: 97, resetsAt: future, model: "Opus" }] });
    expect(reason(task(homeWith(opus), { model: "claude-sonnet-4-5" }))).toBe("");
    expect(reason(task(homeWith(opus), { model: "claude-opus-4-1" }))).toContain("7d Opus");
    // With no model on the call, the session's own model (kept at session start) decides.
    const home = homeWith(opus);
    hook({ hook_event_name: "SessionStart", session_id: "s-model", model: "claude-opus-4-1" }, home);
    expect(reason(task(home, {}, {}, "s-model"))).toContain("7d Opus");
    expect(spentWindows([{ usedPercent: 91, model: "opus" }], { model: "claude-sonnet", threshold: 90, now: Date.now() })).toEqual([]);
  });

  it("[sma:k_hs_spend] the cap is checked after the refusals main gave: a call main refused keeps main's reason", () => {
    const home = homeWith(snap());
    expect(reason(task(home, { run_in_background: true }))).toContain("[subagent-foreground]");
    expect(reason(task(home, { subagent_type: "general-purpose" }, { LANE_PILOT_ROLE: "writer" }))).toContain("[execution-without-agent]");
    mkdirSync(join(home, ".lane-pilot/session-hooks/s-full"), { recursive: true });
    writeFileSync(join(home, ".lane-pilot/session-hooks/s-full/spawned.txt"), "8");
    expect(reason(task(home, {}, {}, "s-full"))).toContain("[subagent-cap]");
    // The same session with room left meets the cap.
    expect(reason(task(home, {}, {}, "s-roomy"))).toContain("[spend-cap]");
  });
});

describe("the scheduled usage snapshot pass", () => {
  function pass(hosts: string[], readings: (hostId: string) => unknown, setting?: unknown) {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    if (setting !== undefined) saveProjectSetting(db as never, GLOBAL_SETTINGS_PROJECT_ID, "usage.skip_percent", setting);
    const calls: Array<{ hostId: string; snapshot: Record<string, unknown> }> = [];
    let inFlight = 0;
    let peak = 0;
    const logs: string[] = [];
    let work: (() => Promise<void>) | null = null;
    const fail = new Set<string>();
    const fakeBb = {
      background: { schedule: (_name: string, _cron: string, fn: () => Promise<void>) => { work = fn; } },
      sdk: { hosts: { list: async () => hosts.map((id) => ({ id, name: id, connected: true, status: "connected" })) } },
      hosts: { experimental_client: () => ({ call: async (_method: string, input: { snapshot: Record<string, unknown>; requestedHostId: string }) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (fail.has(input.requestedHostId)) throw new Error("host unreachable");
        calls.push({ hostId: input.requestedHostId, snapshot: input.snapshot });
        return { hostId: input.requestedHostId, written: true };
      } }) },
      log: { warn: (line: string) => logs.push(line), info: () => {} },
    };
    const readingCalls: string[] = [];
    const providerUsage = { readings: async ({ hostId }: { hostId: string }) => { readingCalls.push(hostId); return readings(hostId); } };
    mountUsageSnapshots({ db, bb: fakeBb } as never, providerUsage as never);
    return { run: () => work!(), calls, logs, readingCalls, fail, peak: () => peak, harness };
  }
  const reading = (percent: number) => ({ measuredAt: "2026-11-11T10:00:00.000Z", windows: [{ label: "five-hour", usedPercent: percent, resetsAt: "2026-11-11T15:00:00.000Z", model: null }] });

  it("[sma:k_hs_spend] the pass calls every connected machine at most four at a time, writes the figure's own measurement time, and an unchanged reading makes no host call", async () => {
    const hosts = ["h1", "h2", "h3", "h4", "h5", "h6"];
    const p = pass(hosts, () => reading(40));
    await p.run();
    expect(p.calls.map((c) => c.hostId).sort()).toEqual(hosts);
    expect(p.peak()).toBeLessThanOrEqual(4);
    expect(p.peak()).toBeGreaterThan(1);
    expect(p.calls[0]!.snapshot).toMatchObject({ at: "2026-11-11T10:00:00.000Z", skipSetByHuman: false, skipPercent: 90 });
    expect((p.calls[0]!.snapshot.windows as unknown[])[0]).toMatchObject({ label: "five-hour", usedPercent: 40, model: null });
    await p.run();
    expect(p.calls).toHaveLength(6);
    await p.harness.lifecycle.dispose();
  });

  it("[sma:k_hs_spend] a changed reading is written again, a reading nothing answered for writes nothing, and a human-set 0 is stored as off", async () => {
    let percent = 40;
    const p = pass(["h1", "h2"], (hostId) => (hostId === "h2" ? { measuredAt: null, windows: [] } : reading(percent)), 0);
    await p.run();
    expect(p.calls.map((c) => c.hostId)).toEqual(["h1"]);
    expect(p.calls[0]!.snapshot).toMatchObject({ skipPercent: 0, skipSetByHuman: false });
    percent = 55;
    await p.run();
    expect(p.calls.filter((c) => c.hostId === "h1")).toHaveLength(2);
    await p.harness.lifecycle.dispose();
  });

  it("[sma:k_hs_spend] a machine that fails costs one log line and does not stop the others or throw; a pass whose host list fails does not throw either", async () => {
    const p = pass(["h1", "h2", "h3"], () => reading(10));
    p.fail.add("h2");
    await expect(p.run()).resolves.toBeUndefined();
    expect(p.calls.map((c) => c.hostId).sort()).toEqual(["h1", "h3"]);
    expect(p.logs.filter((line) => line.includes("h2"))).toHaveLength(1);
    const broken = pass(["h1"], () => { throw new Error("usage source down"); });
    await expect(broken.run()).resolves.toBeUndefined();
    expect(broken.calls).toEqual([]);
    expect(broken.logs).toHaveLength(1);
    await p.harness.lifecycle.dispose();
    await broken.harness.lifecycle.dispose();
  });
});

describe("the stored rate-limit event", () => {
  const harness = () => {
    const store = new Map<string, unknown>();
    const sets: string[] = [];
    const handlers: Array<(payload: unknown) => unknown> = [];
    const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { sets.push(key); store.set(key, value); } };
    const ctx = { isDisposed: () => false, bb: { storage: { kv }, log: { info: () => {} }, events: { on: (_name: string, handler: (payload: unknown) => unknown) => { handlers.push(handler); } } } };
    mountRateLimitWatch(ctx as never);
    const send = (rateLimits: Record<string, unknown>) => handlers[0]!({ event: { type: "provider/rateLimits/updated", rateLimits } });
    return { store, sets, kv, send };
  };
  const limits = (resetsAtMs: number, status = "blocked") => ({ kind: "subscription-window", providerId: "claude-code", status, windows: [{ label: "five-hour", providerKey: "five_hour", status, resetsAtMs }] });

  it("[sma:k_h_statusline] a subscription-window event of any thread lands in the store; another kind of limit does not; the same event again inside a minute writes nothing, a changed one or an old store does", async () => {
    const h = harness();
    const reset = Date.now() + 3_600_000;
    await h.send(limits(reset));
    expect(h.sets).toEqual([`${RATE_LIMIT_PREFIX}claude-code`]);
    expect((await readRateLimitSnapshot(h.kv, "claude-code"))?.windows[0]).toMatchObject({ label: "five-hour", status: "blocked", resetsAtMs: reset });
    await h.send({ ...limits(reset), kind: "credits", providerId: "other" });
    await h.send(limits(reset));
    await h.send(limits(reset));
    expect(h.sets).toHaveLength(1);
    await h.send(limits(reset + 1000, "warning"));
    expect(h.sets).toHaveLength(2);
    // The same value again, but the stored one is two minutes old.
    const stored = h.store.get(`${RATE_LIMIT_PREFIX}claude-code`) as { at: number };
    h.store.set(`${RATE_LIMIT_PREFIX}claude-code`, { ...stored, at: Date.now() - 120_000 });
    await h.send(limits(reset + 1000, "warning"));
    expect(h.sets).toHaveLength(3);
  });

  it("[sma:k_h_statusline] the money hold is what main holds: a stored blocked window with a future reset holds nothing there", async () => {
    const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await bb.storage.kv.set(`${RATE_LIMIT_PREFIX}claude-code`, { at: Date.now(), status: "blocked", windows: [{ label: "five-hour", status: "blocked", resetsAtMs: Date.now() + 3_600_000 }] } as never);
    saveProjectSetting(db as never, GLOBAL_SETTINGS_PROJECT_ID, "usage.skip_percent", 90);
    const { money } = createMoney({ db, bb } as never);
    expect(await money.holds("claude-code", "claude-sonnet-4-5", "h1")).toBeNull();
    await fake.lifecycle.dispose();
  });

  const NOW = Date.parse("2026-11-11T12:00:00Z");
  const fresh = (windows: Array<Record<string, unknown>>, at = NOW - 60_000) => ({ at, windows }) as never;
  const blocked = (over: Record<string, unknown> = {}) => ({ label: "five-hour", providerKey: null, status: "blocked", resetsAtMs: NOW + 3_600_000, ...over });

  it("[sma:k_h_statusline] the stored event holds only while its reset is ahead, it is under six hours old, and usage.skip_percent is stored above 0", () => {
    const settings = { "usage.skip_percent": 90 };
    const hold = (event: unknown, over: Record<string, unknown> = {}) => limitEventHold(event as never, { model: "claude-sonnet-4-5", threshold: 90, now: NOW, settings, ...over } as never);
    expect(hold(fresh([blocked()]))).toMatchObject({ percent: 100, window: "five-hour", resetsAt: new Date(NOW + 3_600_000).toISOString() });
    expect(hold(fresh([blocked({ resetsAtMs: NOW - 1 })]))).toBeNull();
    expect(hold(fresh([blocked()], NOW - 7 * 3_600_000))).toBeNull();
    expect(hold(fresh([blocked({ status: "warning" })]))).toBeNull();
    expect(hold(fresh([blocked()]), { settings: {} })).toBeNull();
    expect(hold(fresh([blocked()]), { settings: { "usage.skip_percent": 0 }, threshold: 0 })).toBeNull();
    expect(hold(null)).toBeNull();
    // A model window counts only for that model.
    const opus = fresh([blocked({ label: "7d Opus", providerKey: "seven_day_opus" })]);
    expect(hold(opus, { model: "claude-sonnet-4-5" })).toBeNull();
    expect(hold(opus, { model: "claude-opus-4-1" })).toMatchObject({ window: "7d Opus" });
  });

  function usageWith(readings: "none" | "room" | "full", event: unknown) {
    const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
    const plugins = readings === "none" ? {} : {
      experimental_discoverRpc: async () => [{ pluginId: "usage-src" }],
      callRpc: async ({ method }: { method: string }) => method === USAGE_LIST_METHOD
        ? { resources: [{ id: "r1", providerId: "claude-code", scope: { kind: "shared" } }] }
        : { usage: { status: "ok", windows: [{ kind: "five-hour", label: "five-hour", usedPercent: readings === "room" ? 10 : 99, resetsAt: null, model: null }] } },
    };
    const wrapped = { ...bb, sdk: { ...(bb.sdk as object), plugins } } as never;
    return { usage: createProviderUsage(wrapped, () => NOW, undefined, async () => event as never), fake };
  }

  it("[sma:k_h_statusline] the writer hold falls back to the stored event only where the live reading has no answer; a reading with room, or a spent one, is the live answer", async () => {
    const event = fresh([blocked()]);
    const settings = { "usage.skip_percent": 90 };
    const ask = (u: ReturnType<typeof usageWith>) => u.usage.hold({ providerId: "claude-code", model: "claude-sonnet-4-5", hostId: "h1", threshold: 90, settings });
    const none = usageWith("none", event);
    expect(await ask(none)).toMatchObject({ percent: 100, window: "five-hour" });
    // The same walk as a live hold: threshold 0 turns it off, and without the setting stored nothing is held.
    expect(await none.usage.hold({ providerId: "claude-code", model: "m", hostId: "h1", threshold: 0, settings })).toBeNull();
    expect(await none.usage.hold({ providerId: "claude-code", model: "m", hostId: "h1", threshold: 90, settings: {} })).toBeNull();
    const room = usageWith("room", event);
    expect(await ask(room)).toBeNull();
    const full = usageWith("full", fresh([]));
    expect(await ask(full)).toMatchObject({ percent: 99 });
    await Promise.all([none.fake.lifecycle.dispose(), room.fake.lifecycle.dispose(), full.fake.lifecycle.dispose()]);
  });

  it("[sma:k_h_statusline] the cockpit fallback shows a stored event only while its reset is ahead, marked with the event's time; a live figure wins; an expired event shows nothing", async () => {
    const open = () => createFakePluginHost({ pluginId: "lane-pilot" });
    const { bb, harness: fake } = open();
    const db = openDatabase(bb);
    const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, { front: { actions: async () => [], peers: async () => [] } } as never) as Record<string, (input: never) => Promise<unknown>>;
    const eventAt = Date.now() - 5 * 60_000;
    await bb.storage.kv.set(`${RATE_LIMIT_PREFIX}claude-code`, { at: eventAt, status: "blocked", windows: [{ label: "five_hour", status: "blocked", resetsAtMs: Date.now() + 3_600_000 }, { label: "seven_day", status: "blocked", resetsAtMs: Date.now() - 1000 }] } as never);
    const shown = await rpc.cockpit_windows({ hostId: "h1" } as never) as { at: string; windows: Record<string, { utilization: number }>; limitEventAt?: string };
    expect(Object.keys(shown.windows)).toEqual(["five_hour"]);
    expect(shown.windows.five_hour!.utilization).toBe(100);
    expect(shown.limitEventAt).toBe(new Date(eventAt).toISOString());
    await bb.storage.kv.set(`${RATE_LIMIT_PREFIX}claude-code`, { at: eventAt, status: "blocked", windows: [{ label: "five_hour", status: "blocked", resetsAtMs: Date.now() - 1000 }] } as never);
    expect(await rpc.cockpit_windows({ hostId: "h1" } as never)).toEqual({ hostId: "h1", at: null, windows: {} });
    expect(snapshotAsBoardWindows(null)).toEqual({ at: null, windows: {} });
    await fake.lifecycle.dispose();
  });

  it("[sma:k_h_statusline] the Money screen prints «по последнему событию лимита, ЧЧ:ММ» when the figure comes from the stored event, and nothing of the kind for a live figure", async () => {
    setLocaleOverride("ru");
    const at = new Date(2026, 10, 11, 9, 5).toISOString();
    const rpc = (limitEventAt?: string) => ({ call: async (name: string) => name === "money_status" ? { monthUsd: 0, cap: null, left: null }
      : name === "cockpit_windows" ? { at, windows: { five_hour: { utilization: 100, resetsAt: null } }, ...(limitEventAt ? { limitEventAt } : {}) } : [] });
    const event = render(createElement(MoneyScreen, { rpc: rpc(at) as never, hostId: "h1" }));
    await waitFor(() => expect(event.container.textContent).toContain("по последнему событию лимита, 09:05"));
    event.unmount();
    const live = render(createElement(MoneyScreen, { rpc: rpc() as never, hostId: "h1" }));
    await waitFor(() => expect(live.container.textContent).toContain("five_hour"));
    expect(live.container.textContent).not.toContain("по последнему событию лимита");
    live.unmount();
    cleanup();
    setLocaleOverride(null);
  });
});
