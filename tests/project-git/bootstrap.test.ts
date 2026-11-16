import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixture } from "./fixture";

const KEY_LINE = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const tracked = (f: ReturnType<typeof makeFixture>, dir: string) => f.sh(dir, "git ls-files").stdout.trim().split("\n").filter(Boolean).sort();
const picked = (id: string) => () => ({ outcome: "answered" as const, choice: { id, label: id }, text: "", line: id });

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
  it("asks once with the host paths, keeps the pick, and never asks for a folder in a repository", async () => {
    const f = makeFixture();
    const project = f.folder("proj", { "a.txt": "a" });
    const section = f.folder("proj/site", { "b.txt": "b" });
    f.setAnswer(picked("2"));
    const input = { threadId: "t1", hostId: "h1", projectRoot: project, sectionPath: section, taskKey: "task-1" };
    const [one, two] = await Promise.all([f.projectGit.resolveScope(input), f.projectGit.resolveScope({ ...input, taskKey: "task-2" })]);
    expect(one).toEqual({ kind: "chosen", choice: { scope: "section", root: section } });
    expect(two).toEqual(one);
    expect(f.asks).toHaveLength(1);
    expect(f.asks[0]!.options).toEqual([`Весь проект: ${project}`, `Только раздел: ${section}`]);
    expect(await f.projectGit.resolveScope({ ...input, taskKey: "task-3" })).toEqual(one);
    expect(f.asks).toHaveLength(1);

    const repo = f.folder("repo", { "a.txt": "a" });
    f.sh(repo, "git init -q && git add . && git commit -qm init");
    expect(await f.projectGit.resolveScope({ threadId: "t1", hostId: "h1", projectRoot: repo, sectionPath: f.folder("repo/sub") }))
      .toEqual({ kind: "repo", state: "localNoOrigin", root: repo });
    f.host.online = false;
    expect((await f.projectGit.resolveScope({ threadId: "t1", hostId: "h1", projectRoot: project })).kind).toBe("unknown");
    expect(f.asks).toHaveLength(1);
  });

  it("keeps a dismissal for its task, so the same task does not ask twice", async () => {
    const f = makeFixture();
    const project = f.folder("proj", { "a.txt": "a" });
    const input = { threadId: "t1", hostId: "h1", projectRoot: project, taskKey: "task-1" };
    expect((await f.projectGit.resolveScope(input)).kind).toBe("declined");
    expect((await f.projectGit.resolveScope(input)).kind).toBe("declined");
    expect(f.asks).toHaveLength(1);
    expect(f.asks[0]!.options).toEqual([`Весь проект: ${project}`]);
    expect(existsSync(join(project, ".git"))).toBe(false);
  });
});

