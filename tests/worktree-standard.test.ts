// The worktree standard (docs/worktrees.md, SMA 4г) on real temp repositories: where a worktree is made, what the merge removes, what a
// cancel keeps, and what the daily cleanup pass deletes, keeps and reports per class. Every result is read from git and the disk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { sweepWorktreeClasses } from "../src/rooms/verification/worktree-sweep";
import { integrateWorktree, removeLaneWorktree } from "../src/rooms/verification/git-integrate";
import { deleteBranchIfMerged, laneWorktreeTarget, mergedAnywhere, repoFolderName } from "../src/rooms/verification/git-integrate/worktree-layout";
import { sweepLaneWorktrees } from "../src/rooms/verification/worktree-janitor";
import { gitCreateWorktree, gitRemoveWorktree, worktreeJanitor } from "../src/rooms/host-worker/host-handlers";
import { CLEANUP_ITEM_PREFIX, dailyPassInputs, runDailyWorktreePass } from "../src/rooms/stability/server/worktree-daily-pass";
import { registerWorktree } from "../src/rooms/storage";
import { SYSTEM_SCHEDULES, ensureSystemSchedules } from "../src/rooms/schedule/server/system-schedules";
import { normalizeSchedule } from "../src/rooms/schedule/model";

vi.setConfig({ testTimeout: 120_000 });

const DAY = 86_400_000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const branches = (base: string, pattern: string) => git(base, "branch", "--list", pattern).trim();
const listed = (base: string) => git(base, "worktree", "list", "--porcelain");

/** A project folder with one repository `app` on main, and Lane Pilot's root beside it (as `$HOME/.lane-pilot/worktrees`). */
async function project() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lp-wt-standard-")));
  const base = join(dir, "projects", "app");
  mkdirSync(base, { recursive: true });
  git(base, "init", "-q", "-b", "main");
  git(base, "config", "user.email", "t@t");
  git(base, "config", "user.name", "t");
  writeFileSync(join(base, "a.txt"), "a\n");
  git(base, "add", ".");
  git(base, "commit", "-qm", "init");
  const laneRoot = join(dir, ".lane-pilot", "worktrees");
  mkdirSync(laneRoot, { recursive: true });
  const add = (path: string, branch: string) => { git(base, "worktree", "add", "-q", "-b", branch, path, "HEAD"); return path; };
  const commit = (path: string, file: string, text = `${file}\n`) => { writeFileSync(join(path, file), text); git(path, "add", "."); git(path, "commit", "-qm", file); return git(path, "rev-parse", "HEAD").trim(); };
  const sweep = (over: Partial<Parameters<typeof sweepWorktreeClasses>[0]> = {}) => sweepWorktreeClasses({
    laneRoot, folders: [join(dir, "projects")], protectedPaths: new Set(), maxAgeMs: 7 * DAY, youngMs: DAY, now: Date.now() + 8 * DAY, ...over,
  });
  return { dir, base, laneRoot, add, commit, sweep };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("worktree layout", () => {
  it("[sma:dt_wt_sweep] a new worktree is made at <root>/<repository>/<id>, outside the repository", async () => {
    const { dir, base, laneRoot } = await project();
    vi.stubEnv("LANE_PILOT_WORKTREE_ROOT", laneRoot);
    const made = await gitCreateWorktree({ requestedHostId: "h1", basePath: base, name: "lpattempt_new1" }, {} as never);
    expect(made.status).toBe("ready");
    expect(made.path).toBe(join(laneRoot, "app", "lpattempt_new1"));
    expect(made.branch).toBe("lane/lpattempt_new1");
    expect(listed(base)).toContain(`worktree ${join(laneRoot, "app", "lpattempt_new1")}`);
    // A chat folder nested in the repository files its worktree under the repository's name, not the folder's.
    mkdirSync(join(base, "packages", "web"), { recursive: true });
    writeFileSync(join(base, "packages", "web", "x.txt"), "x");
    git(base, "add", "."); git(base, "commit", "-qm", "web");
    const nested = await gitCreateWorktree({ requestedHostId: "h1", basePath: join(base, "packages", "web"), name: "lpattempt_new2" }, {} as never);
    expect(nested.path?.startsWith(join(laneRoot, "app", "lpattempt_new2"))).toBe(true);
    expect(nested.path?.startsWith(base)).toBe(false);
    expect(laneWorktreeTarget("/r", "/x/.hidden", "id")).toBe("/r/_hidden/id");
    expect(repoFolderName(`${dir}/projects/app/`)).toBe("app");
  });

  it("[sma:dt_wt_sweep] an old-layout copy <root>/<id>/<repository> is still found and cleaned with its folder", async () => {
    const { base, laneRoot, add, commit, sweep } = await project();
    const old = add(join(laneRoot, "lpattempt_old1", "app"), "lane/lpattempt_old1");
    commit(old, "old.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "merge old", "lane/lpattempt_old1");
    const out = await sweep();
    expect(out.removed.map((row) => [row.path, row.cls, row.how])).toEqual([[old, "lane", "ancestor"]]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(laneRoot, "lpattempt_old1"))).toBe(false);
    expect(branches(base, "lane/lpattempt_old1")).toBe("");
    // The hourly sweep reads both layouts too: a new-layout copy squash-merged into main goes (before 0.1.561 it stayed for good).
    const fresh = add(join(laneRoot, "app", "lpattempt_new3"), "lane/lpattempt_new3");
    commit(fresh, "fresh.txt");
    git(base, "merge", "-q", "--squash", "lane/lpattempt_new3"); git(base, "commit", "-qm", "squash new3");
    const hourly = await sweepLaneWorktrees({ root: laneRoot, protectedPaths: new Set(), graceMs: 0, tmpPrefixes: [] });
    expect(hourly.removed).toEqual([fresh]);
    expect(branches(base, "lane/lpattempt_new3")).toBe("");
  });
});

