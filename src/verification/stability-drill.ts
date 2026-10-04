import { execFileSync } from "node:child_process";
import { mkdtemp, rm, statfs, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrateWorktree } from "./git-integrate";

export type DrillCheck = { name:string; ok:boolean; detail:string | null };

/**
 * A fire drill on a scratch repository (Principles of Chaos): the faults seen live — a stale index.lock, a merge cut
 * off midway — are planted, and Lane Pilot's own recovery must merge anyway. Nothing outside a temp dir is touched.
 */
export async function runStabilityDrill():Promise<DrillCheck[]> {
  const root = await mkdtemp(join(tmpdir(), "lp-drill-"));
  const git = (cwd:string, ...args:string[]) => execFileSync("git", ["-c", "user.name=drill", "-c", "user.email=drill@local", ...args], { cwd, encoding:"utf8", stdio:["ignore", "pipe", "pipe"] });
  const aged = async (path:string, seconds:number) => { const at = new Date(Date.now() - seconds * 1000); await utimes(path, at, at); };
  const checks:DrillCheck[] = [];
  const check = async (name:string, work:() => Promise<string | null>) => {
    try { const detail = await work(); checks.push({ name, ok:detail === null, detail }); }
    catch (cause) { checks.push({ name, ok:false, detail:cause instanceof Error ? cause.message.slice(0, 300) : String(cause) }); }
  };
  try {
    const base = join(root, "main");
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    await writeFile(join(base, "a.txt"), "one\n");
    git(base, "add", "-A"); git(base, "commit", "-qm", "base");
    const worktree = async (name:string, file:string) => {
      const path = join(root, name);
      git(base, "worktree", "add", "-q", "-b", `drill/${name}`, path, "main");
      await writeFile(join(path, file), `${name}\n`);
      return path;
    };
    await check("stale index.lock is moved aside and the merge lands", async () => {
      const path = await worktree("w1", "b.txt");
      await writeFile(join(base, ".git", "index.lock"), "");
      await aged(join(base, ".git", "index.lock"), 3600);
      const merged = await integrateWorktree({ basePath:base, worktreePath:path, message:"drill w1" });
      return merged.status === "merged" ? null : `merge ended ${merged.status}: ${merged.reason ?? ""}`;
    });
    await check("a merge cut off midway is aborted and the next merge lands", async () => {
      const side = await worktree("w2", "a.txt");
      git(side, "commit", "-qam", "side");
      await writeFile(join(base, "a.txt"), "two\n"); git(base, "commit", "-qam", "main");
      try { git(base, "merge", "--no-edit", "drill/w2"); } catch { /* the conflict leaves MERGE_HEAD, as a killed merge would */ }
      await aged(join(base, ".git", "MERGE_HEAD"), 3600);
      const path = await worktree("w3", "c.txt");
      const merged = await integrateWorktree({ basePath:base, worktreePath:path, message:"drill w3" });
      return merged.status === "merged" ? null : `merge ended ${merged.status}: ${merged.reason ?? ""}`;
    });
    await check("free disk space is readable", async () => {
      const stats = await statfs(root);
      return stats.blocks > 0 ? null : "statfs returned no blocks";
    });
  } finally {
    await rm(root, { recursive:true, force:true }).catch(() => undefined);
  }
  return checks;
}
