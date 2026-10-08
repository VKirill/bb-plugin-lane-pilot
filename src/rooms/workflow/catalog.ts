import { BUILTIN_SOURCES } from "./builtin";
import { globalWorkflowDir, loadWorkflowStore } from "../storage/store";
import type { WorkflowFileSource, WorkflowStore } from "../storage/store";

/**
 * The workflows an instance can offer and run: the built-in ones plus the global files of the hub (`~/.lane-pilot/workflows`),
 * reloaded at most every `ttlMs` so an edited file shows up without a restart. The router and the run tool read it; the
 * engine resolves subworkflows from the last store loaded (built-in ones before the first load).
 */
export type WorkflowCatalog = {
  /** The store, loaded or reloaded when older than the ttl. A failure keeps the previous store. */
  store(): Promise<WorkflowStore>;
  /** The last store loaded, without waiting; null before the first load. */
  peek(): WorkflowStore | null;
  invalidate(): void;
};

export function createWorkflowCatalog(options: { globalDir?: string | null; files?: WorkflowFileSource; ttlMs?: number; now?: () => number; log?: (message: string) => void;
  resolveStatus?: Parameters<typeof loadWorkflowStore>[0]["resolveStatus"] } = {}): WorkflowCatalog {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 30_000;
  let last: WorkflowStore | null = null, loadedAt = 0, loading: Promise<WorkflowStore> | null = null;
  const globalDir = options.globalDir === undefined ? globalWorkflowDir() : options.globalDir ?? undefined;
  const load = async (): Promise<WorkflowStore> => {
    try {
      const next = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, files: options.files, globalDir, ...(options.resolveStatus ? { resolveStatus: options.resolveStatus } : {}) });
      last = next; loadedAt = now();
      for (const problem of next.problems) options.log?.(`workflow file ${problem.source} not loaded: ${problem.problems.filter((item) => item.level === "error").map((item) => item.message).join("; ")}`);
      return next;
    } catch (cause) {
      options.log?.(`workflow store not reloaded: ${cause instanceof Error ? cause.message : String(cause)}`);
      if (last) return last;
      throw cause;
    }
  };
  return {
    store: () => {
      if (last && now() - loadedAt < ttl) return Promise.resolve(last);
      loading ??= load().finally(() => { loading = null; });
      return loading;
    },
    peek: () => last,
    invalidate: () => { loadedAt = 0; },
  };
}
