import type { ServerCore } from "../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";
import { runOnHost } from "@lane-pilot/host-calls";

/**
 * The files `git status` lists in a checkout, read on the machine that holds it (the PM's environment may sit on another
 * host than the hub, so the hub never runs git on its path). Null when the host could not say: no snapshot then, and no
 * false «helper edited files» from a half-read one.
 */
export async function gitRepoStatus(host: ServerCore["host"], hostId: string, cwd: string): Promise<Set<string> | null> {
  const ran = await bestEffort(console.warn, `repo status ${hostId} ${cwd}`, runOnHost(host, { hostId, cwd, command: "git status --porcelain -uall", timeoutSec: 30, timeoutMs: 45_000 }), null);
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

/**
 * Files Lane Pilot's own graph actions wrote into a checkout (`fs.write`), by checkout and time. Another run's read-only helper in the
 * same checkout must not be blamed for them (hub 2026-11-09: two parallel «Штурм идеи» runs failed `repo_edited` on the guidance file
 * a third run had just saved). Kept in memory for an hour: a helper's window is shorter, and a reload loses only that hour.
 */
const ENGINE_WRITES_TTL_MS = 60 * 60_000;
const engineWrites = new Map<string, Map<string, number>>();

const checkoutKey = (path: string) => path.replace(/\/+$/, "");

export function noteEngineWrite(checkoutPath: string, file: string, at = Date.now()): void {
  const key = checkoutKey(checkoutPath), files = engineWrites.get(key) ?? new Map<string, number>();
  for (const [name, when] of files) if (at - when > ENGINE_WRITES_TTL_MS) files.delete(name);
  files.set(file.replace(/^\.?\/+/, ""), at);
  engineWrites.set(key, files);
}

export function writtenByEngineSince(checkoutPath: string, since: number): Set<string> {
  return new Set([...(engineWrites.get(checkoutKey(checkoutPath)) ?? new Map<string, number>())].filter(([, when]) => when >= since).map(([name]) => name));
}
