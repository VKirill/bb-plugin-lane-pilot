// The daily pass's coverage (docs/worktrees.md) on real temp repositories: one decision per linked worktree with its class and reason, the
// bounded home search (finds a repository the hub does not know, stays out of node_modules and below its depth), the copies outside the
// managed classes (listed, never removed, even merged and detached), and BB environments (BB removes them; a live thread keeps them).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { searchRepos, sweepWorktreeClasses } from "../src/rooms/verification/worktree-sweep";
import { worktreeJanitor } from "../src/rooms/host-worker/host-handlers";
import { OUTSIDE_ITEM_PREFIX, runDailyWorktreePass, runWorktreeCleanupCli } from "../src/rooms/stability/server/worktree-daily-pass";

vi.setConfig({ testTimeout: 120_000 });

const DAY = 86_400_000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

/** A repository on main at `path` with one commit. */
function repo(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "config", "user.email", "t@t");
  git(path, "config", "user.name", "t");
  writeFileSync(join(path, "a.txt"), "a\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return path;
}

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lp-wt-coverage-")));
  const base = repo(join(dir, "projects", "app"));
  const laneRoot = join(dir, ".lane-pilot", "worktrees");
  mkdirSync(laneRoot, { recursive: true });
  const add = (from: string, path: string, branch: string | null) => {
    git(from, "worktree", "add", "-q", ...(branch ? ["-b", branch, path] : ["--detach", path]), "HEAD");
    return path;
  };
  const commit = (path: string, file: string) => { writeFileSync(join(path, file), `${file}\n`); git(path, "add", "."); git(path, "commit", "-qm", file); };
  const sweep = (over: Partial<Parameters<typeof sweepWorktreeClasses>[0]> = {}) => sweepWorktreeClasses({
    laneRoot, folders: [base], protectedPaths: new Set(), maxAgeMs: 7 * DAY, youngMs: DAY, now: Date.now() + 8 * DAY, ...over,
  });
  return { dir, base, laneRoot, add, commit, sweep };
}

const decisionsOf = (out: Awaited<ReturnType<typeof sweepWorktreeClasses>>) => Object.fromEntries(out.decisions.map((row) => [row.path, [row.cls, row.decision, row.reason]]));

afterEach(() => { vi.unstubAllEnvs(); });

describe("the daily pass names every decision", () => {
  it("[sma:dt_wt_sweep] each linked worktree has one decision with its class, reason and facts; a real pass removes exactly the `remove` ones", async () => {
    const { base, laneRoot, add, commit, sweep } = await fixture();
    const merged = add(base, join(laneRoot, "app", "lpattempt_m"), "lane/lpattempt_m");
    commit(merged, "m.txt"); commit(merged, "m2.txt"); // two commits: one squash commit in main, no patch-equivalent pair
    git(base, "merge", "-q", "--squash", "lane/lpattempt_m"); git(base, "commit", "-qm", "squash m");
    const dirty = add(base, join(base, ".claude", "worktrees", "agent-dirty"), "worktree-agent-dirty");
    writeFileSync(join(dirty, "draft.txt"), "draft\n");
    const unmerged = add(base, join(base, ".worktrees", "unmerged"), "feature-unmerged");
    commit(unmerged, "u.txt");
    const phase = add(base, join(base, ".git", "lp-phases", "ph_1"), "phase/ph_1");
    const held = add(base, join(base, ".worktrees", "held"), "feature-held");

    const out = await sweep({ dryRun: true, protectedPaths: new Set([held]) });
    expect(decisionsOf(out)).toEqual({
      [merged]: ["lane", "remove", "merged"],
      [dirty]: ["claude", "keep", "dirty"],
      [unmerged]: ["dot-worktrees", "keep", "unmerged"],
      [phase]: ["lp-phases", "remove", "merged"],
      [held]: ["dot-worktrees", "keep", "protected"],
    });
    const byPath = Object.fromEntries(out.decisions.map((row) => [row.path, row]));
    expect(byPath[merged]).toMatchObject({ repo: base, merged: "squash", dirty: 0, via: "git", branch: "lane/lpattempt_m" });
    expect(byPath[merged]!.detail).toMatch(/merged \(squash\), clean, untouched for \d+ day\(s\); its branch goes/u);
    expect(byPath[dirty]).toMatchObject({ dirty: 1 });
    expect(byPath[unmerged]).toMatchObject({ unmerged: 1 });
    expect(byPath[unmerged]!.detail).toContain("1 commit(s) merged into none of main");

    // Three days on, a merged copy is «recent»; today, everything is «young».
    expect(decisionsOf(await sweep({ dryRun: true, now: Date.now() + 3 * DAY }))[phase]).toEqual(["lp-phases", "keep", "recent"]);
    expect(new Set(Object.values(decisionsOf(await sweep({ dryRun: true, now: Date.now() }))).map((row) => row[2]))).toEqual(new Set(["young"]));

    const real = await sweep({ protectedPaths: new Set([held]) });
    expect(real.removed.map((row) => row.path).sort()).toEqual([merged, phase].sort());
    expect(existsSync(merged) || existsSync(phase)).toBe(false);
    expect(existsSync(dirty) && existsSync(unmerged) && existsSync(held)).toBe(true);
  });
});

