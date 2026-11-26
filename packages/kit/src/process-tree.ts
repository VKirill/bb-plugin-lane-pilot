import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], { timeout: 2000 });
    const childrenByParent = new Map<number, number[]>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || pid <= 0) continue;
      const list = childrenByParent.get(ppid);
      if (list) list.push(pid);
      else childrenByParent.set(ppid, [pid]);
    }
    const ordered: number[] = [];
    const seen = new Set<number>();
    const visit = (pid: number) => {
      if (seen.has(pid)) return;
      seen.add(pid);
      for (const child of childrenByParent.get(pid) ?? []) visit(child);
      ordered.push(pid);
    };
    visit(rootPid);
    return ordered;
  } catch {
    return isPidAlive(rootPid) ? [rootPid] : [];
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Ignore when pid is not a process-group leader.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process may have exited already.
  }
}

/**
 * Kills a process and its entire child tree (descendants first, process group + direct PID, SIGTERM then SIGKILL).
 * Returns the number of live PIDs that were terminated.
 */
export async function killProcessTree(rootPid: number, graceMs = 150): Promise<number> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return 0;
  const targets = (await listDescendantPids(rootPid)).filter(isPidAlive);
  if (targets.length === 0) return 0;
  for (const pid of targets) trySignal(pid, "SIGTERM");
  const deadline = Date.now() + Math.max(20, graceMs);
  while (Date.now() < deadline) {
    if (!targets.some(isPidAlive)) return targets.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  for (const pid of targets) {
    if (isPidAlive(pid)) trySignal(pid, "SIGKILL");
  }
  const killDeadline = Date.now() + 100;
  while (Date.now() < killDeadline && targets.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return targets.length;
}
