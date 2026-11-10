import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { createStability } from "../../src/rooms/stability/server/stability";
import { createTaskReconcile } from "../../src/rooms/runs/server/task-reconcile";
import type { Services } from "../../server";
import { pretaskDecision, DOCUMENTARY_AGENTS, conventionGateHits } from "../../src/rooms/session-hooks/logic";
import { withoutCodeWritingSubagents, LANE_PILOT_PM_SESSION } from "../../src/rooms/native-agent/native-agent-overlay";
import { listUnmovedLiveAttempts, listOpenWorktrees, registerWorktree } from "../../src/rooms/storage";
import { findUnownedChanges } from "../../src/rooms/contracts/ownership";
import { gitOwnershipChangedPaths } from "../../src/rooms/verification/git-ownership";
import { reconcileWorktreeRegistry } from "../../src/rooms/stability/server/worktree-janitor";
import { calibrate } from "../../src/rooms/forecast/logic";
import { calibrationPassport } from "../../src/rooms/forecast/server/report";
import { noteProtectionDisarm, rearmExpiredDisarms, renewDisarm } from "../../src/rooms/policy/protections";
import { missCurriculum } from "../../src/rooms/tools/server/self-improve";
import { recordMemoryMiss, searchMemoryRecords, storeMemoryRecordsKeepingOverflow } from "../../packages/memory-core/src";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { checkoutOwnsOverlap } from "../../src/rooms/tasks/task-base";
import { placeLanePilotGuard } from "../../src/rooms/native-install/native-install-bootstrap";
import { ownedPmGuardPath } from "../../src/rooms/native-install/guard-apply";
import { sessionOverrideAgentsJson, CLI_AGENT_DEFINITION_FIELDS } from "../../src/rooms/native-agent/native-agent-definition";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { nativeAgentCliId } from "../../src/rooms/contracts/native-agent-id";
import { withRoleLines } from "../../src/rooms/native-agent/employee-lessons";
import { nextAction, type Phase } from "../../src/rooms/phase/logic";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";
import bundledAgents from "../../src/rooms/contracts/bundled-agents.json";

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