describe("the merge removes what it merged", () => {
  it("[sma:ta_cleanup] integrateWorktree of an attempt that ran in a BB environment removes its worktree and branch", async () => {
    const { dir, base, add } = await project();
    const env = add(join(dir, "bb-envs", "env1"), "bb/lpattempt_env1");
    writeFileSync(join(env, "feature.ts"), "export const f = 1;\n");
    const out = await integrateWorktree({ basePath: base, worktreePath: env, message: "env attempt", removeWorktree: true });
    expect(out.status).toBe("merged");
    expect(out.worktreeRemoved).toBe(true);
    expect(existsSync(env)).toBe(false);
    expect(listed(base)).not.toContain(env);
    expect(branches(base, "bb/lpattempt_env1")).toBe("");
    expect(git(base, "show", "HEAD:feature.ts")).toContain("export const f");
  });

  it("[sma:ta_cleanup] the merge leaves a worktree on any other branch (a chat's own checkout an attempt reused)", async () => {
    const { dir, base, add } = await project();
    const chat = add(join(dir, "chat-copy"), "feature/chat");
    writeFileSync(join(chat, "c.ts"), "c\n");
    const out = await integrateWorktree({ basePath: base, worktreePath: chat, message: "chat", removeWorktree: true });
    expect(out.status).toBe("merged");
    expect(out.worktreeRemoved).toBe(false);
    expect(existsSync(chat)).toBe(true);
    expect(branches(base, "feature/chat")).not.toBe("");
  });
});

