import type { RollbackApi } from "./rollback";

export const ROLLBACK_USAGE = [
  "bb lane-pilot reverify <task-id|attempt-id>   (the task's verification[] again on its recorded base plus the accepted change, fresh worktree; exit 0 only when every item passes)",
  "bb lane-pilot revert <task-id> [--dry-run] [--no-gate]   (git revert of the task's merge commits in a worktree, checked, merged through the normal merge queue; refuses with the next step when later commits touch the same lines)",
  "bb lane-pilot changes <task-id|attempt-id>   (what is on record: each attempt's base, merge, changed files with deletions, and the receipts)",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

/** `reverify`, `revert` and `changes`: one command each, no prompts; the answer is JSON and the exit code says whether it held. */
export async function runRollbackCli(api: RollbackApi, command: "reverify" | "revert" | "changes", argv: string[]): Promise<Result> {
  try {
    const flags = argv.filter((word) => word.startsWith("--"));
    const positional = argv.filter((word) => !word.startsWith("--"));
    const known = command === "revert" ? ["--dry-run", "--no-gate"] : [];
    const unknown = flags.filter((flag) => !known.includes(flag));
    if (unknown.length || positional.length !== 1) throw new Error(`usage:\n${ROLLBACK_USAGE}`);
    const ref = positional[0]!;
    if (command === "changes") return { exitCode: 0, stdout: JSON.stringify(api.status(ref), null, 2) };
    const result = command === "reverify" ? await api.reverify(ref) : await api.revert(ref, { dryRun: flags.includes("--dry-run"), skipGate: flags.includes("--no-gate") });
    return { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
