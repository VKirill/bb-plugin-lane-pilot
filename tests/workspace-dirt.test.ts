import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_DIRT_SCRIPT } from "../src/workspace-dirt";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  const ran = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding:"utf8" });
  if (ran.status !== 0) throw new Error(ran.stderr);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "lane-pilot-dirt-"));
  roots.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "a.txt"), "a\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "init");
  return root;
}

function dirt(cwd: string): Array<{ path:string; sha256:string }> {
  const ran = spawnSync("python3", ["-c", WORKSPACE_DIRT_SCRIPT], { cwd, encoding:"utf8" });
  if (ran.status !== 0) throw new Error(ran.stderr);
  return JSON.parse(ran.stdout) as Array<{ path:string; sha256:string }>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive:true, force:true });
});

describe("workspace dirt snapshot", () => {
  it("hashes an untracked symlink by its target, including a dangling one", () => {
    const root = repo();
    mkdirSync(join(root, "skills"));
    writeFileSync(join(root, "skills", "x.md"), "x\n");
    git(root, "add", "skills");
    git(root, "commit", "-qm", "skills");
    symlinkSync("skills", join(root, "tga"));
    symlinkSync("missing", join(root, "dangling"));
    const before = dirt(root);
    expect(before.map((row) => row.path)).toEqual(["dangling", "tga"]);
    expect(before.every((row) => row.sha256.length === 64)).toBe(true);
    rmSync(join(root, "tga"));
    symlinkSync("elsewhere", join(root, "tga"));
    expect(dirt(root).find((row) => row.path === "tga")?.sha256).not.toBe(before[1].sha256);
  });

  it("fingerprints a nested repository by its HEAD and status", () => {
    const root = repo();
    const nested = join(root, "scratchpad", "wt-main");
    mkdirSync(nested, { recursive:true });
    git(nested, "init", "-q");
    writeFileSync(join(nested, "n.txt"), "n\n");
    git(nested, "add", "n.txt");
    git(nested, "commit", "-qm", "nested");
    const before = dirt(root);
    expect(before.map((row) => row.path)).toEqual(["scratchpad/wt-main/"]);
    expect(before[0].sha256).toHaveLength(64);
    expect(dirt(root)).toEqual(before);
    writeFileSync(join(nested, "n.txt"), "changed\n");
    expect(dirt(root)[0].sha256).not.toBe(before[0].sha256);
  });

  it("keeps both paths of a rename that was modified after staging", () => {
    const root = repo();
    git(root, "mv", "a.txt", "b.txt");
    writeFileSync(join(root, "b.txt"), "b\n");
    const rows = dirt(root);
    expect(rows.map((row) => row.path)).toEqual(["a.txt", "b.txt"]);
    expect(rows[0].sha256).toBe("");
    expect(rows[1].sha256).toHaveLength(64);
  });
});