function guard(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const ran = spawnSync("python3", [GUARD], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

const bashPayload = (command: string, cwd: string, extra: Record<string, unknown> = {}) =>
  ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess-e1", ...extra });

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

describe("subagent tools of the lane sessions", () => {
  it("[sma:k_ag_doc_tools] a PM profile's Agent or Task tool is narrowed to (Explore, Plan), code-writing subagent names are stripped from a listed Agent(...), and a non-PM agent is left unchanged", () => {
    const narrowed = withoutCodeWritingSubagents("dev-orchestrator", ["Agent", "Task", "Read"]);
    expect(narrowed).toEqual(["Agent(Explore, Plan)", "Task(Explore, Plan)", "Read"]);
    const listed = withoutCodeWritingSubagents("dev-orchestrator", ["Agent(Explore, general-purpose, Plan, run-supervisor)"]);
    expect(listed).toEqual(["Agent(Explore, Plan)"]);
    const other = withoutCodeWritingSubagents("copy-lead", ["Agent", "Agent(general-purpose)"]);
    expect(other).toEqual(["Agent", "Agent(general-purpose)"]);
  });

  it("[sma:k_ag_lane_tools] pretaskDecision for role writer refuses a general-purpose subagent with [execution-without-agent] and lets Explore, Plan and statusline-setup through", () => {
    const refused = pretaskDecision({ role: "writer", kind: "general-purpose", background: false, spawned: 0 });
    expect(refused.deny).toContain("[execution-without-agent]");
    expect(refused.spawned).toBe(0);
    for (const kind of DOCUMENTARY_AGENTS) {
      const ok = pretaskDecision({ role: "writer", kind, background: false, spawned: 0 });
      expect(ok.deny, kind).toBeUndefined();
      expect(ok.spawned).toBe(1);
    }
  });

  it("[sma:k_ag_foreground] pretaskDecision with background true is denied with [subagent-foreground] and does not raise the spawned count; the same call in the foreground passes", () => {
    const denied = pretaskDecision({ role: "pm", kind: "Explore", background: true, spawned: 2 });
    expect(denied.deny).toContain("[subagent-foreground]");
    expect(denied.spawned).toBe(2);
    const foreground = pretaskDecision({ role: "pm", kind: "Explore", background: false, spawned: 2 });
    expect(foreground.deny).toBeUndefined();
    expect(foreground.spawned).toBe(3);
  });
});

describe("session end, turn diff and the claim release", () => {
  const setupRun = () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_host_id='h1' WHERE id='run'").run();
    return { bb, db };
  };

  it("[sma:k_h_session_end] an attempt whose writer loop is gone and that has not moved past the idle limit is taken back by the periodic pass, so its owns_paths stop holding the area", async () => {
    const { db, bb } = setupRun();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a1'").run(Date.now() - 10 * 60_000);
    const asked: string[][] = [];
    const services = {
      activeWriterTasks: new Set<string>(),
      resumeOrphans: async (_runId?: string, ids?: string[]) => { asked.push(ids ?? []); return { resumed: [], finished: [], skipped: [] }; },
    } as unknown as Services;
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false } as never;
    Object.assign(services, createStability(ctx, services));
    const { reconcileTasks } = createTaskReconcile(ctx, services);
    await reconcileTasks({ phase: "periodic", now: Date.now() });
    expect(asked).toEqual([["a1"]]);
  });

  it("[sma:k_h_turn_diff] a changed path outside owns_paths is named at the gate and a path inside is not", () => {
    const task = { owns_paths: ["src/a.ts", "src/owned/**"], never_touch: ["src/owned/secret.ts"] } as never;
    expect(findUnownedChanges(["src/a.ts", "src/stray.ts"], task)).toEqual(["src/stray.ts"]);
    expect(findUnownedChanges(["src/a.ts", "src/owned/b.ts"], task)).toEqual([]);
    expect(findUnownedChanges(["src/owned/secret.ts"], task)).toEqual(["src/owned/secret.ts"]);
  });

  it("[sma:k_htd_verdict] the attempt's base sha is compared with HEAD as two trees: both committed paths come back and findUnownedChanges names the stray one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-htd-"));
    const git = (args: string[]) => spawnSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "base.txt"), "base\n");
    git(["add", "."]); git(["commit", "-qm", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(repo, "a.ts"), "a\n");
    writeFileSync(join(repo, "b.ts"), "b\n");
    git(["add", "."]); git(["commit", "-qm", "work"]);
    const out = await gitOwnershipChangedPaths({ projectCwd: repo, baseSha, compareCommitted: true });
    expect(out.status).toBe("ready");
    expect(out.paths).toEqual(["a.ts", "b.ts"]);
    const task = { owns_paths: ["a.ts"], never_touch: [] } as never;
    expect(findUnownedChanges(out.paths, task)).toEqual(["b.ts"]);
  });

  it("[sma:k_hse_release] only live-state attempts older than the cutoff are listed", () => {
    const { db } = setupRun();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    const mk = (id: string, state: string[], updatedAt: number) => {
      createAttempt(db, { id, runId: "run", taskId: "T1" });
      for (const s of state) transitionAttempt(db, id, s);
      db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id=?").run(updatedAt, id);
    };
    const now = Date.now();
    mk("old", ["spawn_requested", "running"], now - 10 * 60_000);
    mk("new", ["spawn_requested", "running"], now - 1_000);
    createAttempt(db, { id: "done", runId: "run", taskId: "T1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id='done'").run(now - 10 * 60_000);
    expect(listUnmovedLiveAttempts(db, now - 3 * 60_000).map((row) => row.id)).toEqual(["old"]);
  });

  it("[sma:k_hse_drop] a worktree no live attempt holds is removed and its registry row released, one an open attempt holds is kept", async () => {
    const { db, bb } = setupRun();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/wt/held' WHERE id='a1'").run();
    registerWorktree(db, { host: "h1", path: "/wt/held", branch: "lane/a1", owner_kind: "attempt", owner_id: "a1" });
    registerWorktree(db, { host: "h1", path: "/wt/gone", branch: "lane/gone", owner_kind: "attempt", owner_id: "a-gone" });
    const removedCalls: string[] = [];
    const ctx = {
      bb, db, log: () => undefined, isDisposed: () => false,
      host: { call: async (method: string, input: { worktreePath?: string }) => { if (method === "gitRemoveWorktree") removedCalls.push(input.worktreePath ?? ""); return { removed: true }; } },
    } as never;
    const removed = await reconcileWorktreeRegistry(ctx);
    expect(removed).toBe(1);
    expect(removedCalls).toEqual(["/wt/gone"]);
    expect(listOpenWorktrees(db).map((row) => row.path)).toEqual(["/wt/held"]);
  });
});

