import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./fixture";
import { baselineCommand } from "../../src/rooms/project-git/scripts";

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
type Rec = { opId?: string; repo?: { requestedAt?: number } };
const record = (f: Fixture) => [...f.store.entries()].filter(([k]) => k.startsWith("project-git:bootstrap:")).map(([, v]) => v as Rec)[0];
const ensure = (f: Fixture, root: string) => f.projectGit.ensure({ threadId: "t1", hostId: "h1", projectRoot: root, taskKey: "task-1" });

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

describe("project git retries through the public ensure (P03.08)", () => {
  const files = { "README.md": "# app\n", "src/main.ts": "export const x = 1;\n" };

  it("continues after a blocked first commit once the file is fixed, without asking again", async () => {
    const f = makeFixture();
    const root = f.folder("app", { ...files, "src/key.ts": KEY_LINE });
    f.setAnswer(picked("1"));
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "blocked_files" } });
    f.sh(root, "rm src/key.ts");
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
    expect(f.asks).toHaveLength(1);
    expect(f.gh().creates).toBe(1);
    expect(await ensure(f, root)).toEqual({ kind: "repo", state: "origin", root });
  });

  it("continues after a sign-in stop following the first commit, and after a push failure with origin added", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const restore = intercept(f, async (command, run) => { const ran = await run(); if (isBaseline(command)) f.gh({ authed: false }); return ran; });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "auth", code: "no_provider_auth" } });
    restore();
    f.gh({ authed: true });
    const unpush = intercept(f, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "push", code: "push_failed" } });
    expect(f.sh(root, "git remote").stdout.trim()).toBe("origin");
    unpush();
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
    expect(f.asks).toHaveLength(1);
    expect(f.gh().creates).toBe(1);
    expect(f.sh(f.gh().repos["octo/app"]!.bare, "git rev-list --all --count").stdout.trim()).toBe("1");
  });

  it("finishes its own marked repository left before the rename, and stops on a .git it did not mark", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const restore = intercept(f, async (command, run) => { if (isBaseline(command)) throw new Error("host offline"); return run(); });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "baseline" } });
    restore();
    const op = record(f)!.opId!;
    f.sh(root, `git --git-dir=.git-lp-${op} init -q && git --git-dir=.git-lp-${op} config core.bare false && echo '{"opId":"${op}"}' > .git-lp-${op}/lane-pilot-bootstrap`);
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
    expect(existsSync(join(root, `.git-lp-${op}`))).toBe(false);

    const g = makeFixture();
    const other = g.folder("app", files);
    g.setAnswer(picked("1"));
    const cut = intercept(g, async (command, run) => { if (isBaseline(command)) throw new Error("host offline"); return run(); });
    await ensure(g, other);
    cut();
    g.sh(other, "git init -q");
    expect(await ensure(g, other)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "baseline", code: "existing_repo" } });
    expect(g.asks).toHaveLength(1);
    expect(g.gh().creates ?? 0).toBe(0);
  });

  it("keeps a permanent refusal: the next ensure runs no scan, create or push and asks nothing; a deliberate retry goes on", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const restore = intercept(f, async (command, run) => { const ran = await run(); if (isBaseline(command)) f.gh({ authed: false }); return ran; });
    await ensure(f, root);
    restore();
    f.gh({ authed: true });
    f.sh(root, "echo later > later.txt && git add later.txt && git commit -qm later");
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "head_moved" } });
    const before = f.commands.length;
    expect(await ensure(f, root)).toMatchObject({ kind: "stopped", root, stage: "baseline", code: "head_moved" });
    const later = f.commands.slice(before);
    expect(later.some((c) => isBaseline(c) || c.includes("repo create") || / push '/.test(c) || c.includes(" api "))).toBe(false);
    expect(f.asks).toHaveLength(1);
    expect(await f.projectGit.bootstrap({ hostId: "h1", root, account: "octo" })).toMatchObject({ ok: false, code: "head_moved", stopped: true });
    f.sh(root, "git reset -q --hard HEAD~1");
    expect(await f.projectGit.bootstrap({ hostId: "h1", root, account: "octo", retryStopped: true })).toMatchObject({ ok: true });
    expect(f.gh().creates).toBe(1);
  });

  it("does not pin an account to a preflight that failed before the operation began", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    f.live.runId = "lprun_1";
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "live_run_active" } });
    f.live.runId = null;
    f.gh({ login: "other" });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true, fullName: "other/app" } });
    expect(f.asks).toHaveLength(2);
    expect(f.asks[1]!.detail).toContain("аккаунте other");
  });

  it("refuses to publish after a failed push once origin points elsewhere, and keeps that refusal", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const unpush = intercept(f, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "push_failed" } });
    unpush();
    f.sh(f.base, "git init -q --bare elsewhere.git");
    f.sh(root, `git remote set-url origin file://${join(f.base, "elsewhere.git")}`);
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "origin_conflict" } });
    expect(await ensure(f, root)).toMatchObject({ kind: "stopped", code: "origin_conflict" });
    const refs = (bare: string) => f.sh(bare, "git for-each-ref").stdout.trim();
    expect(refs(join(f.base, "elsewhere.git"))).toBe("");
    expect(refs(f.gh().repos["octo/app"]!.bare)).toBe("");
    expect(f.sh(root, "git remote get-url origin").stdout.trim()).toBe(`file://${join(f.base, "elsewhere.git")}`);
  });

  it("refuses an origin changed between the probe and the push without pushing anywhere", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const unpush = intercept(f, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
    await ensure(f, root);
    unpush();
    intercept(f, async (command, run) => {
      if (command.includes("api --hostname github.com 'repos/")) f.sh(root, "git remote set-url origin https://github.com/someone/else.git");
      return run();
    });
    const before = f.commands.length;
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "push", code: "origin_conflict" } });
    expect(f.commands.slice(before).some((c) => / push '/.test(c))).toBe(false);
    expect(f.sh(f.gh().repos["octo/app"]!.bare, "git for-each-ref").stdout.trim()).toBe("");
  });

  it("refuses an origin changed while the push ran, before verifying or finishing", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    intercept(f, async (command, run) => {
      const ran = await run();
      if (/ push '/.test(command)) f.sh(root, "git remote set-url origin https://github.com/someone/else.git");
      return ran;
    });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "push", code: "origin_conflict" } });
    expect(f.commands.some((c) => c.includes("ls-remote") && c.includes("refs/heads/"))).toBe(false);
    expect(record(f) as { doneAt?: number }).not.toHaveProperty("doneAt");
  });

  it("recovers its own origin after the store failed right after remote add, and still refuses a foreign one", async () => {
    for (const foreign of [false, true]) {
      const f = makeFixture();
      const root = f.folder("app", files);
      f.setAnswer(picked("1"));
      const set = f.kv.set;
      f.kv.set = async (key, value) => {
        if ((value as { origin?: unknown }).origin) throw new Error("store unavailable");
        return set(key, value);
      };
      await expect(ensure(f, root)).rejects.toThrow("store unavailable");
      f.kv.set = set;
      expect(f.sh(root, "git remote get-url origin").stdout.trim()).toBe(`file://${f.gh().repos["octo/app"]!.bare}`);
      expect(record(f) as { origin?: unknown }).not.toHaveProperty("origin");
      if (foreign) {
        f.sh(root, "git remote set-url origin https://github.com/someone/else.git");
        expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "probe", code: "already_has_origin" } });
        expect(f.sh(f.gh().repos["octo/app"]!.bare, "git for-each-ref").stdout.trim()).toBe("");
      } else {
        expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
        expect(f.sh(f.gh().repos["octo/app"]!.bare, "git rev-parse main").stdout.trim()).toBe(head(f, root));
      }
      expect(f.asks).toHaveLength(1);
      expect(f.gh().creates).toBe(1);
    }
  });

  it("sets no upstream when origin changes while the published commit is verified", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    intercept(f, async (command, run) => {
      const ran = await run();
      if (command.includes("ls-remote") && command.includes("refs/heads/")) f.sh(root, "git remote set-url origin https://github.com/someone/else.git");
      return ran;
    });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "push", code: "origin_conflict" } });
    expect(f.sh(root, "git config --get branch.main.remote").stdout.trim()).toBe("");
    expect(f.sh(root, "git remote get-url origin").stdout.trim()).toBe("https://github.com/someone/else.git");
  });

  it("does not finish on a failing ls-remote even when its output names the commit", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const restore = intercept(f, async (command, run) => {
      const ran = await run();
      return command.includes("ls-remote") && command.includes("refs/heads/") ? { ...ran, exitCode: 128 } : ran;
    });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "push", code: "push_unverified" } });
    expect(record(f) as { doneAt?: number; push?: unknown }).not.toHaveProperty("doneAt");
    expect(record(f) as { push?: unknown }).not.toHaveProperty("push");
    restore();
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
    expect(f.asks).toHaveLength(1);
    expect(f.gh().creates).toBe(1);
  });

  it("does not pin a refusal from before the operation: a repository made during the question, once removed, goes on", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(() => { f.sh(root, "git init -q && git add . && git commit -qm race"); return picked("1")(); });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, code: "existing_history" } });
    expect(record(f) as { stopped?: unknown }).not.toHaveProperty("stopped");
    f.sh(root, "rm -rf .git");
    f.setAnswer(picked("1"));
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: true } });
    expect(f.asks).toHaveLength(1);
  });

  it("compiles the secret patterns before it writes anything: a pattern Python rejects leaves no .git or .gitignore", () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    const ran = f.sh(root, baselineCommand({ root, opId: "op-bad", secrets: ["\\e"] }));
    expect(JSON.parse(ran.stdout)).toMatchObject({ ok: false, code: "secret_patterns_untranslatable" });
    expect(existsSync(join(root, ".git"))).toBe(false);
    expect(existsSync(join(root, ".git-lp-op-bad"))).toBe(false);
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("keeps the account the owner was shown: another sign-in stops the continuation", async () => {
    const f = makeFixture();
    const root = f.folder("app", files);
    f.setAnswer(picked("1"));
    const unpush = intercept(f, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
    expect((await ensure(f, root)).kind).toBe("bootstrapped");
    unpush();
    f.gh({ login: "other" });
    expect(await ensure(f, root)).toMatchObject({ kind: "bootstrapped", result: { ok: false, stage: "auth", code: "account_changed" } });
    expect(await f.projectGit.bootstrap({ hostId: "h1", root, account: "other" })).toMatchObject({ ok: false, code: "account_changed" });
    expect(f.asks).toHaveLength(1);
    expect(f.gh().creates).toBe(1);
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
    // The refusal is kept until a deliberate retry; moved back to the first commit, the retry publishes exactly it.
    f.sh(root, "git reset -q --hard HEAD~1");
    expect(await boot(f, root)).toMatchObject({ ok: false, code: "head_moved", stopped: true });
    const ok = await f.projectGit.bootstrap({ hostId: "h1", root, account: "octo", retryStopped: true });
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
    const before = f.commands.length;
    expect(await boot(f, root)).toMatchObject({ ok: false, code: "remote_name_taken", stopped: true });
    expect(f.commands.length).toBe(before);
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

  it("refuses a repository named for this operation once it has refs", async () => {
    const f = makeFixture();
    const root = project(f);
    const restore = intercept(f, async (command, run) => { if (command.includes("repo create")) throw new Error("host offline"); return run(); });
    expect(await boot(f, root)).toMatchObject({ ok: false, code: "create_failed" });
    restore();
    const bare = join(f.base, "filled.git");
    f.sh(f.base, `git init -q --bare filled.git && git clone -q filled.git w 2>/dev/null; cd w && echo x > x && git add x && git commit -qm x && git push -q origin HEAD:main`);
    f.gh({ repos: { "octo/my-app": { id: 9, private: true, bare, created_at: new Date().toISOString(), description: `Private repository made by Lane Pilot (op ${record(f)!.opId})` } } });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "repo", code: "remote_name_taken" });
    expect(f.sh(root, "git remote").stdout.trim()).toBe("");
  });

  it("refuses an operation-named repository whose refs cannot be listed", async () => {
    const f = makeFixture();
    const root = project(f);
    const restore = intercept(f, async (command, run) => { if (command.includes("repo create")) throw new Error("host offline"); return run(); });
    await boot(f, root);
    restore();
    f.gh({ repos: { "octo/my-app": { id: 9, private: true, bare: join(f.base, "missing.git"), created_at: new Date().toISOString(), description: `Private repository made by Lane Pilot (op ${record(f)!.opId})` } } });
    expect(await boot(f, root)).toMatchObject({ ok: false, stage: "repo", code: "remote_unverified" });
  });

  it("refuses a later account against the recorded operation and the recorded repository owner", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ authed: false });
    await boot(f, root);
    f.gh({ authed: true, login: "other" });
    expect(await f.projectGit.bootstrap({ hostId: "h1", root, account: "other" })).toMatchObject({ ok: false, stage: "auth", code: "account_changed", detail: expect.stringContaining("began for octo") });

    const g = makeFixture();
    const repo = project(g);
    const unpush = intercept(g, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
    await boot(g, repo);
    unpush();
    delete (record(g) as { account?: string }).account; // a record from before the account was kept
    g.gh({ login: "other" });
    expect(await g.projectGit.bootstrap({ hostId: "h1", root: repo, account: "other" })).toMatchObject({ ok: false, code: "account_changed", detail: expect.stringContaining("recorded under octo") });
  });

  it("refuses links and bytes that change between the scan and the index", async () => {
    const f = makeFixture();
    const linked = f.folder("links", { "a.txt": "a" });
    symlinkSync("/etc/hostname", join(linked, "host"));
    expect(await boot(f, linked)).toMatchObject({ ok: false, code: "blocked_files", blocked: [{ path: "host", why: expect.stringMatching(/^a link/) }] });
    const eol = f.folder("eol", { ".gitattributes": "*.txt text\n", "a.txt": "one\r\ntwo\r\n" });
    expect(await boot(f, eol)).toMatchObject({ ok: false, stage: "baseline", code: "changed_while_scanned" });
    expect(f.sh(eol, "git rev-parse --verify -q HEAD").status).not.toBe(0);
    expect(f.gh().creates ?? 0).toBe(0);
  });

  it("resumes at the push after a host outage, with one repository and one commit", async () => {
    const f = makeFixture();
    const root = project(f);
    const restore = intercept(f, async (command, run) => { if (/ push '/.test(command)) throw new Error("host offline"); return run(); });
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