describe("the bounded search", () => {
  it("[sma:dt_wt_sweep] finds a .worktrees copy of a repository the hub does not know, stays out of node_modules, below its depth and off a .git folder without HEAD", async () => {
    const { dir, add, sweep } = await fixture();
    const unknown = repo(join(dir, "tools", "lane-stack"));
    const found = add(unknown, join(unknown, ".worktrees", "night-1"), "night-1");
    const dep = repo(join(dir, "site", "node_modules", "pkg"));
    const inDeps = add(dep, join(dep, ".worktrees", "x"), "x");
    const deep = repo(join(dir, "l1", "l2", "l3", "l4", "l5", "l6", "deep"));
    const tooDeep = add(deep, join(deep, ".worktrees", "z"), "z");
    mkdirSync(join(dir, "fake", ".git"), { recursive: true });
    writeFileSync(join(dir, "fake", ".git", "tool-id"), "x");

    const search = await searchRepos([dir], { maxDepth: 5 });
    expect(search.repos).toContain(unknown);
    expect(search.repos).not.toContain(dep);
    expect(search.repos).not.toContain(deep);
    expect(search.repos).not.toContain(join(dir, "fake"));
    expect(search.truncated).toBe(false);

    const out = await sweep({ folders: [], search: { roots: [dir], maxDepth: 5 } });
    expect(out.search).toMatchObject({ roots: [dir], maxDepth: 5, truncated: false });
    expect(out.errors).toEqual([]);
    expect(decisionsOf(out)[found]).toEqual(["dot-worktrees", "remove", "merged"]);
    expect(out.decisions.map((row) => row.path)).not.toContain(inDeps);
    expect(out.decisions.map((row) => row.path)).not.toContain(tooDeep);
    expect(existsSync(found)).toBe(false);
    expect(existsSync(inDeps) && existsSync(tooDeep)).toBe(true);
    // A search that runs out of room says so.
    expect((await searchRepos([dir], { maxDepth: 5, maxRepos: 1 })).truncated).toBe(true);
  });
});

describe("copies outside the managed classes", () => {
  it("[sma:dt_wt_sweep] a detached merged release copy and a hand-made branch copy are listed with their facts and never removed", async () => {
    const { dir, base, add, commit, sweep } = await fixture();
    const release = add(base, join(dir, "releases", "wt-1"), null);
    const handMade = add(base, join(dir, "apps", "app-wt", "content-ingest"), "feat/content-ingest");
    commit(handMade, "c.txt");
    writeFileSync(join(handMade, "notes.txt"), "n\n");

    const out = await sweep();
    expect(decisionsOf(out)).toEqual({ [release]: ["outside", "skip", "outside"], [handMade]: ["outside", "skip", "outside"] });
    const byPath = Object.fromEntries(out.decisions.map((row) => [row.path, row]));
    expect(byPath[release]).toMatchObject({ merged: "ancestor", dirty: 0, unmerged: 0, branch: null });
    expect(byPath[release]!.detail).toMatch(/^outside the managed classes: merged \(ancestor\), untouched for \d+ day\(s\), 0 uncommitted change\(s\)$/u);
    expect(byPath[handMade]).toMatchObject({ merged: null, unmerged: 1, dirty: 1 });
    expect(out.removed).toEqual([]);
    expect(out.kept).toEqual([]);
    expect(existsSync(release) && existsSync(handMade)).toBe(true);
  });
});

