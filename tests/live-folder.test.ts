import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommandOnHost } from "../src/cli-run";
import { attemptProduced } from "../src/cli-outcome";
import { createRun, openDatabase } from "../src/database";
import {
  chunkPaths, classifyFolderProbe, liveOwnedFiles, LIVE_BACKUP_SCRIPT, LIVE_FOLDER_BIG_BYTES, LIVE_FOLDER_FILE_CAP, LIVE_SNAPSHOT_SCRIPT, LIVE_SNAPSHOT_SKIP_DIRS,
  LIVE_SNAPSHOT_SKIP_PATHS, liveSnapshotCommand, parseLiveSnapshot, pythonCommand,
} from "../src/live-folder";
import { createLiveFolder } from "../src/server/writer/live-folder";

const roots: string[] = [];
const realHome = process.env.HOME;

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lane-pilot-${prefix}-`));
  roots.push(root);
  return root;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** The host's own runCommand handler, against real folders; HOME is a temp folder so backups never touch the real one. */
function env() {
  const home = temp("home");
  process.env.HOME = home;
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const calls: string[] = [];
  const host = {
    call: async (method: string, input: { requestedHostId: string; command: string; cwd: string; timeoutSec?: number }) => {
      calls.push(method);
      if (method !== "runCommand") throw new Error(`unexpected host call ${method}`);
      return runCommandOnHost(input);
    },
  };
  const live = createLiveFolder({ bb, db, host } as never);
  return { home, db, calls, live, backups: join(home, ".lane-pilot", "live-backups") };
}

beforeEach(() => { process.env.HOME = realHome; });
afterEach(() => {
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function snapshot(folder: string, command = liveSnapshotCommand()) {
  return runCommandOnHost({ requestedHostId: "h", cwd: folder, command });
}

describe("detection", () => {
  it("reads git's answers: a work tree, a plain folder, a missing git, anything else is unknown", () => {
    expect(classifyFolderProbe({ exitCode: 0, stderr: "" })).toBe("git");
    expect(classifyFolderProbe({ exitCode: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" })).toBe("no-git");
    expect(classifyFolderProbe({ exitCode: 127, stderr: "git: command not found" })).toBe("no-git");
    // «dubious ownership» is also 128: a real repository the machine will not read is not a folder without git.
    expect(classifyFolderProbe({ exitCode: 128, stderr: "fatal: detected dubious ownership in repository" })).toBe("unknown");
    expect(classifyFolderProbe({ exitCode: 124, stderr: "" })).toBe("unknown");
    expect(classifyFolderProbe(null)).toBe("unknown");
  });

  it("asks the folder's own host, tells a plain folder from a repository, and keeps the answer per run", async () => {
    const { db, calls, live } = env();
    const plain = temp("plain");
    const repo = temp("repo");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    createRun(db, "r-plain", "P", "bb", plain);
    createRun(db, "r-repo", "P", "bb", repo);
    expect(await live.isLiveFolder("r-plain", "h", plain)).toBe(true);
    expect(await live.isLiveFolder("r-repo", "h", repo)).toBe(false);
    expect(calls).toEqual(["runCommand", "runCommand"]);
    // Asked again, the run answers from its stored kind: even a `git init` mid-run cannot change the baseline kind.
    spawnSync("git", ["init", "-q"], { cwd: plain });
    expect(await live.isLiveFolder("r-plain", "h", plain)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("never asks about another path of the run (a worktree is git by construction) and answers unknown as git", async () => {
    const { db, calls, live } = env();
    const plain = temp("plain");
    createRun(db, "r", "P", "bb", plain);
    expect(await live.isLiveFolder("r", "h", join(plain, "elsewhere"))).toBe(false);
    expect(calls).toEqual([]);
    expect(await live.isLiveFolder("r", "h", join(tmpdir(), "lane-pilot-folder-that-does-not-exist"))).toBe(false);
  });
});

describe("content snapshot", () => {
  it("lists every regular file with a sha256 and skips the noise directories and paths", async () => {
    const root = temp("snap");
    put(root, "a.txt", "a\n");
    put(root, "src/b.ts", "b\n");
    put(root, "src/deep/c.ts", "c\n");
    for (const dir of LIVE_SNAPSHOT_SKIP_DIRS) put(root, `${dir}/x.txt`, "x");
    put(root, "pkg/node_modules/y.js", "y");
    for (const path of LIVE_SNAPSHOT_SKIP_PATHS) put(root, `${path}/x.json`, "x");
    put(root, ".agents/plans/p.md", "keep");
    put(root, "sub/.git", "gitdir: elsewhere");
    put(root, "sub/kept.txt", "kept");
    const ran = await snapshot(root);
    expect(ran.exitCode).toBe(0);
    const parsed = parseLiveSnapshot(ran);
    expect(parsed.ok && parsed.snapshots.map((row) => row.path)).toEqual([".agents/plans/p.md", "a.txt", "src/b.ts", "src/deep/c.ts", "sub/kept.txt"]);
    expect(parsed.ok && parsed.snapshots.every((row) => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);
  });

  it("hashes a symlink by its target, and a file above the size limit by size and mtime", async () => {
    const root = temp("snap");
    put(root, "big.bin", "0123456789");
    put(root, "real.txt", "r");
    symlinkSync("real.txt", join(root, "link"));
    symlinkSync("missing", join(root, "dangling"));
    const command = pythonCommand(LIVE_SNAPSHOT_SCRIPT, { skip_dirs: [], skip_paths: [], cap: 100, big: 5 });
    const first = parseLiveSnapshot(await snapshot(root, command));
    expect(first.ok && first.snapshots.map((row) => row.path)).toEqual(["big.bin", "dangling", "link", "real.txt"]);
    utimesSync(join(root, "big.bin"), 1, 1);
    const second = parseLiveSnapshot(await snapshot(root, command));
    const hash = (rows: typeof first, path: string) => rows.ok ? rows.snapshots.find((row) => row.path === path)?.sha256 : undefined;
    expect(hash(second, "big.bin")).not.toBe(hash(first, "big.bin"));
    expect(hash(second, "real.txt")).toBe(hash(first, "real.txt"));
  });

  it("fails above the file cap with the reason the owner reads", async () => {
    const root = temp("snap");
    for (const name of ["a", "b", "c"]) put(root, name, name);
    const ran = await snapshot(root, liveSnapshotCommand(2));
    expect(ran.exitCode).toBe(3);
    expect(parseLiveSnapshot(ran)).toEqual({ ok: false, reason: "folder too large for no-git mode: 3 files; put it under git" });
    expect(LIVE_FOLDER_FILE_CAP).toBe(50_000);
    expect(LIVE_FOLDER_BIG_BYTES).toBe(20 * 1024 * 1024);
  });

  it("reports an unreadable answer instead of throwing", () => {
    expect(parseLiveSnapshot({ exitCode: 1, stdout: "", stderr: "boom" })).toEqual({ ok: false, reason: "cannot snapshot the folder (no git): boom" });
    expect(parseLiveSnapshot({ exitCode: 0, stdout: "not json", stderr: "" }).ok).toBe(false);
    expect(parseLiveSnapshot({ exitCode: 0, stdout: "[1]", stderr: "" }).ok).toBe(false);
  });

  it("makes the added, changed and removed files the produced paths, and nothing else", async () => {
    const root = temp("snap");
    put(root, "keep.txt", "k");
    put(root, "edit.txt", "old");
    put(root, "gone.txt", "g");
    const rows = async () => {
      const parsed = parseLiveSnapshot(await snapshot(root));
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.snapshots;
    };
    const before = await rows();
    put(root, "edit.txt", "new");
    put(root, "added/new.txt", "n");
    rmSync(join(root, "gone.txt"));
    expect(attemptProduced(await rows(), before).sort()).toEqual(["added/new.txt", "edit.txt", "gone.txt"]);
    expect(attemptProduced(before, before)).toEqual([]);
  });
});

describe("owned files and chunks", () => {
  it("picks the files owns_paths names and never_touch leaves out", () => {
    const task = { owns_paths: ["src/", "README.md"], never_touch: ["src/secret/**"] };
    expect(liveOwnedFiles(["src/a.ts", "src/secret/k.ts", "README.md", "other.md"], task)).toEqual(["src/a.ts", "README.md"]);
  });

  it("splits a long path list so each part fits one command line", () => {
    const paths = Array.from({ length: 5000 }, (_, index) => `some/long/folder/name/file-${index}.txt`);
    const chunks = chunkPaths(paths);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(paths);
    expect(chunks.every((chunk) => JSON.stringify(chunk).length < 60_000)).toBe(true);
    expect(chunkPaths([])).toEqual([]);
  });
});

describe("backup and rollback", () => {
  async function prepared() {
    const e = env();
    const folder = temp("work");
    put(folder, "src/a.ts", "a-old\n");
    put(folder, "src/b.ts", "b-old\n");
    put(folder, "src/deleted.ts", "d-old\n");
    put(folder, "docs/readme.md", "docs-old\n");
    const task = { owns_paths: ["src/"], never_touch: [] };
    const before = await e.live.liveSnapshot("h", folder);
    if (!before.ok) throw new Error(before.reason);
    const owned = liveOwnedFiles(before.paths, task);
    const saved = await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", files: owned });
    return { ...e, folder, task, owned, saved };
  }

  it("copies exactly the owned files aside, with relative paths", async () => {
    const { folder, owned, saved, backups } = await prepared();
    expect(owned).toEqual(["src/a.ts", "src/b.ts", "src/deleted.ts"]);
    expect(saved).toEqual({ ok: true, count: 3 });
    expect(readFileSync(join(backups, "lpattempt_one", "files", "src", "a.ts"), "utf8")).toBe("a-old\n");
    expect(existsSync(join(backups, "lpattempt_one", "files", "docs"))).toBe(false);
    expect(existsSync(join(folder, "src", "a.ts"))).toBe(true);
  });

  it("puts changed and deleted owned files back, removes what the writer created inside owns_paths, and leaves the rest", async () => {
    const { live, folder, task, backups } = await prepared();
    put(folder, "src/a.ts", "a-new\n");
    rmSync(join(folder, "src", "deleted.ts"));
    put(folder, "src/created.ts", "created\n");
    put(folder, "docs/readme.md", "docs-by-the-writer\n");
    put(folder, "outside.txt", "outside\n");
    put(folder, ".agents/plans/items/t/logs/check.log", "log\n");
    const rolled = await live.restoreLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", task });
    expect(rolled).toEqual({ ok: true, restored: ["src/a.ts", "src/deleted.ts"], removed: ["src/created.ts"], failed: [] });
    expect(readFileSync(join(folder, "src", "a.ts"), "utf8")).toBe("a-old\n");
    expect(readFileSync(join(folder, "src", "deleted.ts"), "utf8")).toBe("d-old\n");
    expect(readFileSync(join(folder, "src", "b.ts"), "utf8")).toBe("b-old\n");
    expect(existsSync(join(folder, "src", "created.ts"))).toBe(false);
    // Never rm: with no agent-trash on the host the created file moves into the backup folder.
    expect(readFileSync(join(backups, "lpattempt_one", "created", "src", "created.ts"), "utf8")).toBe("created\n");
    // Outside owns_paths nothing is rolled back; Lane Pilot's own task-folder files are not the writer's creation.
    expect(readFileSync(join(folder, "docs", "readme.md"), "utf8")).toBe("docs-by-the-writer\n");
    expect(existsSync(join(folder, "outside.txt"))).toBe(true);
    expect(existsSync(join(folder, ".agents", "plans", "items", "t", "logs", "check.log"))).toBe(true);
  });

  it("hands a created file to agent-trash when the host has it", async () => {
    const { live, folder, task, home } = await prepared();
    mkdirSync(join(home, ".agents", "bin"), { recursive: true });
    const trash = join(home, ".agents", "bin", "agent-trash");
    writeFileSync(trash, `#!/bin/sh\necho "$@" >> "${join(home, "trashed.log")}"\nshift 2\nmv "$1" "${join(home, "trash-can")}"\n`);
    chmodSync(trash, 0o755);
    mkdirSync(join(home, "trash-can"));
    put(folder, "src/created.ts", "created\n");
    const rolled = await live.restoreLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", task });
    expect(rolled).toMatchObject({ ok: true, removed: ["src/created.ts"] });
    expect(readFileSync(join(home, "trashed.log"), "utf8")).toContain("-f --");
    expect(existsSync(join(folder, "src", "created.ts"))).toBe(false);
    expect(existsSync(join(home, "trash-can", "created.ts"))).toBe(true);
  });

  it("keeps the first backup when the same attempt is backed up again, so a resume cannot overwrite the originals", async () => {
    const { live, folder, owned } = await prepared();
    put(folder, "src/a.ts", "a-changed-by-the-writer\n");
    expect(await live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", files: owned })).toMatchObject({ ok: true });
    const rolled = await live.restoreLiveFolder({ hostId: "h", folder, backupId: "lpattempt_one", task: { owns_paths: ["src/"], never_touch: [] } });
    expect(rolled).toMatchObject({ ok: true, restored: ["src/a.ts"] });
    expect(readFileSync(join(folder, "src", "a.ts"), "utf8")).toBe("a-old\n");
  });

  it("restores symlinks as symlinks", async () => {
    const e = env();
    const folder = temp("work");
    put(folder, "src/real.ts", "r\n");
    symlinkSync("real.ts", join(folder, "src", "link.ts"));
    const task = { owns_paths: ["src/"], never_touch: [] };
    await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_link", files: ["src/real.ts", "src/link.ts"] });
    rmSync(join(folder, "src", "link.ts"));
    put(folder, "src/link.ts", "now a file\n");
    expect(await e.live.restoreLiveFolder({ hostId: "h", folder, backupId: "lpattempt_link", task })).toMatchObject({ ok: true, restored: ["src/link.ts"] });
    expect(spawnSync("readlink", [join(folder, "src", "link.ts")], { encoding: "utf8" }).stdout.trim()).toBe("real.ts");
  });

  it("backs up in chunks when the owned list does not fit one command", async () => {
    const e = env();
    const folder = temp("work");
    const names = Array.from({ length: 1500 }, (_, index) => `src/${"d".repeat(40)}/file-${index}.txt`);
    for (const name of names.slice(0, 1500)) put(folder, name, name);
    expect(chunkPaths(names).length).toBeGreaterThan(1);
    expect(await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_big", files: names })).toEqual({ ok: true, count: 1500 });
    for (const name of names.slice(0, 1500)) rmSync(join(folder, name));
    const rolled = await e.live.restoreLiveFolder({ hostId: "h", folder, backupId: "lpattempt_big", task: { owns_paths: ["src/"], never_touch: [] } });
    expect(rolled).toMatchObject({ ok: true, failed: [] });
    expect(rolled.ok && rolled.restored).toHaveLength(1500);
  });

  it("prunes backups older than seven days when it makes a new one, and only those", async () => {
    const { backups, live, folder } = await prepared();
    mkdirSync(join(backups, "lpattempt_old"), { recursive: true });
    mkdirSync(join(backups, "lpattempt_recent"), { recursive: true });
    const eight = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(join(backups, "lpattempt_old"), eight, eight);
    await live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_two", files: ["src/a.ts"] });
    expect(existsSync(join(backups, "lpattempt_old"))).toBe(false);
    expect(existsSync(join(backups, "lpattempt_recent"))).toBe(true);
    expect(existsSync(join(backups, "lpattempt_one"))).toBe(true);
    expect(existsSync(join(backups, "lpattempt_two"))).toBe(true);
  });

  it("refuses a backup id or path that could leave the backup folder", async () => {
    const e = env();
    const folder = temp("work");
    put(folder, "a.txt", "a");
    expect((await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "../escape", files: ["a.txt"] })).ok).toBe(false);
    expect((await e.live.backupLiveFolder({ hostId: "h", folder, backupId: "lpattempt_x", files: ["../a.txt"] })).ok).toBe(false);
  });

  it("will not restore one folder's backup into another folder", async () => {
    const { live, task } = await prepared();
    const other = temp("other");
    const rolled = await live.restoreLiveFolder({ hostId: "h", folder: other, backupId: "lpattempt_one", task });
    expect(rolled.ok).toBe(false);
  });

  it("rejects a task whose owned files are too heavy to back up", () => {
    const root = temp("heavy");
    put(root, "a.bin", "0123456789");
    const home = temp("home");
    const command = pythonCommand(LIVE_BACKUP_SCRIPT, { id: "lpattempt_heavy", files: ["a.bin"], begin: true, finish: true, keep_days: 7, cap_bytes: 5 });
    const ran = spawnSync("/bin/bash", ["-lc", command], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: home } });
    expect(ran.status).toBe(3);
    expect(ran.stderr).toContain("too_large_backup:10");
  });
});