describe("cancel keeps unmerged work", () => {
  it("[sma:m_sweep_worker_copies] removing a cancelled attempt's worktree keeps a branch with unmerged commits and names it", async () => {
    const { base, laneRoot, add, commit } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_cx"), "lane/lpattempt_cx");
    commit(top, "work.txt");
    const out = await gitRemoveWorktree({ requestedHostId: "h1", basePath: base, worktreePath: top }, {} as never);
    expect(out.removed).toBe(true);
    expect(existsSync(top)).toBe(false);
    expect(branches(base, "lane/lpattempt_cx")).toContain("lane/lpattempt_cx");
    expect(out.branchKept).toMatchObject({ branch: "lane/lpattempt_cx", ahead: 1 });
  });

  it("[sma:m_sweep_worker_copies] a cancelled attempt whose work is in main (cherry-picked) loses its branch with the worktree", async () => {
    const { base, laneRoot, add, commit } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_cy"), "lane/lpattempt_cy");
    const sha = commit(top, "picked.txt");
    commit(base, "main-moved.txt");
    git(base, "cherry-pick", sha);
    const out = await removeLaneWorktree({ basePath: base, worktreePath: top });
    expect(out).toEqual({ removed: true });
    expect(branches(base, "lane/lpattempt_cy")).toBe("");
  });

  it("deleteBranchIfMerged sees ancestry, patch and squash equivalence, and refuses what is merged nowhere", async () => {
    const { base, add, commit, dir } = await project();
    const a = add(join(dir, "w", "a"), "lane/a"); commit(a, "a1.txt"); commit(a, "a2.txt");
    git(base, "merge", "-q", "--squash", "lane/a"); git(base, "commit", "-qm", "squash a");
    const b = add(join(dir, "w", "b"), "lane/b"); commit(b, "b1.txt");
    git(base, "worktree", "remove", "--force", a); git(base, "worktree", "remove", "--force", b);
    expect(await mergedAnywhere(base, "lane/a")).toEqual({ target: "main", how: "squash" });
    expect(await mergedAnywhere(base, "lane/b")).toBeNull();
    expect((await deleteBranchIfMerged(base, "lane/a")).deleted).toBe(true);
    const kept = await deleteBranchIfMerged(base, "lane/b");
    expect(kept).toMatchObject({ deleted: false, ahead: 1 });
    expect(branches(base, "lane/b")).toContain("lane/b");
  });
});