describe("session hooks materialized per session", () => {
  const hookCommands = (settings: { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> }) =>
    Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));

  it("[sma:k_in_runtime] the file a hook calls exists: every command in settings.hooks names a file under the session folder that exists", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "sma-inrt-"));
    const result = await materializeNativeHookSession({ destDir });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    const commands = hookCommands(settings);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]!).filter((path) => path.startsWith(destDir));
      expect(paths.length, command).toBeGreaterThan(0);
      for (const path of paths) expect(existsSync(path), path).toBe(true);
    }
  });

  it("[sma:k_st_runtime] the hook programs the session calls are written from the bundle into the session's own hooks folder", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "sma-strt-"));
    const result = await materializeNativeHookSession({ destDir });
    for (const name of ["guard_shell.py", "inject_agent_type.py", "lib_payload.py", "session-hook.mjs"]) {
      expect(existsSync(join(destDir, "hooks", name)), name).toBe(true);
    }
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const command of hookCommands(settings)) {
      const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]!).filter((path) => path.startsWith("/"));
      for (const path of paths) expect(path.startsWith(destDir), `${command} points outside the session folder`).toBe(true);
    }
  });

  it("[sma:k_h_worker_compact] a worker's launcher copy registers the capsule verb: PreCompact runs the session's own session-hook.mjs and writes capsule.json", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "sma-caps-"));
    const home = mkdtempSync(join(tmpdir(), "sma-caps-home-"));
    const result = await materializeNativeHookSession({ destDir });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: { PreCompact?: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.PreCompact?.[0]?.hooks[0]?.command ?? "";
    const hookPath = command.match(/^node '([^']+)'$/)?.[1];
    expect(hookPath, "PreCompact hook command").toBeTruthy();
    expect(existsSync(hookPath!)).toBe(true);
    const run = spawnSync(process.execPath, [hookPath!], {
      input: JSON.stringify({ hook_event_name: "PreCompact", session_id: "w1", asks: ["keep this"] }),
      encoding: "utf8", env: { ...process.env, HOME: home },
    });
    expect(run.status).toBe(0);
    expect(readFileSync(join(home, ".lane-pilot/session-hooks/w1/capsule.json"), "utf8")).toContain("keep this");
  });

  it("[sma:k_hp_ctx] two PostToolUse calls of one session share one state dir and count 2 for the same fingerprint, another session id starts at 1", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "sma-ctx-"));
    const home = mkdtempSync(join(tmpdir(), "sma-ctx-home-"));
    const result = await materializeNativeHookSession({ destDir });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const hookPath = settings.hooks.PostToolUse[0]!.hooks[0]!.command.match(/^node '([^']+)'$/)![1]!;
    const post = (session: string) => spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: session, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "ok" }),
      encoding: "utf8", env: { ...process.env, HOME: home },
    });
    expect(post("sA").status).toBe(0);
    expect(post("sA").status).toBe(0);
    expect(post("sB").status).toBe(0);
    const stallA = JSON.parse(readFileSync(join(home, ".lane-pilot/session-hooks/sA/stall.json"), "utf8")) as Record<string, number>;
    const stallB = JSON.parse(readFileSync(join(home, ".lane-pilot/session-hooks/sB/stall.json"), "utf8")) as Record<string, number>;
    expect(Object.values(stallA)).toEqual([2]);
    expect(Object.values(stallB)).toEqual([1]);
  });
});

