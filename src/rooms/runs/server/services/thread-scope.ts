import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isNotFound, orMiss, stringAt, valueAt } from "@lane-pilot/kit";
import type { ThreadScope } from "../../../contracts";

export const PROBE_CACHE_TTL_MS = 5 * 60_000;

export interface ThreadPlaceLike {
  sectionId: string | null;
  folderPath: string | null;
  hostId: string | null;
}

export interface ThreadScopeRepo {
  root: string;
  remote: string | null;
  githubRepoId: string | null;
}

export interface ThreadScopeCacheEntry {
  repo: ThreadScopeRepo | null;
  at: number;
}

export interface ThreadScopeDeps {
  bb: BbPluginApi;
  projectPlace?: (projectId: string) => Promise<ThreadPlaceLike | null>;
  memoryProject: (hostId: string, path: string) => Promise<{ projectId: string; sectionId?: string } | null>;
  probeRepo: (hostId: string, path: string) => Promise<ThreadScopeRepo | null>;
  now?: () => number;
  cache?: Map<string, ThreadScopeCacheEntry>;
  log?: { warn?: (message: string) => void; debug?: (message: string) => void };
}

const probeCache = new Map<string, ThreadScopeCacheEntry>();

/** Clears the in-memory `thread_scope` repository probe cache (for tests). */
export function clearThreadScopeCache(): void {
  probeCache.clear();
}

function emptyScope(threadId: string): ThreadScope {
  return {
    threadId,
    projectId: null,
    sectionId: null,
    hostId: null,
    cwd: null,
    repo: null,
  };
}

function probeCacheKey(hostId: string, cwd: string): string {
  return `${hostId}\0${cwd}`;
}

/**
 * Resolves the project, section, machine/folder and repository for any BB thread,
 * including ordinary chats and folders without Git. Caches repo probe results per `hostId+cwd` for 5 minutes.
 */
export async function threadScope(deps: ThreadScopeDeps, threadId: string): Promise<ThreadScope> {
  const thread = await orMiss(deps.bb.sdk.threads.get({ threadId }), null, isNotFound);
  if (!thread) return emptyScope(threadId);

  let projectId = stringAt(thread, "projectId");
  const threadSectionId = stringAt(thread, "sectionId");
  const environmentId = stringAt(thread, "environmentId");

  const [metadata, environment] = await Promise.all([
    orMiss(deps.bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound).catch(() => null),
    environmentId
      ? orMiss(deps.bb.sdk.environments.get({ environmentId }), null, isNotFound).catch(() => null)
      : Promise.resolve(null),
  ]);

  const role = valueAt(metadata, "role") ?? valueAt(valueAt(metadata, "metadata"), "role");
  const isPm = role === "pm";

  let hostId = stringAt(environment, "hostId");
  let cwd = stringAt(environment, "path");

  let place: ThreadPlaceLike | null | undefined;
  const readPlace = async (): Promise<ThreadPlaceLike | null> => {
    if (place !== undefined) return place;
    place = projectId && deps.projectPlace ? await deps.projectPlace(projectId).catch(() => null) : null;
    return place;
  };

  if ((!hostId || !cwd) && projectId && deps.projectPlace) {
    const resolved = await readPlace();
    if (resolved) {
      hostId = hostId ?? resolved.hostId;
      cwd = cwd ?? resolved.folderPath;
    }
  }

  let sectionId: string | null = threadSectionId;
  if (hostId && cwd && (!projectId || !sectionId)) {
    const mem = await deps.memoryProject(hostId, cwd).catch(() => null);
    if (mem) {
      projectId = projectId ?? mem.projectId;
      sectionId = sectionId ?? mem.sectionId ?? null;
    }
  }
  if (!sectionId && projectId && deps.projectPlace && (isPm || !stringAt(environment, "path"))) {
    sectionId = (await readPlace())?.sectionId ?? null;
  }

  let repo: ThreadScopeRepo | null = null;
  let cacheHit = false;
  if (hostId && cwd) {
    const cache = deps.cache ?? probeCache;
    const key = probeCacheKey(hostId, cwd);
    const nowMs = deps.now ? deps.now() : Date.now();
    const cached = cache.get(key);
    if (cached && nowMs - cached.at < PROBE_CACHE_TTL_MS) {
      repo = cached.repo;
      cacheHit = true;
    } else {
      try {
        repo = await deps.probeRepo(hostId, cwd);
        cache.set(key, { repo, at: nowMs });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        deps.log?.warn?.(`[console] thread_scope probe failed host=${hostId} reason=${reason}`);
        repo = null;
      }
    }
  }

  deps.log?.debug?.(
    `[console] thread_scope thread=${threadId} project=${projectId ?? "none"} section=${sectionId ?? "none"} host=${hostId ?? "none"} cwd=${cwd ?? "none"} cached=${cacheHit}`,
  );

  return {
    threadId,
    projectId,
    sectionId,
    hostId,
    cwd,
    repo,
  };
}
