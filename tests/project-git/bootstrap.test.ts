import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./fixture";

const KEY_LINE = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
type Fixture = ReturnType<typeof makeFixture>;
const tracked = (f: Fixture, dir: string) => f.sh(dir, "git ls-files").stdout.trim().split("\n").filter(Boolean).sort();
const head = (f: Fixture, dir: string) => f.sh(dir, "git rev-parse HEAD").stdout.trim();
const picked = (id: string) => () => ({ outcome: "answered" as const, choice: { id, label: id }, text: "", line: id });
const boot = (f: Fixture, root: string) => f.projectGit.bootstrap({ hostId: "h1", root, account: "octo" });
/** Wraps the fixture host: `around` sees each command and may throw instead of or after running it. */
function intercept(f: Fixture, around: (command: string, run: () => Promise<{ hostId: string; exitCode: number; stdout: string; stderr: string }>) => Promise<{ hostId: string; exitCode: number; stdout: string; stderr: string }>) {
  const call = f.host.call.bind(f.host);
  f.host.call = (method, input, options) => around(input.command, () => call(method, input, options));
  return () => { f.host.call = call; };
}
const isBaseline = (command: string) => command.includes("lane-pilot-bootstrap");

describe("project git probe (P03.04)", () => {
  it("tells no Git, a parent repository and an unreadable host apart", async () => {
    const f = makeFixture();
    const plain = f.folder("plain", { "a.txt": "a" });
    expect((await f.projectGit.probe("h1", plain)).state).toBe("noGit");

    const repo = f.folder("repo", { "a.txt": "a" });
    f.sh(repo, "git init -q && git add . && git commit -qm init");
    const section = f.folder("repo/section");
    expect(await f.projectGit.probe("h1", section)).toMatchObject({ state: "localNoOrigin", root: repo, hasCommit: true });
    f.sh(repo, "git remote add origin https://github.com/octo/repo.git");
    expect(await f.projectGit.probe("h1", section)).toMatchObject({ state: "origin", root: repo, origin: "https://github.com/octo/repo.git" });

    const broken = f.folder("broken", { ".git": "gitdir: /nonexistent/worktrees/x\n" });
    expect((await f.projectGit.probe("h1", broken)).state).toBe("unknown");
    expect((await f.projectGit.probe("h1", join(f.base, "missing"))).state).toBe("unknown");
    f.host.online = false;
    expect((await f.projectGit.probe("h1", plain)).state).toBe("unknown");
  });
});

describe("project git scope question (P03.05)", () => {
  it("asks once with the host paths and the github.com account, keeps the pick, and never asks for a folder in a repository", async () => {
    const f = makeFixture();
    const project = f.folder("proj", { "a.txt": "a" });
    const section = f.folder("proj/site", { "b.txt": "b" });
    f.setAnswer(picked("2"));
    const input = { threadId: "t1", hostId: "h1", projectRoot: project, sectionPath: section, taskKey: "task-1" };
    const [one, two] = await Promise.all([f.projectGit.resolveScope(input), f.projectGit.resolveScope({ ...input, taskKey: "task-2" })]);
    expect(one).toEqual({ kind: "chosen", choice: { scope: "section", root: section }, account: "octo" });
    expect(two).toEqual(one);
    expect(f.asks).toHaveLength(1);
    expect(f.asks[0]!.options).toEqual([`Весь проект: ${project}`, `Только раздел: ${section}`]);
    expect(f.asks[0]!.detail).toContain("github.com в аккаунте octo");
    expect(await f.projectGit.resolveScope({ ...input, taskKey: "task-3" })).toEqual(one);
    expect(f.asks).toHaveLength(1);
    // Another sign-in is a different disclosure: the owner is asked again.
    f.gh({ login: "other" });
    expect(await f.projectGit.resolveScope({ ...input, taskKey: "task-4" })).toMatchObject({ kind: "chosen", account: "other" });
    expect(f.asks).toHaveLength(2);

    const repo = f.folder("repo", { "a.txt": "a" });
    f.sh(repo, "git init -q && git add . && git commit -qm init");
    expect(await f.projectGit.ensure({ threadId: "t1", hostId: "h1", projectRoot: repo, sectionPath: f.folder("repo/sub") }))
      .toEqual({ kind: "repo", state: "localNoOrigin", root: repo });
    f.host.online = false;
    expect((await f.projectGit.resolveScope({ threadId: "t1", hostId: "h1", projectRoot: project })).kind).toBe("unknown");
    expect(f.asks).toHaveLength(2);
  });

  it("asks nothing when gh is not signed in, and keeps a dismissal for its task", async () => {
    const f = makeFixture();
    const project = f.folder("proj", { "a.txt": "a" });
    const input = { threadId: "t1", hostId: "h1", projectRoot: project, taskKey: "task-1" };
    f.gh({ authed: false });
    expect(await f.projectGit.resolveScope(input)).toMatchObject({ kind: "noProvider", code: "no_provider_auth" });
    expect(f.asks).toHaveLength(0);
    f.gh({ authed: true });
    expect((await f.projectGit.resolveScope(input)).kind).toBe("declined");
    expect((await f.projectGit.resolveScope(input)).kind).toBe("declined");
    expect(f.asks).toHaveLength(1);
    expect(f.asks[0]!.options).toEqual([`Весь проект: ${project}`]);
    expect(existsSync(join(project, ".git"))).toBe(false);
  });
});