describe("project git bootstrap (P03.06–08)", () => {
  const project = (f: ReturnType<typeof makeFixture>) => f.folder("my app", {
    "README.md": "# app\n", "src/main.ts": "export const x = 1;\n", ".env": "TOKEN=abc\n", ".env.example": "TOKEN=\n",
    "node_modules/dep/index.js": "x", ".agents/runs/r1.json": "{}", ".agents/PROGRESS.md": "progress\n", ".bb/chats/c.json": "{}", "deploy.key": "k",
  });

  it("commits the curated real files, creates a verified private repository and pushes it", async () => {
    const f = makeFixture();
    const root = project(f);
    f.setAnswer(picked("1"));
    const result = await f.projectGit.ensure({ threadId: "t1", hostId: "h1", projectRoot: root, taskKey: "task-1" });
    expect(result).toMatchObject({ kind: "bootstrapped", result: { ok: true, fullName: "octo/my-app", branch: "main" } });
    expect(tracked(f, root)).toEqual([".agents/PROGRESS.md", ".env.example", ".gitignore", "README.md", "src/main.ts"]);
    expect(f.sh(root, "git rev-list --count HEAD").stdout.trim()).toBe("1");
    const state = f.gh();
    expect(state.creates).toBe(1);
    expect(state.repos["octo/my-app"]!.private).toBe(true);
    const bare = state.repos["octo/my-app"]!.bare;
    expect(f.sh(bare, "git rev-parse main").stdout.trim()).toBe(f.sh(root, "git rev-parse HEAD").stdout.trim());
    expect(f.invalidated).toEqual([root]);
    // Done is done: a second call creates nothing and runs no host command.
    const before = f.commands.length;
    expect((await f.projectGit.bootstrap({ hostId: "h1", root })).ok).toBe(true);
    expect(f.commands.length).toBe(before);
    expect(f.commands.some((c) => /git add (-A|\.)/.test(c))).toBe(false);
  });

  it("stops before staging anything when a file holds a credential or is a nested repository", async () => {
    const f = makeFixture();
    const root = f.folder("leaky", { "src/config.ts": `export const k = \`${KEY_LINE}\`;\n`, "ok.txt": "ok" });
    const result = await f.projectGit.bootstrap({ hostId: "h1", root });
    expect(result).toMatchObject({ ok: false, stage: "baseline", code: "blocked_files", blocked: [{ path: "src/config.ts", why: "looks like it holds a credential" }] });
    expect(f.sh(root, "git rev-parse --verify -q HEAD").status).not.toBe(0);
    expect(f.sh(root, "git diff --cached --name-only").stdout.trim()).toBe("");
    expect(f.gh().creates ?? 0).toBe(0);
    // The owner moves the secret out; the retry resumes in the repository this bootstrap started.
    f.sh(root, "rm src/config.ts");
    expect((await f.projectGit.bootstrap({ hostId: "h1", root })).ok).toBe(true);
    expect(tracked(f, root)).toEqual([".gitignore", "ok.txt"]);
  });

  it("keeps the local commit when gh is not signed in and continues after sign-in", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ authed: false });
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: false, stage: "auth", code: "no_provider_auth" });
    const commit = f.sh(root, "git rev-parse HEAD").stdout.trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    f.gh({ authed: true });
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: true, commit });
    expect(f.gh().creates).toBe(1);
  });

  it("adopts the repository a lost create answer made instead of creating a second one", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ loseAck: true });
    expect((await f.projectGit.bootstrap({ hostId: "h1", root })).ok).toBe(true);
    expect(f.gh().creates).toBe(1);
  });

  it("after a crash between create and readback, the retry adopts its own repository", async () => {
    const f = makeFixture();
    const root = project(f);
    const call = f.host.call.bind(f.host);
    let created = false;
    f.host.call = async (method, input, options) => {
      if (created && input.command.startsWith("gh api 'repos/")) throw new Error("host offline");
      const ran = await call(method, input, options);
      if (input.command.startsWith("gh repo create")) created = true;
      return ran;
    };
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: false, stage: "repo", code: "readback_failed" });
    f.host.call = call;
    expect((await f.projectGit.bootstrap({ hostId: "h1", root })).ok).toBe(true);
    expect(f.gh().creates).toBe(1);
  });

  it("resumes at the push after a host outage, with one repository and one commit", async () => {
    const f = makeFixture();
    const root = project(f);
    const call = f.host.call.bind(f.host);
    f.host.call = async (method, input, options) => {
      if (/ push -u origin/.test(input.command)) throw new Error("host offline");
      return call(method, input, options);
    };
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: false, stage: "push", code: "push_failed" });
    f.host.call = call;
    expect((await f.projectGit.bootstrap({ hostId: "h1", root })).ok).toBe(true);
    expect(f.gh().creates).toBe(1);
    expect(f.sh(root, "git rev-list --count HEAD").stdout.trim()).toBe("1");
  });

  it("refuses a public readback, a taken name, an existing origin and a live run", async () => {
    const f = makeFixture();
    const root = project(f);
    f.gh({ forcePublic: true });
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: false, stage: "repo", code: "readback_mismatch" });
    expect(f.sh(root, "git remote").stdout.trim()).toBe("");

    const g = makeFixture();
    const taken = g.folder("taken", { "a.txt": "a" });
    g.gh({ repos: { "octo/taken": { id: 7, private: true, bare: join(g.base, "x.git"), created_at: "2020-01-01T00:00:00Z" } } });
    expect(await g.projectGit.bootstrap({ hostId: "h1", root: taken })).toMatchObject({ ok: false, code: "remote_name_taken" });
    expect(g.gh().creates ?? 0).toBe(0);

    const owned = g.folder("owned", { "a.txt": "a" });
    g.sh(owned, "git init -q && git add . && git commit -qm init && git remote add origin https://github.com/someone/else.git");
    expect(await g.projectGit.bootstrap({ hostId: "h1", root: owned })).toMatchObject({ ok: false, code: "already_has_origin" });
    expect(g.sh(owned, "git remote get-url origin").stdout.trim()).toBe("https://github.com/someone/else.git");

    const busy = g.folder("busy", { "a.txt": "a" });
    g.live.runId = "lprun_1";
    expect(await g.projectGit.bootstrap({ hostId: "h1", root: busy })).toMatchObject({ ok: false, stage: "guard", code: "live_run_active" });
    expect(existsSync(join(busy, ".git"))).toBe(false);
  });

  it("publishes an existing local repository without a new commit, and never baselines someone's empty one", async () => {
    const f = makeFixture();
    const root = f.folder("local", { "a.txt": "a" });
    f.sh(root, "git init -q && git add . && git commit -qm mine");
    const mine = f.sh(root, "git rev-parse HEAD").stdout.trim();
    expect(await f.projectGit.bootstrap({ hostId: "h1", root })).toMatchObject({ ok: true, commit: mine });
    expect(f.sh(root, "git rev-list --count HEAD").stdout.trim()).toBe("1");

    const empty = f.folder("empty-repo", { "a.txt": "a" });
    f.sh(empty, "git init -q");
    expect(await f.projectGit.bootstrap({ hostId: "h1", root: empty })).toMatchObject({ ok: false, code: "unborn_repo" });
  });
});
