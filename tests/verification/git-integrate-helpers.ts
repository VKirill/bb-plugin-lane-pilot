import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

export async function repo() {
  const base = join(await mkdtemp(join(tmpdir(), "lp-integrate-")), "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const worktree = async (name: string) => {
    const path = join(base, "..", name);
    git(base, "worktree", "add", "-q", "-b", `bb/${name}`, path, "main");
    return path;
  };
  return { base, worktree };
}
