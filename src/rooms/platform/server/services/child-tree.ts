import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bestEffort, killProcessTree } from "@lane-pilot/kit";

const childPidsByThread = new Map<string, Set<number>>();
const childThreadsByParent = new Map<string, Set<string>>();

/** Associates a child OS process PID with a thread so stopping the thread kills the whole process tree. */
export function registerThreadProcess(threadId: string, pid: number): () => void {
  if (!threadId || !Number.isSafeInteger(pid) || pid <= 0) return () => undefined;
  let set = childPidsByThread.get(threadId);
  if (!set) {
    set = new Set();
    childPidsByThread.set(threadId, set);
  }
  set.add(pid);
  return () => {
    set?.delete(pid);
    if (set && set.size === 0) childPidsByThread.delete(threadId);
  };
}

/** Records a helper thread spawned under a parent thread so stopping the parent tears down helpers too. */
export function registerHelperThread(parentThreadId: string, childThreadId: string): () => void {
  if (!parentThreadId || !childThreadId) return () => undefined;
  let set = childThreadsByParent.get(parentThreadId);
  if (!set) {
    set = new Set();
    childThreadsByParent.set(parentThreadId, set);
  }
  set.add(childThreadId);
  return () => {
    set?.delete(childThreadId);
    if (set && set.size === 0) childThreadsByParent.delete(parentThreadId);
  };
}

/**
 * Stops a thread, all descendant helper threads (SDK descendants + locally registered helpers),
 * and any tracked OS child process trees. Logs `INFO run stopped children_killed=n`.
 */
export async function stopThreadTree(
  bb: BbPluginApi,
  threadId: string,
  extraPids: readonly number[] = [],
): Promise<{ killed: number; stoppedThreads: string[] }> {
  const stoppedThreads: string[] = [];
  const seenThreads = new Set<string>();
  const toStopThreads: string[] = [];

  const collectThread = async (id: string) => {
    if (!id || seenThreads.has(id)) return;
    seenThreads.add(id);
    const localChildren = [...(childThreadsByParent.get(id) ?? [])];
    childThreadsByParent.delete(id);
    for (const childId of localChildren) await collectThread(childId);

    const listDesc = bb.sdk?.threads?.experimental_listDescendants;
    if (typeof listDesc === "function") {
      try {
        const listed = await bestEffort(
          bb.log,
          "thread tree list descendants",
          listDesc({ threadIds: [id], includeArchived: false, includeHidden: true }),
          null,
        );
        const entry = Array.isArray(listed) ? listed.find((row) => row?.threadId === id) : null;
        for (const descId of entry?.descendantIds ?? []) {
          await collectThread(descId);
        }
      } catch {
        // Fake or older hosts may not implement experimental_listDescendants.
      }
    }
    toStopThreads.push(id);
  };

  await collectThread(threadId);

  let killed = 0;
  const pids = new Set<number>(extraPids);
  for (const tid of seenThreads) {
    for (const pid of childPidsByThread.get(tid) ?? []) pids.add(pid);
    childPidsByThread.delete(tid);
  }

  for (const pid of pids) {
    killed += await killProcessTree(pid);
  }

  for (const tid of toStopThreads) {
    try {
      const res = await bestEffort(bb.log, `stop child thread ${tid}`, bb.sdk?.threads?.stop?.({ threadId: tid }), null);
      if (res !== null) {
        stoppedThreads.push(tid);
        if (tid !== threadId) killed += 1;
      }
    } catch {
      // Fake or older hosts may not stub threads.stop.
    }
  }

  bb.log?.info?.(`Lane Pilot INFO run stopped children_killed=${killed}`);
  return { killed, stoppedThreads };
}