describe("BB environments", () => {
  it("[sma:dt_wt_sweep] a managed environment with no live thread, merged, clean and old is BB's to remove; a live thread, edits or no id keep it; an unlisted BB folder is only listed", async () => {
    const { dir, base, add, commit, sweep } = await fixture();
    const bbRoot = join(dir, ".bb-machines", "m", "plugins", "environment-git-worktree", "host-data", "worktrees");
    const env = (name: string) => { const path = add(base, join(bbRoot, `${name}-1`, "app"), `bb/${name}`); commit(path, `${name}.txt`); git(base, "merge", "-q", "--no-ff", "-m", name, `bb/${name}`); return path; };
    const archived = env("thr_archived");
    const live = env("thr_live");
    const edited = env("thr_edited");
    writeFileSync(join(edited, "wip.txt"), "w\n");
    const noId = env("thr_noid");
    const unlisted = env("thr_gone");
    // A thread working in a copy of a managed class (an unmanaged environment pointing at it): kept although merged and old.
    const threadCopy = add(base, join(base, ".claude", "worktrees", "thread-copy"), "worktree-thread-copy");

    const out = await sweep({
      bbEnvs: [
        { path: archived, environmentId: "env_a", managed: true, live: false },
        { path: live, environmentId: "env_l", managed: true, live: true },
        { path: edited, environmentId: "env_e", managed: true, live: false },
        { path: threadCopy, environmentId: "env_t", managed: false, live: true },
      ],
      bbEnvPaths: [noId],
    });
    expect(decisionsOf(out)).toEqual({
      [archived]: ["bb-env", "remove", "merged"],
      [live]: ["bb-env", "keep", "live-thread"],
      [edited]: ["bb-env", "keep", "dirty"],
      [noId]: ["bb-env", "keep", "no-environment-id"],
      [unlisted]: ["outside", "skip", "bb-env-unlisted"],
      [threadCopy]: ["claude", "keep", "live-thread"],
    });
    const byPath = Object.fromEntries(out.decisions.map((row) => [row.path, row]));
    expect(byPath[archived]).toMatchObject({ via: "bb", environmentId: "env_a", merged: "ancestor" });
    expect(byPath[live]!.detail).toContain("merged (ancestor)");
    // The machine removes no environment itself: BB does, from the hub.
    expect(out.removed).toEqual([]);
    for (const path of [archived, live, edited, noId, unlisted, threadCopy]) expect(existsSync(path)).toBe(true);
  });
});

