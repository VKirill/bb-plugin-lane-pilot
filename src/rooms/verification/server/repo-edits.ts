import type { ServerCore } from "../../core/server";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The files `git status` lists in a checkout, read on the machine that holds it (the PM's environment may sit on another
 * host than the hub, so the hub never runs git on its path). Null when the host could not say: no snapshot then, and no
 * false «helper edited files» from a half-read one.
 */
export async function gitRepoStatus(host: ServerCore["host"], hostId: string, cwd: string): Promise<Set<string> | null> {
  const ran = await runOnHost(host, { hostId, cwd, command: "git status --porcelain -uall", timeoutSec: 30, timeoutMs: 45_000 })
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

/**
 * The edited files the PM's own chat named while a helper ran: the PM works in the same checkout, so what it wrote then is its own,
 * not the helper's (magicseo replay 2026-10-31: the planner failed `repo_edited` on recon samples the PM had put in `.agents/recon/`
 * during the plan, 18 minutes lost). A file counts as named when the chat's text has its path or its folder (deeper than the root).
 */
export function namedByChat(texts: readonly string[], files: readonly string[]): Set<string> {
  const all = texts.join("\n");
  return new Set(files.filter((file) => {
    if (all.includes(file)) return true;
    const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return folder.includes("/") && all.includes(folder);
  }));
}
