import { mkdtemp, rm, statfs, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnAsync } from "@lane-pilot/kit";
import { integrateWorktree } from "./git-integrate";

export type DrillCheck = { name:string; ok:boolean; detail:string | null };

/**
 * A fire drill on a scratch repository (Principles of Chaos): the faults seen live — a stale index.lock, a merge cut
 * off midway — are planted, and Lane Pilot's own recovery must merge anyway. Nothing outside a temp dir is touched.
 */
export async function runStabilityDrill():Promise<DrillCheck[]> {
  const root = await mkdtemp(join(tmpdir(), "lp-drill-"));
  const git = async (cwd:string, ...args:string[]) => {
    const ran = await spawnAsync("git", ["-c", "user.name=drill", "-c", "user.email=drill@local", ...args], { cwd });
    if (ran.error || ran.status !== 0) throw new Error(`git ${args[0]} failed: ${ran.error?.message ?? ran.stderr.trim()}`);
    return ran.stdout;
  };
  const aged = async (path:string, seconds:number) => { const at = new Date(Date.now() - seconds * 1000); await utimes(path, at, at); };
  const checks:DrillCheck[] = [];
  const check = async (name:string, work:() => Promise<string | null>) => {
    try { const detail = await work(); checks.push({ name, ok:detail === null, detail }); }
    catch (cause) { checks.push({ name, ok:false, detail:cause instanceof Error ? cause.message.slice(0, 300) : String(cause) }); }
  };
  try {
    const base = join(root, "main");
    await git(root, "init", "-q", "-b", "main", base);
    await writeFile(join(base, "a.txt"), "one\n");
    await git(base, "add", "-A"); await git(base, "commit", "-qm", "base");
    const worktree = async (name:string, file:string) => {
      const path = join(root, name);
      await git(base, "worktree", "add", "-q", "-b", `drill/${name}`, path, "main");
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
      await git(side, "commit", "-qam", "side");
      await writeFile(join(base, "a.txt"), "two\n"); await git(base, "commit", "-qam", "main");
      // The conflict leaves MERGE_HEAD, as a killed merge would.
      await git(base, "merge", "--no-edit", "drill/w2").catch(() => undefined);
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
