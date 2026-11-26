import type { WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { WORKTREE_CLEANUP_USAGE } from "../../models/worktree-cleanup";
import { runWorktreeCleanupPass } from "../services/worktree-daily-pass";
import type { AttemptSweeps } from "../services/worktree-janitor";

/**
 * The code step of the graph lp.worktree-cleanup (the body of the two system schedules): `pass` hourly or daily, `dry_run` reads only. An `error`
 * status fails the scheduled run (live_success), so the board shows it and its pause-after-N rule applies.
 */
export function registerWorktreeCleanupActions(engine: WorkflowEngine, ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps): void {
  engine.register<ChainRuntime>("lp.worktree_cleanup", {
    reentrant: true,
    run: async (c) => {
      const out = await runWorktreeCleanupPass(ctx, sweeps, { pass: String(c.resolve("$inputs.pass") ?? "hourly") === "daily" ? "daily" : "hourly", dryRun: c.resolve("$inputs.dry_run") === true });
      return { output: { status: out.status, removed: out.removed, freed_bytes: Math.round(out.freedBytes), kept: out.kept, hourly_removed: out.hourlyRemoved ?? [], hourly_tmp_removed: out.hourlyTmpRemoved ?? [], report: out.report.slice(0, 16_000) } };
    },
  });
}

/**
 * `bb lane-pilot worktree-cleanup`: the pass the system schedules run, by hand, with its report printed. Without flags the hourly sweep; `--daily`
 * the daily pass; `--dry-run` the daily pass deciding only (nothing removed, no janitor row, no owner line). Exit 1 when the pass ended `error`.
 */
export async function runWorktreeCleanupCli(ctx: Pick<ServerCore, "bb" | "db" | "log" | "isDisposed" | "host">, sweeps: AttemptSweeps, args: string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const unknown = args.filter((arg) => !["--daily", "--dry-run", "--json"].includes(arg));
  if (unknown.length) return { exitCode: 2, stderr: `unknown argument ${unknown[0]}\nusage: ${WORKTREE_CLEANUP_USAGE}` };
  const out = await runWorktreeCleanupPass(ctx, sweeps, { pass: args.includes("--daily") ? "daily" : "hourly", dryRun: args.includes("--dry-run") });
  const stdout = args.includes("--json")
    ? JSON.stringify({ pass: out.pass, dry_run: out.dryRun, status: out.status, removed: out.removed, freed_bytes: Math.round(out.freedBytes), kept: out.kept, hourly_removed: out.hourlyRemoved ?? [], hourly_tmp_removed: out.hourlyTmpRemoved ?? [], report: out.report,
      ...(out.decisions ? { decisions: out.decisions } : {}), ...(out.search ? { search: out.search } : {}) }, null, 2)
    : `${out.pass}${out.dryRun ? " (dry run)" : ""}: ${out.status}\n${out.report}`;
  return { exitCode: out.status === "error" ? 1 : 0, stdout };
}