describe("the daily cleanup pass on one machine", () => {
  it("[sma:dt_wt_sweep] a merged copy (squash or cherry-pick) older than N days goes with its branch, and the freed space is counted", async () => {
    const { base, laneRoot, add, commit, sweep } = await project();
    const sq = add(join(laneRoot, "app", "lpattempt_sq"), "lane/lpattempt_sq");
    commit(sq, "sq1.txt"); commit(sq, "sq2.txt");
    writeFileSync(join(sq, "big.bin"), Buffer.alloc(256 * 1024, 1));
    git(sq, "add", "."); git(sq, "commit", "-qm", "big");
    git(base, "merge", "-q", "--squash", "lane/lpattempt_sq"); git(base, "commit", "-qm", "squash sq");
    const cp = add(join(laneRoot, "app", "lpattempt_cp"), "lane/lpattempt_cp");
    const picked = commit(cp, "cp.txt");
    commit(base, "main-moved.txt");
    git(base, "cherry-pick", picked);
    const out = await sweep();
    expect(out.removed.map((row) => [row.path, row.how, row.branchDeleted]).sort()).toEqual([[cp, "patch-equivalent", true], [sq, "squash", true]].sort());
    expect(existsSync(sq) || existsSync(cp)).toBe(false);
    expect(branches(base, "lane/lpattempt_*")).toBe("");
    expect(out.freedBytes).toBeGreaterThan(256 * 1024);
    // The same copy younger than N days stays (only counted, not reported).
    const young = add(join(laneRoot, "app", "lpattempt_recent"), "lane/lpattempt_recent");
    const recent = await sweep({ now: Date.now() + 2 * DAY });
    expect(recent.kept.find((row) => row.path === young)?.reason).toBe("recent");
    expect(existsSync(young)).toBe(true);
  });

  it("[sma:dt_wt_sweep] an abandoned copy (cancelled task, clean, nothing unmerged) goes before N days", async () => {
    const { base, laneRoot, add, sweep } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_ab"), "lane/lpattempt_ab");
    const out = await sweep({ now: Date.now() + 2 * DAY, abandonedPaths: new Set([top]) });
    expect(out.removed.map((row) => row.path)).toEqual([top]);
    expect(existsSync(top)).toBe(false);
    expect(branches(base, "lane/lpattempt_ab")).toBe("");
  });

  it("[sma:dt_wt_sweep] an abandoned copy with unmerged commits loses its clean folder but keeps its branch, and the report names it", async () => {
    const { base, laneRoot, add, commit, sweep } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_ab2"), "lane/lpattempt_ab2");
    commit(top, "unmerged.txt");
    const out = await sweep({ now: Date.now() + 2 * DAY, abandonedPaths: new Set([top]) });
    expect(out.removed.map((row) => [row.path, row.why, row.branchDeleted])).toEqual([[top, "abandoned", false]]);
    expect(branches(base, "lane/lpattempt_ab2")).toContain("lane/lpattempt_ab2");
    expect(out.branchesKept).toEqual([expect.objectContaining({ branch: "lane/lpattempt_ab2", ahead: 1 })]);
  });

  it("[sma:dt_wt_sweep] a copy with an unmerged commit older than N days stays and is in the report", async () => {
    const { base, laneRoot, add, commit, sweep } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_un"), "lane/lpattempt_un");
    commit(top, "mine.txt");
    const out = await sweep();
    expect(out.removed).toEqual([]);
    expect(out.kept).toEqual([expect.objectContaining({ path: top, reason: "unmerged", cls: "lane" })]);
    expect(out.kept[0]!.detail).toContain("1 commit(s)");
    expect(existsSync(top)).toBe(true);
    expect(branches(base, "lane/lpattempt_un")).not.toBe("");
  });

  it("[sma:dt_wt_sweep] a dirty copy, a young copy and a copy live work holds stay", async () => {
    const { laneRoot, add, sweep } = await project();
    const dirty = add(join(laneRoot, "app", "lpattempt_dirty"), "lane/lpattempt_dirty");
    writeFileSync(join(dirty, "a.txt"), "edited\n");
    const untracked = add(join(laneRoot, "app", "lpattempt_new"), "lane/lpattempt_new");
    writeFileSync(join(untracked, "draft.md"), "draft\n");
    const held = add(join(laneRoot, "app", "lpattempt_held"), "lane/lpattempt_held");
    const old = await sweep({ protectedPaths: new Set([held]) });
    expect(old.removed).toEqual([]);
    expect(Object.fromEntries(old.kept.map((row) => [row.path, row.reason]))).toEqual({ [dirty]: "dirty", [untracked]: "dirty", [held]: "protected" });
    const young = await sweep({ now: Date.now() });
    expect(young.removed).toEqual([]);
    expect(young.kept.filter((row) => row.reason === "young").length).toBe(3);
    expect([dirty, untracked, held].every((path) => existsSync(path))).toBe(true);
  });

  it("[sma:dt_wt_sweep] a prunable entry (folder gone) is pruned, and a registry path whose folder is gone is named", async () => {
    const { base, laneRoot, add, sweep } = await project();
    const gone = add(join(laneRoot, "app", "lpattempt_gone"), "lane/lpattempt_gone");
    await rm(gone, { recursive: true, force: true });
    expect(listed(base)).toContain("prunable");
    const out = await sweep({ registryPaths: [gone] });
    expect(out.pruned).toBe(1);
    expect(listed(base)).not.toContain(gone);
    expect(out.registryGone).toEqual([gone]);
    const dry = await sweep({ dryRun: true });
    expect(dry.pruned).toBe(0);
  });

  it("[sma:dt_wt_sweep] a Claude Code subagent copy in .claude/worktrees is swept by the same rules; a BB environment is left to BB; other worktrees are not touched", async () => {
    const { dir, base, laneRoot, add, commit, sweep } = await project();
    const agent = add(join(base, ".claude", "worktrees", "agent-1"), "worktree-agent-1");
    git(base, "merge", "-q", "--squash", "worktree-agent-1"); // nothing to squash: the branch is main's tip
    const agentDirty = add(join(base, ".claude", "worktrees", "agent-2"), "worktree-agent-2");
    commit(agentDirty, "agent2.txt");
    const dot = add(join(base, ".worktrees", "feature"), "feature-x");
    const env = add(join(dir, "bb-envs", "env9"), "bb/lpattempt_env9");
    commit(env, "env.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "env9", "bb/lpattempt_env9");
    const release = add(join(dir, "release-copy"), "release/1.0");
    // A BB environment the hub names without BB's id (an older hub) is BB's to remove: kept, folder and branch stay.
    const out = await sweep({ folders: [base], bbEnvPaths: [env] });
    const removed = Object.fromEntries(out.removed.map((row) => [row.path, row.cls]));
    expect(removed).toEqual({ [agent]: "claude", [dot]: "dot-worktrees" });
    expect(out.kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: agentDirty, cls: "claude", reason: "unmerged" }),
      expect.objectContaining({ path: env, cls: "bb-env", reason: "no-environment-id" }),
    ]));
    expect(out.kept).toHaveLength(2);
    expect(branches(base, "worktree-agent-1") + branches(base, "feature-x")).toBe("");
    expect(existsSync(env)).toBe(true);
    expect(existsSync(release)).toBe(true);
    expect(out.decisions.find((row) => row.path === release)).toMatchObject({ cls: "outside", decision: "skip", reason: "outside" });
    expect(existsSync(join(laneRoot))).toBe(true);
  });

  it("[sma:dt_wt_sweep] an old-layout phase candidate in .git/lp-phases is swept once its branch is merged", async () => {
    const { base, add, commit, sweep } = await project();
    const phase = add(join(base, ".git", "lp-phases", "ph_1"), "phase/ph_1");
    commit(phase, "phase.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "phase", "phase/ph_1");
    const out = await sweep({ folders: [base] });
    expect(out.removed).toEqual([expect.objectContaining({ path: phase, cls: "lp-phases", branchDeleted: true })]);
    expect(branches(base, "phase/ph_1")).toBe("");
  });

  it("a dry run decides and reports without removing anything", async () => {
    const { base, laneRoot, add, sweep } = await project();
    const top = add(join(laneRoot, "app", "lpattempt_dry"), "lane/lpattempt_dry");
    const out = await sweep({ dryRun: true });
    expect(out.removed.map((row) => row.path)).toEqual([top]);
    expect(out.dryRun).toBe(true);
    expect(existsSync(top)).toBe(true);
    expect(branches(base, "lane/lpattempt_dry")).not.toBe("");
  });
});

