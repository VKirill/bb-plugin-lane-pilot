import { orMiss, isNotFound, pluginRootFromModule, stringAt } from "@lane-pilot/kit";
import { closeOwnerItem, postOwnerItem } from "../../owner-waiting";

export const CONFIG_KEY = "self-repair:config";

type LpProjectBb = { sdk?: { projects?: { list?: (query: unknown) => Promise<unknown>; get?: (input: unknown) => Promise<unknown> }; environments?: { list?: (query: unknown) => Promise<unknown> } } };
type LpProjectHost = { call?: (method: string, input: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> } | null;

const lpProjectByBb = new WeakMap<object, { projectId: string; environmentId: string }>();

/** The origin remote of the checkout a path sits in on the given host (git runs on that host, never in the plugin
 *  server), or null when it is not a git checkout — a deployed copy has none. */
async function repoRemote(host: LpProjectHost, hostId: string | undefined, path: string): Promise<string | null> {
  if (!host?.call) return null;
  return await Promise.resolve(host.call("runCommand", { requestedHostId: hostId, cwd: path, timeoutSec: 15, command: "git remote get-url origin" }, { hostId, timeoutMs: 20_000 }))
    .then((out) => stringAt(out, "stdout")?.trim() || null).catch(() => null);
}

const NO_LP_PROJECT_KEY = "lane-pilot:no-project";

/**
 * «The Lane Pilot project» on this install, in one order for every caller: the stored `self-repair:config` ids first
 * (self_repair_configure; on a deployed copy without .git they are the only source), then git identity — a project
 * source whose origin remote, asked on the source's own host, equals the remote of this plugin's checkout (dev
 * checkouts, worktrees, second clones). Null when neither knows it; only a hit is cached.
 */
export async function resolveLanePilotProject(bb: unknown, host: unknown): Promise<{ projectId: string; environmentId: string } | null> {
  const cached = lpProjectByBb.get(bb as object);
  if (cached !== undefined) return cached;
  const stored = (await Promise.resolve((bb as { storage?: { kv?: { get?: (key: string) => Promise<unknown> } } }).storage?.kv?.get?.(CONFIG_KEY) ?? null)
    ) as { projectId?: unknown; environmentId?: unknown } | null;
  const storedProject = typeof stored?.projectId === "string" && stored.projectId ? stored.projectId : "";
  const storedEnvironment = typeof stored?.environmentId === "string" ? stored.environmentId : "";
  if (storedProject) {
    const discovered = storedEnvironment ? null : await discoverLanePilotProject(bb as LpProjectBb, host as LpProjectHost);
    const found = { projectId: storedProject, environmentId: storedEnvironment || (discovered?.projectId === storedProject ? discovered.environmentId : "") };
    lpProjectByBb.set(bb as object, found);
    return found;
  }
  const discovered = await discoverLanePilotProject(bb as LpProjectBb, host as LpProjectHost);
  if (!discovered) return null;
  lpProjectByBb.set(bb as object, discovered);
  return discovered;
}

async function discoverLanePilotProject(bb: LpProjectBb, host: LpProjectHost): Promise<{ projectId: string; environmentId: string } | null> {
  const remote = await repoRemote(host, process.env.BB_HOST_ID, pluginRootFromModule(import.meta.url));
  if (!remote) return null;
  const rows = await orMiss(Promise.resolve(bb.sdk?.projects?.list?.({ includePersonal: true }) ?? []), [] as Array<{ id?: unknown }>, isNotFound) as Array<{ id?: unknown }>;
  for (const row of rows) {
    if (typeof row?.id !== "string") continue;
    const project = await orMiss(Promise.resolve(bb.sdk?.projects?.get?.({ projectId: row.id }) ?? null), null, isNotFound) as { sources?: Array<{ hostId?: unknown; path?: unknown }> } | null;
    for (const source of project?.sources ?? []) {
      if (typeof source?.hostId !== "string" || typeof source?.path !== "string") continue;
      const theirs = await repoRemote(host, source.hostId, source.path);
      if (theirs !== remote) continue;
      const envs = await orMiss(Promise.resolve(bb.sdk?.environments?.list?.({ hostId: source.hostId, path: source.path }) ?? []), [] as Array<{ id?: unknown }>, isNotFound) as Array<{ id?: unknown }>;
      return { projectId: row.id, environmentId: typeof envs?.[0]?.id === "string" ? envs[0].id : "" };
    }
  }
  return null;
}

/**
 * resolveLanePilotProject plus the owner's notice: `lane-pilot:no-project` stays open while neither the stored
 * config nor a matching source names the project, and closes itself when one does. All five callers share it.
 */
export async function lanePilotProjectOrNotice(db: unknown, bb: unknown, host: unknown): Promise<{ projectId: string; environmentId: string } | null> {
  const found = await resolveLanePilotProject(bb, host);
  if (found) closeOwnerItem(db as never, NO_LP_PROJECT_KEY, "self-repair: resolved");
  else postOwnerItem(db as never, { key: NO_LP_PROJECT_KEY, source: "self-repair", kind: "self-repair",
    what: "Lane Pilot cannot find its own project",
    why: "self-repair:config names no projectId and no project source shares this plugin's repository remote; set it with self_repair_configure." });
  return found;
}