describe("project git bootstrap (P03.06–08)", () => {
  const project = (f: Fixture) => f.folder("my app", {
    "README.md": "# app\n", "src/main.ts": "export const x = 1;\n", ".env": "TOKEN=abc\n", ".env.example": "TOKEN=\n",
    "node_modules/dep/index.js": "x", ".agents/runs/r1.json": "{}", ".agents/tasks/t1/contract.json": "{}", "site/.agents/tasks/t2/plan.md": "plan", ".agents/PROGRESS.md": "progress\n", ".bb/chats/c.json": "{}", "deploy.key": "k",
  });

  it("commits the curated real files, creates a verified private repository and pushes exactly that commit", async () => {
    const f = makeFixture();
    const root = project(f);
    f.setAnswer(picked("1"));
    const result = await f.projectGit.ensure({ threadId: "t1", hostId: "h1", projectRoot: root, taskKey: "task-1" });
    expect(result).toMatchObject({ kind: "bootstrapped", result: { ok: true, fullName: "octo/my-app", branch: "main" } });
    expect(tracked(f, root)).toEqual([".agents/PROGRESS.md", ".env.example", ".gitignore", "README.md", "src/main.ts"]);
    expect(f.sh(root, "git rev-list --all --count").stdout.trim()).toBe("1");
    expect(f.sh(root, "git log -1 --format=%B").stdout).toMatch(/Lane-Pilot-Bootstrap: [0-9a-f-]{36}/);
    const state = f.gh();
    expect(state.creates).toBe(1);
    expect(state.repos["octo/my-app"]).toMatchObject({ private: true, description: expect.stringMatching(/^Private repository made by Lane Pilot \(op [0-9a-f-]{36}\)$/) });
    expect(f.sh(state.repos["octo/my-app"]!.bare, "git rev-parse main").stdout.trim()).toBe(head(f, root));
    expect(f.invalidated).toEqual([root]);
    // Done is done: a second call creates nothing and runs no host command.
    const before = f.commands.length;
    expect((await boot(f, root)).ok).toBe(true);
    expect(f.commands.length).toBe(before);
    expect(f.commands.some((c) => /git add (-A|\.)/.test(c))).toBe(false);
  });

  it("scans whole files, stops before staging, and resumes only in the repository it started", async () => {
    const f = makeFixture();
    const root = f.folder("leaky", { "src/config.ts": `${"x".repeat(2 * 1024 * 1024)}\n${KEY_LINE}\n`, "ok.txt": "ok" });
    const result = await boot(f, root);
    expect(result).toMatchObject({ ok: false, stage: "baseline", code: "blocked_files", blocked: [{ path: "src/config.ts", why: "looks like it holds a credential" }] });
    expect(f.sh(root, "git rev-parse --verify -q HEAD").status).not.toBe(0);
    expect(f.sh(root, "git diff --cached --name-only").stdout.trim()).toBe("");
    expect(f.gh().creates ?? 0).toBe(0);
    f.sh(root, "rm src/config.ts");
    expect((await boot(f, root)).ok).toBe(true);
    expect(tracked(f, root)).toEqual([".gitignore", "ok.txt"]);
  });

  it("never adopts a commit made by hand into the repository it started", async () => {
    const f = makeFixture();
    const root = f.folder("hand", { "src/config.ts": KEY_LINE, "ok.txt": "ok" });
    expect((await boot(f, root)).ok).toBe(false);
    f.sh(root, "rm src/config.ts && git add ok.txt && git commit -qm 'by hand'");
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "baseline", code: "existing_history" });
    expect(f.gh().creates ?? 0).toBe(0);
  });

  it("recovers its own commit after a lost answer, but not once another commit follows it", async () => {
    for (const extra of [false, true]) {
      const f = makeFixture();
      const root = project(f);
      const restore = intercept(f, async (command, run) => { const ran = await run(); if (isBaseline(command)) throw new Error("host offline"); return ran; });
      expect(await boot(f, root)).toMatchObject({ ok: false, stage: "baseline", code: "baseline_failed" });
      restore();
      const ours = head(f, root);
      if (extra) f.sh(root, "echo more > more.txt && git add more.txt && git commit -qm next");
      const again = await boot(f, root);
      if (extra) {
        expect(again).toMatchObject({ ok: false, stage: "baseline", code: "existing_history" });
        expect(f.gh().creates ?? 0).toBe(0);
      } else expect(again).toMatchObject({ ok: true, commit: ours });
    }
  });

  it("refuses a commit made after the first one instead of pushing it", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ authed: false });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "auth", code: "no_provider_auth" });
    f.sh(root, "echo later > later.txt && git add later.txt && git commit -qm later");
    f.gh({ authed: true });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "baseline", code: "head_moved" });
    expect(f.gh().creates ?? 0).toBe(0);
    // Moved back to the first commit, the bootstrap goes on and publishes exactly it.
    f.sh(root, "git reset -q --hard HEAD~1");
    const ok = await boot(f, root);
    expect(ok).toMatchObject({ ok: true });
    expect(f.sh(f.gh().repos["octo/my-app"]!.bare, "git rev-list --all --count").stdout.trim()).toBe("1");
  });

  it("adopts the repository a lost create answer made, and after a crash before the readback, without a second create", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ loseAck: true });
    expect((await boot(f, root)).ok).toBe(true);
    expect(f.gh().creates).toBe(1);

    const g = makeFixture();
    const other = project(g);
    let created = false;
    const restore = intercept(g, async (command, run) => {
      if (created && command.includes("api --hostname github.com 'repos/")) throw new Error("host offline");
      const ran = await run();
      if (command.includes("repo create")) created = true;
      return ran;
    });
    expect(await boot(g, other)).toMatchObject({ ok: false, stage: "repo", code: "readback_failed" });
    restore();
    expect((await boot(g, other)).ok).toBe(true);
    expect(g.gh().creates).toBe(1);
  });

  it("refuses a same-named repository that appeared after an uncertain create, and keeps the first request time", async () => {
    const f = makeFixture();
    const root = project(f);
    const restore = intercept(f, async (command, run) => { if (command.includes("repo create")) throw new Error("host offline"); return run(); });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "repo", code: "create_failed" });
    const first = [...f.store.values()].map((v) => (v as { repo?: { requestedAt?: number } }).repo?.requestedAt).find(Boolean);
    expect(await boot(f, root)).toMatchObject({ ok: false, code: "create_failed" });
    expect([...f.store.values()].map((v) => (v as { repo?: { requestedAt?: number } }).repo?.requestedAt).find(Boolean)).toBe(first);
    restore();
    f.sh(f.base, "git init -q --bare foreign.git");
    f.gh({ repos: { "octo/my-app": { id: 9, private: true, bare: join(f.base, "foreign.git"), created_at: new Date().toISOString(), description: "someone's" } } });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "repo", code: "remote_name_taken" });
    expect(f.sh(root, "git remote").stdout.trim()).toBe("");
  });

  it("works only in the folder it probed when a parent is swapped for a link before the first commit", async () => {
    const f = makeFixture();
    const root = f.folder("real/proj", { "a.txt": "a" });
    const elsewhere = f.folder("other/proj", { "b.txt": "b" });
    intercept(f, async (command, run) => {
      if (isBaseline(command)) f.sh(f.base, "mv real real-old && ln -s other real");
      return run();
    });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "baseline", code: "not_canonical" });
    expect(existsSync(join(elsewhere, ".git"))).toBe(false);
  });

  it("resumes at the push after a host outage, with one repository and one commit", async () => {
    const f = makeFixture();
    const root = project(f);
    const restore = intercept(f, async (command, run) => { if (/ push origin /.test(command)) throw new Error("host offline"); return run(); });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "push", code: "push_failed" });
    restore();
    expect((await boot(f, root)).ok).toBe(true);
    expect(f.gh().creates).toBe(1);
    expect(f.sh(root, "git rev-list --all --count").stdout.trim()).toBe("1");
  });

  it("refuses existing history, a public readback, a taken name, an existing origin, a .gitignore link, another account and a live run", async () => {
    const f = makeFixture();
    const local = f.folder("local", { "a.txt": "a" });
    f.sh(local, "git init -q && git add . && git commit -qm mine");
    expect(await boot(f, local)).toMatchObject({ ok: false, stage: "baseline", code: "existing_history" });
    const empty = f.folder("empty-repo", { "a.txt": "a" });
    f.sh(empty, "git init -q");
    expect(await boot(f, empty)).toMatchObject({ ok: false, code: "existing_history" });

    const root = project(f);
    f.gh({ forcePublic: true });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "repo", code: "readback_mismatch" });
    expect(f.sh(root, "git remote").stdout.trim()).toBe("");
    expect(f.gh().creates).toBe(1);

    const g = makeFixture();
    const taken = g.folder("taken", { "a.txt": "a" });
    g.gh({ repos: { "octo/taken": { id: 7, private: true, bare: join(g.base, "x.git"), created_at: "2020-01-01T00:00:00Z" } } });
    expect(await boot(g, taken)).toMatchObject({ ok: false, code: "remote_name_taken" });
    expect(g.gh().creates ?? 0).toBe(0);

    const owned = g.folder("owned", { "a.txt": "a" });
    g.sh(owned, "git init -q && git add . && git commit -qm init && git remote add origin https://github.com/someone/else.git");
    expect(await boot(g, owned)).toMatchObject({ ok: false, code: "already_has_origin" });
    expect(g.sh(owned, "git remote get-url origin").stdout.trim()).toBe("https://github.com/someone/else.git");

    const linked = g.folder("linked", { "a.txt": "a" });
    const outside = join(g.base, "outside.txt");
    writeFileSync(outside, "keep\n");
    symlinkSync(outside, join(linked, ".gitignore"));
    expect(await boot(g, linked)).toMatchObject({ ok: false, stage: "baseline", code: "gitignore_not_plain" });
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
    expect(existsSync(join(linked, ".git"))).toBe(false);

    const switched = g.folder("switched", { "a.txt": "a" });
    g.gh({ login: "intruder" });
    expect(await boot(g, switched)).toMatchObject({ ok: false, stage: "auth", code: "account_changed" });
    expect(g.gh().creates ?? 0).toBe(0);

    const busy = g.folder("busy", { "a.txt": "a" });
    g.live.runId = "lprun_1";
    expect(await boot(g, busy)).toMatchObject({ ok: false, stage: "guard", code: "live_run_active" });
    expect(existsSync(join(busy, ".git"))).toBe(false);
  });
});