describe("the daily pass from the hub", () => {
  /** A hub with one machine on the real host handlers ($HOME = the fixture, so the home search runs there) and BB's environments stubbed. */
  async function hub(dir: string, envs: Array<{ id: string; path: string }>, refuse = new Set<string>(), afterDelete: "running" | "destroyed" = "running") {
    vi.stubEnv("HOME", dir);
    const fake = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(fake);
    const deleted: string[] = [];
    const threadQueries: unknown[] = [];
    const sdk = {
      hosts: { list: async () => [{ id: "h1", name: "Machine", status: "connected" }] },
      environments: {
        list: async () => envs.map((env) => ({ id: env.id, hostId: "h1", path: env.path, managed: true, isWorktree: true, status: "ready" })),
        delete: async ({ environmentId }: { environmentId: string }) => { if (refuse.has(environmentId)) throw new Error("Environment still has live threads"); deleted.push(environmentId); return { ok: true }; },
        // BB's teardown runs in the background: «running» keeps the folder (nothing here removes it), «destroyed» is BB saying it is done.
        get: async ({ environmentId }: { environmentId: string }) => afterDelete === "destroyed" && deleted.includes(environmentId)
          ? { status: "destroyed", lifecycle: { phase: "destroyed", teardown: { status: "removed" } } }
          : { status: "ready", lifecycle: { phase: "teardown", teardown: { status: "running", attempt: 1 } } },
      },
      // Only threads that are not archived come back (BB's own filter): none here.
      threads: { list: async (query: unknown) => { threadQueries.push(query); return []; } },
    };
    const bb = Object.assign(Object.create(Object.getPrototypeOf(fake)), fake, { sdk });
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false,
      host: { call: async (method: string, input: never) => { if (method !== "worktreeJanitor") throw new Error(`no ${method}`); return await worktreeJanitor(input, {} as never); } } } as never;
    return { db, ctx, deleted, threadQueries };
  }

  it("[sma:dt_wt_sweep] asks BB to remove an archived thread's merged environment, names what a dry run would remove, and posts the outside list once", async () => {
    const { dir, base, add, commit } = await fixture();
    const bbRoot = join(dir, ".bb-machines", "m", "plugins", "environment-git-worktree", "host-data", "worktrees");
    const env = add(base, join(bbRoot, "thr_a-1", "app"), "bb/thr_a");
    commit(env, "env.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "env", "bb/thr_a");
    const release = add(base, join(dir, "releases", "wt-1"), null);
    // A repository no project names, reached by the home search only.
    const stack = repo(join(dir, "tools", "lane-stack"));
    const night = add(stack, join(stack, ".worktrees", "night-1"), "night-1");
    const { db, ctx, deleted, threadQueries } = await hub(dir, [{ id: "env_a", path: env }]);
    const now = Date.now() + 8 * DAY;

    const dry = await runDailyWorktreePass(ctx, now, { dryRun: true });
    expect(deleted).toEqual([]);
    expect(threadQueries[0]).toMatchObject({ archived: false, includeHidden: true });
    expect(dry.decisions?.filter((row) => row.decision === "remove").map((row) => [row.host, row.path, row.via]).sort()).toEqual([["Machine", env, "bb"], ["Machine", night, "git"]].sort());
    expect(dry.decisions?.find((row) => row.path === release)).toMatchObject({ decision: "skip", reason: "outside", merged: "ancestor" });
    expect(dry.report).toContain(`удалилось бы: Machine: ${night}`);
    expect(dry.report).toContain(`удалилось бы: Machine: ${env}`);
    expect(dry.search?.[0]).toMatchObject({ host: "Machine", roots: [dir], maxDepth: 5, truncated: false });
    expect(existsSync(night) && existsSync(env)).toBe(true);
    const cli = await runWorktreeCleanupCli(ctx, {} as never, ["--dry-run", "--json"]);
    const json = JSON.parse(cli.stdout!) as { dry_run: boolean; decisions: Array<{ path: string; decision: string; reason: string }> };
    expect(json.dry_run).toBe(true);
    expect(json.decisions.map((row) => row.path)).toEqual(expect.arrayContaining([env, night, release]));

    const real = await runDailyWorktreePass(ctx, now, { teardownWaitMs: 300 });
    expect(real.status).toBe("ok");
    expect(deleted).toEqual(["env_a"]);
    expect(existsSync(night)).toBe(false);
    expect(existsSync(env)).toBe(true); // BB's provider removes it; this pass never touched the folder
    // BB took the delete but has not torn the environment down: «asked», not «removed», and neither counted nor freed.
    expect(real.decisions?.find((row) => row.path === env)).toMatchObject({ decision: "remove", via: "bb", outcome: "asked" });
    expect(real.report).toContain(`попросили BB удалить: Machine: ${env}`);
    expect(real.report).toContain("asked BB to remove the environment (BB: ready, teardown running); the next pass sees whether its folder is gone");
    expect(real.report).not.toContain(`удалено: Machine: ${env}`);
    expect(real.removed).toBe(1);
    const nightBytes = dry.decisions!.find((row) => row.path === night)!.bytes;
    expect(real.freedBytes).toBe(nightBytes);
    const janitorRow = JSON.parse((db.prepare("SELECT report_json FROM lane_pilot_janitor WHERE pass='daily'").get() as { report_json: string }).report_json);
    expect(janitorRow.classes["bb-env"]?.removed ?? 0).toBe(0);
    expect(janitorRow.decisions.find((row: { path: string }) => row.path === env).outcome).toBe("asked");
    expect(existsSync(release)).toBe(true);
    const outsideItems = () => db.prepare("SELECT key, state FROM lane_pilot_owner_item WHERE key LIKE ?").all(`${OUTSIDE_ITEM_PREFIX}%`) as Array<{ key: string; state: string }>;
    expect(outsideItems().filter((row) => row.state === "open")).toHaveLength(1);
    await runDailyWorktreePass(ctx, now + DAY, { teardownWaitMs: 0 });
    expect(outsideItems()).toHaveLength(1);
  });

  it("[sma:dt_wt_sweep] an environment BB reports destroyed after the delete is counted as removed, with its space", async () => {
    const { dir, base, add, commit } = await fixture();
    const env = add(base, join(dir, ".bb-machines", "m", "plugins", "environment-git-worktree", "host-data", "worktrees", "thr_d-1", "app"), "bb/thr_d");
    commit(env, "env.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "env", "bb/thr_d");
    const { ctx, deleted } = await hub(dir, [{ id: "env_d", path: env }], new Set(), "destroyed");
    const out = await runDailyWorktreePass(ctx, Date.now() + 8 * DAY, { teardownWaitMs: 300 });
    expect(deleted).toEqual(["env_d"]);
    const row = out.decisions?.find((item) => item.path === env);
    expect(row).toMatchObject({ decision: "remove", outcome: "removed" });
    expect(row!.detail).toContain("BB removed the environment");
    expect(out.report).toContain(`удалено: Machine: ${env}`);
    expect(out.removed).toBe(1);
    expect(out.freedBytes).toBe(row!.bytes);
  });

  it("[sma:dt_wt_sweep] an environment BB refuses to remove is kept with BB's answer", async () => {
    const { dir, base, add, commit } = await fixture();
    const env = add(base, join(dir, ".bb-machines", "m", "plugins", "environment-git-worktree", "host-data", "worktrees", "thr_r-1", "app"), "bb/thr_r");
    commit(env, "env.txt");
    git(base, "merge", "-q", "--no-ff", "-m", "env", "bb/thr_r");
    const { ctx, deleted } = await hub(dir, [{ id: "env_r", path: env }], new Set(["env_r"]));
    const out = await runDailyWorktreePass(ctx, Date.now() + 8 * DAY);
    expect(deleted).toEqual([]);
    expect(out.decisions?.find((row) => row.path === env)).toMatchObject({ decision: "keep", reason: "error" });
    expect(out.report).toContain("BB refused to remove the environment: Environment still has live threads");
    expect(out.removed).toBe(0);
  });
});