describe("tool gate, airbag and the dependency store", () => {
  it("[sma:k_h_tool_gate] a writer session's own settings carry the guard, git reset --hard from it is refused with a permit ticket id, and a guard fed a bad payload answers deny", async () => {
    const destDir = mkdtempSync(join(tmpdir(), "sma-gate-"));
    const home = mkdtempSync(join(tmpdir(), "sma-gate-home-"));
    const result = await materializeNativeHookSession({ destDir });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    const guardLine = settings.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) => hook.command.includes("guard_shell.py"))?.command ?? "";
    const guardPath = [...guardLine.matchAll(/'([^']+)'/g)].map((match) => match[1]!).find((path) => path.endsWith("guard_shell.py"));
    expect(guardPath && existsSync(guardPath)).toBe(true);
    const cwd = mkdtempSync(join(tmpdir(), "sma-gate-cwd-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd, env: gitEnv });
    const refused = spawnSync("python3", [guardPath!], {
      input: JSON.stringify(bashPayload("git reset --hard", cwd, { agent_type: "writer" })),
      encoding: "utf8", env: { ...process.env, HOME: home, LANE_PILOT_ROLE: "writer" },
    });
    const out = `${refused.stdout}${refused.stderr}`;
    expect(out).toContain("deny");
    expect(out).toContain("Permit ticket");
    const ticketId = out.match(/Permit ticket ([0-9a-f]{16})/)?.[1];
    expect(ticketId).toBeTruthy();
    expect(existsSync(join(home, ".agents/permits/sess-e1", `${ticketId}.ticket.json`))).toBe(true);
    const crashed = spawnSync("python3", [guardPath!], { input: "this is not json", encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(`${crashed.stdout}${crashed.stderr}`).toContain("deny");
  });

  it("[sma:k_hs_collision] a task whose owns_paths overlap a live attempt of the same checkout waits for it, a task of a sibling repository does not, and a writer's git push is refused", () => {
    expect(checkoutOwnsOverlap("/repo", ["src/**"], "/repo", ["src/a.ts"])).toBe(true);
    expect(checkoutOwnsOverlap("/repo/checkout-a", ["src/**"], "/repo/checkout-b", ["src/**"])).toBe(false);
    const denied = guard(bashPayload("git push origin main", "/repo", { agent_type: "writer" }), { LANE_PILOT_ROLE: "writer" });
    expect(denied.stdout + denied.stderr).toContain("not granted git push");
  });

  it("[sma:k_hs_gates] a convention rule warns by default and blocks only in block mode, and the finish gate maps warnings onto the card and blocks to a refused attempt", () => {
    const gate = { id: "no-console", pattern: "console\\.log", paths: ["src/**"] };
    const warn = conventionGateHits([gate], { "src/a.ts": "+console.log(1)\n" });
    expect(warn).toEqual({ warnings: ["no-console"], blocks: [] });
    const block = conventionGateHits([{ ...gate, mode: "block" as const }], { "src/a.ts": "+console.log(1)\n" });
    expect(block).toEqual({ warnings: [], blocks: ["no-console"] });
    // the finish gate's own mapping: warnings land on the card prefixed convention_gate:, a block refuses the attempt with the same prefix
    const { db } = open();
    saveProjectSetting(db as never, "p", "rules.gates", [gate, { ...gate, id: "no-debugger", pattern: "debugger", mode: "block" }]);
    const saved = db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id='p' AND key='rules.gates'").get() as { value: string };
    const hits = conventionGateHits(JSON.parse(saved.value) as never, { "src/b.ts": "+debugger\n" });
    expect(hits.blocks).toEqual(["no-debugger"]);
    expect(`convention_gate: ${hits.warnings.concat(hits.blocks).join("; ")}`).toBe("convention_gate: no-debugger");
  });

  it("[sma:k_hs_airbag] a destructive git command first saves the tree as a ref and the call is allowed with the advice, in under 1.5 s", () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-airbag-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
    spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    const started = Date.now();
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer" });
    const elapsed = Date.now() - started;
    expect(out.stderr + out.stdout).not.toContain("deny");
    expect(out.stdout).toContain("git-airbag");
    const refs = spawnSync("git", ["for-each-ref", "refs/lane-airbag/"], { cwd: repo, encoding: "utf8" }).stdout;
    expect(refs).toContain("refs/lane-airbag/");
    expect(elapsed).toBeLessThan(1500);
  });

  it("[sma:k_hs_deps] an install through a linked store and an rm into another checkout's node_modules are refused, a plain copy is not", () => {
    const a = mkdtempSync(join(tmpdir(), "sma-depa-"));
    const b = mkdtempSync(join(tmpdir(), "sma-depb-"));
    mkdirSync(join(a, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(b, "node_modules"));
    symlinkSync(join(a, "node_modules", "pkg"), join(b, "node_modules", "pkg"));
    writeFileSync(join(a, "node_modules", "pkg", "x.js"), "x\n");
    const install = guard(bashPayload("npm install left-pad", b), { LANE_PILOT_ROLE: "writer" });
    expect(install.stdout + install.stderr).toContain("dependency store");
    const rm = guard(bashPayload("rm node_modules/pkg/x.js", b), { LANE_PILOT_ROLE: "writer" });
    expect(rm.stdout + rm.stderr).toContain("dependency store");
    // Removing the link itself only drops the link — the shared store is untouched, and the install
    // refusal prescribes exactly this as the way to make the store your own.
    const unlink = guard(bashPayload("rm -rf node_modules/pkg", b), { LANE_PILOT_ROLE: "writer" });
    expect(unlink.stdout + unlink.stderr).not.toContain("deps-guard");
    const copy = guard(bashPayload("cp -r src docs", b), { LANE_PILOT_ROLE: "writer" });
    expect(copy.stdout + copy.stderr).not.toContain("deps-guard");
  });
});

describe("self-improvement, memory and protections", () => {
  const contract = (id: string, model: string) => ({
    schema_version: 2, id, title: id, risk: "low", lane: "w", project_cwd: "/w", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["x"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o",
    acceptance: ["a"], verify: "none", verification: [], forecast: { files: 2, checks_pass_first_try: true, model },
  });
  const seedScored = (db: ReturnType<typeof openDatabase>, id: string, model: string) => {
    createTask(db, { id, runId: "run1", kind: "bb", contract: contract(id, model) });
    createAttempt(db, { id: `a_${id}`, runId: "run1", taskId: id });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=1 WHERE id=?").run(`a_${id}`);
    upsertAttemptChange(db, { attemptId: `a_${id}`, runId: "run1", taskId: id }, { outcome: "merged", changed: [{ path: "src/a.ts", status: "modified" }, { path: "src/b.ts", status: "modified" }] });
  };

  it("[sma:k_hss_model] a model change hides the old passport hit rate: the new model's passport counts only its own tasks and carries no rate", async () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA");
    for (let i = 0; i < 5; i++) seedScored(db, `ta${i}`, "codex/gpt-a");
    seedScored(db, "tb0", "codex/gpt-b");
    const forB = calibrationPassport(db, "projA", "codex/gpt-b");
    expect(forB.tasks).toBe(1);
    expect(forB.badge).toBe("unrated");
    const forA = calibrationPassport(db, "projA", "codex/gpt-a");
    expect(forA.tasks).toBe(5);
    expect(forA.badge).not.toBe("unrated");
    await harness.lifecycle.dispose();
  });

  it("[sma:k_hss_stpa] a disarm past its term re-arms to the warning level and a renewed term is left alone", () => {
    const { db } = open();
    const t0 = Date.now() - 9 * 86_400_000;
    saveProjectSetting(db as never, "p", "code_critique.mode", "advisory");
    db.prepare(`UPDATE lane_pilot_project_settings SET value=? WHERE project_id='p' AND binding_id='' AND key='protection.disarm.code_critique.mode'`)
      .run(JSON.stringify({ key: "code_critique.mode", by: "owner", at: t0, until: t0 + 7 * 86_400_000 }));
    expect(rearmExpiredDisarms(db as never, "p")).toEqual(["code_critique.mode"]);
    const value = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id='p' AND key='code_critique.mode'`).get() as { value: string };
    expect(JSON.parse(value.value)).toBe("advisory");
    noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner" });
    const renewed = renewDisarm(db as never, "p", "code_critique.mode", 30, "audit still running");
    expect("record" in renewed).toBe(true);
    expect(rearmExpiredDisarms(db as never, "p")).toEqual([]);
  });

  it("[sma:k_hss_curriculum] the miss digest follows new misses with no rebuild step: 2 then 3, and a miss older than the window is absent", () => {
    const { db } = open();
    const now = Date.now();
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now - 1000);
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now - 500);
    expect(missCurriculum(db, 30, now).find((row) => row.projectId === "p")?.count).toBe(2);
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now);
    recordMemoryMiss(db, "p", "ancient miss", now - 40 * 86_400_000);
    const again = missCurriculum(db, 30, now);
    expect(again.find((row) => row.projectId === "p")?.count).toBe(3);
    expect(again.some((row) => row.query === "ancient miss")).toBe(false);
  });

  it("[sma:k_hpr_heal] a note is found by its words at once, before any vector exists", () => {
    const { db } = open();
    storeMemoryRecordsKeepingOverflow(db as never, {
      projectId: "P", audience: "subagent", sourceSha256: "a".repeat(64),
      entries: [{ kind: "note", content: "The zorblax reconciler prunes stale lease rows hourly", concepts: ["janitor"] }],
      coreBudget: 3072, noteBudget: 24000, indexBudget: 65536,
    });
    const hits = searchMemoryRecords(db as never, "P", "zorblax", 5, "auto");
    expect(hits.map((row) => row.content)).toEqual(["The zorblax reconciler prunes stale lease rows hourly"]);
  });
});

describe("collision enforcement and owner calls", () => {
  it("[sma:k_hs_enforce] a task waits for a live holder of its owns_paths and stops waiting once the holder, unmoved past the idle limit with no loop, is taken back", async () => {
    const { bb, db } = open();
    createRun(db, "run", "proj", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1' WHERE id='run'").run();
    createTask(db, { id: "holder", runId: "run", kind: "bb", contract: { owns_paths: ["src/**"], project_cwd: "/repo" } });
    createAttempt(db, { id: "a1", runId: "run", taskId: "holder" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    // A live holder is not an orphan: nothing lists it for take-back, and the overlap still blocks the waiter.
    expect(listUnmovedLiveAttempts(db, Date.now() - 3 * 60_000)).toEqual([]);
    expect(checkoutOwnsOverlap("/repo", ["src/page.ts"], "/repo", ["src/**"])).toBe(true);
    // The loop dies: the attempt stops moving and the periodic pass takes it back through resumeOrphans.
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a1'").run(Date.now() - 10 * 60_000);
    expect(listUnmovedLiveAttempts(db, Date.now() - 3 * 60_000).map((row) => row.id)).toEqual(["a1"]);
    const asked: string[][] = [];
    const services = {
      activeWriterTasks: new Set<string>(),
      resumeOrphans: async (_runId?: string, ids?: string[]) => {
        asked.push(ids ?? []);
        for (const id of ids ?? []) db.prepare("UPDATE lane_pilot_attempt SET state='canceled' WHERE id=?").run(id);
        return { resumed: [], finished: ids ?? [], skipped: [] };
      },
    } as unknown as Services;
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false } as never;
    Object.assign(services, createStability(ctx, services));
    const { reconcileTasks } = createTaskReconcile(ctx, services);
    await reconcileTasks({ phase: "periodic", now: Date.now() });
    expect(asked).toEqual([["a1"]]);
    expect(getAttempt(db, "a1")?.state).toBe("canceled");
    expect(listUnmovedLiveAttempts(db, Date.now() - 3 * 60_000)).toEqual([]);
  });

  it("[sma:m_cf_hard_calls] the PM session text lists money, deleting and access as owner calls; the phase driver waits for the owner word before issue; the guard denies git push, tag and gh release for a writer", () => {
    expect(LANE_PILOT_PM_SESSION).toMatch(/money/);
    expect(LANE_PILOT_PM_SESSION).toMatch(/deleting/);
    expect(LANE_PILOT_PM_SESSION).toMatch(/access/);
    const phase = {
      id: "ph1", stage: "execution",
      record: { ownerWords: true, plan: { items: [], sha: "plan" }, execution: { issued: {} }, words: [] },
    } as unknown as Phase;
    const action = nextAction(phase, new Map());
    expect(action.key).toBe("execution:word:issue");
    expect(action.text).toContain("owner");
    for (const command of ["git push origin main", "git tag v1.0", "gh release create v1.0"]) {
      const denied = guard(bashPayload(command, "/repo", { agent_type: "writer" }), { LANE_PILOT_ROLE: "writer" });
      expect(denied.stdout + denied.stderr, command).toContain("deny");
    }
  });
});

describe("install, roles and carried lines", () => {
  it("[sma:m_up_downgrade] placeLanePilotGuard leaves an installed guard that differs from the bundled one untouched", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-dg-"));
    const dest = ownedPmGuardPath(home);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "# a newer guard, not the bundled one\n");
    await placeLanePilotGuard(home);
    expect(readFileSync(dest, "utf8")).toBe("# a newer guard, not the bundled one\n");
    const absent = mkdtempSync(join(tmpdir(), "sma-dg2-"));
    await placeLanePilotGuard(absent);
    expect(readFileSync(ownedPmGuardPath(absent), "utf8")).toContain("guard");
  });

  it("[sma:k_in_agents] every bundled role becomes a definition: description, prompt and only CLI_AGENT_DEFINITION_FIELDS keys", () => {
    for (const id of Object.keys(bundledAgents)) {
      const compiled = compileMainAgentProfile(id);
      const json = sessionOverrideAgentsJson({ agentId: id, edited: false, compiled });
      expect(json, id).not.toBeNull();
      const parsed = JSON.parse(json!) as Record<string, Record<string, unknown>>;
      const definition = parsed[nativeAgentCliId(id)];
      expect(definition, id).toBeTruthy();
      expect(String(definition.description).length).toBeGreaterThan(0);
      expect(String(definition.prompt).length).toBeGreaterThan(0);
      for (const key of Object.keys(definition)) expect(CLI_AGENT_DEFINITION_FIELDS).toContain(key);
    }
  });

  it("[sma:k_st_agents] with a project .claude/agents/mine.md present, building a session's agents JSON returns only that role's definition and writes nothing into .claude/agents", () => {
    const project = mkdtempSync(join(tmpdir(), "sma-stag-"));
    mkdirSync(join(project, ".claude/agents"), { recursive: true });
    writeFileSync(join(project, ".claude/agents/mine.md"), "---\nname: mine\n---\nmy own role\n");
    const compiled = compileMainAgentProfile("dev-orchestrator");
    const json = sessionOverrideAgentsJson({ agentId: "dev-orchestrator", edited: false, compiled })!;
    expect(Object.keys(JSON.parse(json))).toEqual(["dev-orchestrator"]);
    expect(readFileSync(join(project, ".claude/agents/mine.md"), "utf8")).toBe("---\nname: mine\n---\nmy own role\n");
    expect(readdirSync(join(project, ".claude/agents"))).toEqual(["mine.md"]);
  });

  it("[sma:k_in_carry] role lines follow a new role text: the same dated lines land in both results; an empty list returns the compiled profile unchanged", () => {
    const a = compileMainAgentProfile("dev-orchestrator");
    const b = compileMainAgentProfile("copy-lead");
    const lines = ["2026-11-01: never touch the lock file", "2026-11-03: keep the diff under 200 lines"];
    for (const compiled of [a, b]) {
      const withLines = withRoleLines(compiled, lines);
      for (const line of lines) expect(withLines.prompt).toContain(line);
      expect(withLines.prompt.startsWith(compiled.prompt)).toBe(true);
    }
    expect(withRoleLines(a, [])).toBe(a);
  });
});
