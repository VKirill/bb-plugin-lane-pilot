import type { ServerCore } from "./core";

/**
 * The files `git status` lists in a checkout, read on the machine that holds it (the PM's environment may sit on another
 * host than the hub, so the hub never runs git on its path). Null when the host could not say: no snapshot then, and no
 * false «helper edited files» from a half-read one.
 */
export async function gitRepoStatus(host: ServerCore["host"], hostId: string, cwd: string): Promise<Set<string> | null> {
  const ran = await host.call("runCommand", { requestedHostId: hostId, command: "git status --porcelain -uall", cwd, timeoutSec: 30 }, { hostId, timeoutMs: 45_000 })
    .catch(() => null);
  if (!ran || ran.exitCode !== 0) return null;
  const files = new Set<string>();
  for (const line of ran.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const name = trimmed.slice(2).trim();
    if (name) files.add(name.split(" -> ").pop()!.trim());
  }
  return files;
}

export function detectRepoEdits(before: Set<string>, after: Set<string>, allowed: (file: string) => boolean): string[] {
  const changed: string[] = [];
  for (const file of after) {
    if (!before.has(file) && !allowed(file)) {
      changed.push(file);
    }
  }
  return changed.sort();
}