describe("the daily cleanup pass from the hub", () => {
  /** A hub with one connected machine whose host handlers are the real ones, on $HOME = the fixture. */
  async function hub(dir: string, base: string) {
    vi.stubEnv("HOME", dir);
    const fake = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(fake);
    const bb = Object.assign(Object.create(Object.getPrototypeOf(fake)), fake, { sdk: { hosts: { list: async () => [{ id: "h1", name: "Machine", status: "connected" }] } } });
    const t0 = Date.now() - 30 * DAY;
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,writer_workspace_path,writer_host_id) VALUES ('run1','p1','running',?,?,?, 'h1')").run(t0, Date.now(), base);
    const handlers: Record<string, (input: never) => unknown> = {
      worktreeJanitor: (input) => worktreeJanitor(input, {} as never),
      gitRemoveWorktree: (input) => gitRemoveWorktree(input, {} as never),
      removeWorkerHome: async () => ({ removed: false }),
    };
    const logs: string[] = [];
    const ctx = { bb, db, log: (line: string) => logs.push(line), isDisposed: () => false,
      host: { call: async (method: string, input: never) => { const handler = handlers[method]; if (!handler) throw new Error(`no ${method} in the test`); return await handler(input); } } } as never;
    return { db, ctx, logs };
  }

  it("[sma:dt_wt_sweep] deletes merged and cancelled copies, closes their registry rows, keeps unmerged ones and reports once", async () => {
    const { dir, base, add, commit } = await project();
    const laneRoot = join(dir, ".lane-pilot", "worktrees");
    const merged = add(join(laneRoot, "app", "lpattempt_m1"), "lane/lpattempt_m1");
    commit(merged, "m1.txt");
    git(base, "merge", "-q", "--squash", "lane/lpattempt_m1"); git(base, "commit", "-qm", "squash m1");
    const cancelled = add(join(laneRoot, "app", "lpattempt_c1"), "lane/lpattempt_c1");
    const unmerged = add(join(laneRoot, "app", "lpattempt_u1"), "lane/lpattempt_u1");
    commit(unmerged, "u1.txt");
    const gone = join(laneRoot, "app", "lpattempt_gone");
    const { db, ctx } = await hub(dir, base);
    const old = Date.now() - 20 * DAY;
    // A cancelled attempt's copy; a registry row whose folder is gone (19 such rows on OVH, audit 2026-11-14).
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,workspace_path) VALUES ('lpattempt_c1','run1','t1','canceled',?,?,?)").run(old, old, cancelled);
    registerWorktree(db, { host: "h1", path: gone, branch: "lane/lpattempt_gone", owner_kind: "attempt", owner_id: "lpattempt_gone_owner" }, old);
    const inputs = await dailyPassInputs(ctx, Date.now());
    expect([...inputs.abandoned.get("h1") ?? []]).toEqual([cancelled]);
    expect([...inputs.folders.get("h1") ?? []]).toEqual([base]);
    // Seven days of age are counted from the folders' clocks: pretend the pass runs eight days from now.
    const now = Date.now() + 8 * DAY;
    const out = await runDailyWorktreePass(ctx, now);
    expect(out.status).toBe("ok");
    expect(existsSync(merged) || existsSync(cancelled)).toBe(false);
    expect(existsSync(unmerged)).toBe(true);
    expect(branches(base, "lane/lpattempt_m1") + branches(base, "lane/lpattempt_c1")).toBe("");
    expect(branches(base, "lane/lpattempt_u1")).not.toBe("");
    expect((db.prepare("SELECT released_at FROM lane_pilot_worktree WHERE path=?").get(gone) as { released_at: number | null }).released_at).not.toBeNull();
    const rows = db.prepare("SELECT pass, removed, freed_bytes, kept_unmerged, report_json FROM lane_pilot_janitor WHERE pass='daily'").all() as Array<{ pass: string; removed: number; freed_bytes: number; kept_unmerged: number; report_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.removed).toBeGreaterThanOrEqual(2);
    expect(rows[0]!.freed_bytes).toBeGreaterThan(0);
    expect(rows[0]!.kept_unmerged).toBe(1);
    expect(JSON.parse(rows[0]!.report_json).classes.lane.removed).toBeGreaterThanOrEqual(2);
    expect(out.report).toContain(unmerged);
    const items = () => db.prepare("SELECT key, state FROM lane_pilot_owner_item WHERE key LIKE ?").all(`${CLEANUP_ITEM_PREFIX}%`) as Array<{ key: string; state: string }>;
    expect(items().filter((row) => row.state === "open")).toHaveLength(1);
    // The next day keeps the same list: no new owner line.
    await runDailyWorktreePass(ctx, now + DAY);
    expect(items()).toHaveLength(1);
    // The owner merges the kept work: the list empties and the line closes.
    git(base, "merge", "-q", "--no-ff", "-m", "u1", "lane/lpattempt_u1");
    await runDailyWorktreePass(ctx, now + 2 * DAY);
    expect(existsSync(unmerged)).toBe(false);
    expect(items().filter((row) => row.state === "open")).toHaveLength(0);
  });

  it("[sma:dt_wt_sweep] a dry run of the hub pass writes no janitor row and removes nothing", async () => {
    const { dir, base, add } = await project();
    const top = add(join(dir, ".lane-pilot", "worktrees", "app", "lpattempt_d1"), "lane/lpattempt_d1");
    const { db, ctx } = await hub(dir, base);
    const out = await runDailyWorktreePass(ctx, Date.now() + 8 * DAY, { dryRun: true });
    expect(out.removed).toBe(1);
    expect(out.report).toContain("Пробный проход");
    expect(existsSync(top)).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_janitor").get() as { n: number }).n).toBe(0);
  });
});

describe("the cleanup is on the schedule board", () => {
  it("[sma:m_boot_wt_sweep] makes the hourly and the daily system schedules once, and not again after the owner deleted one", async () => {
    for (const item of SYSTEM_SCHEDULES) expect(normalizeSchedule({ ...item.definition, projectId: "*" }, Date.now(), "UTC").ok).toBe(true);
    const rows: Array<{ id: string; created_by: string }> = [];
    const kv = new Map<string, unknown>();
    const deps = {
      list: () => rows,
      save: async (raw: unknown, by: string) => { const id = `sch_${rows.length}`; rows.push({ id, created_by: by }); expect((raw as { projectId: string }).projectId).toBe("*"); return { ok: true as const, schedule: { id } }; },
      kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } },
      log: () => undefined,
    };
    expect(await ensureSystemSchedules(deps)).toEqual(["worktree-cleanup-hourly", "worktree-cleanup-daily"]);
    expect(await ensureSystemSchedules(deps)).toEqual([]);
    rows.splice(1, 1);
    expect(await ensureSystemSchedules(deps)).toEqual([]);
    expect(rows.map((row) => row.created_by)).toEqual(["system:worktree-cleanup-hourly"]);
  });
});
