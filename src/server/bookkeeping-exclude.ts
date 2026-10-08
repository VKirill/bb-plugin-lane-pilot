import { BOOKKEEPING_EXCLUDE_LINES } from "@lane-pilot/settings-catalog";
import { EXCLUDE_ADDED, ensureExcludeLinesCommand } from "../verification/git-integrate";

type RunCommand = (input:{ requestedHostId:string; cwd:string; command:string; timeoutSec:number }) => Promise<{ exitCode:number; stdout:string; stderr:string }>;

/**
 * Adds the bookkeeping folders that do not belong in history to the project's `.git/info/exclude` on the workspace's
 * machine, only the lines that are missing. Returns the lines it added, none when the project is not a git
 * repository, already has them, or the machine could not be asked: activation never fails on this.
 */
export async function excludeBookkeeping(runCommand:RunCommand, hostId:string, workspacePath:string, log:(message:string) => void):Promise<string[]> {
  try {
    const ran = await runCommand({ requestedHostId:hostId, cwd:workspacePath, command:ensureExcludeLinesCommand(BOOKKEEPING_EXCLUDE_LINES), timeoutSec:30 });
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `git exited ${ran.exitCode}`);
    const added = ran.stdout.split("\n").filter((line) => line.startsWith(EXCLUDE_ADDED)).map((line) => line.slice(EXCLUDE_ADDED.length));
    if (added.length) log(`Lane Pilot added bookkeeping paths to .git/info/exclude of ${workspacePath}: ${added.join(", ")}`);
    return added;
  } catch (cause) {
    log(`Lane Pilot could not update .git/info/exclude of ${workspacePath}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return [];
  }
}
