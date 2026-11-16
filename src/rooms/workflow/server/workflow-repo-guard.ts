import { bestEffort } from "@lane-pilot/kit";
import { listThreadEventsPaged } from "@lane-pilot/thread-observe";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { detectRepoEdits, gitRepoSnapshot, gitRepoStatus, namedByChat, writtenByEngineSince, type RepoSnapshot } from "../../verification/server";

/** The checkout's measured state at the edges of a read-only helper's window: endpoint observations, not proof the run left no other effect. `changed`/`pmOwn`/`engineOwn`/`edited` are null when the guard could not compare (the before snapshot was unknown). */
export type RepoGuardDetail = {
  checkout: { hostId: string; path: string };
  /** Observation interval: `before.at` … `after.at` (hub clock); `watchedFrom` is when the window opened. */
  watchedFrom: number;
  /** True when the thread or its pending turn predates this window (reload re-run, deduped follow-up): the snapshots may not cover the whole execution. */
  reusedThread: boolean;
  /** "unverified" when the helper's thread was not freshly spawned into the resolved checkout — a continued (`intoThread`) thread, or one a reload re-run restored by spawn key (`reusedThread`): its environment was never compared to the snapshotted checkout, so the snapshots are interval data on the PM checkout, not a measurement of where the helper worked. */
  checkoutBinding: "verified" | "unverified";
  before: RepoSnapshot | null;
  after: RepoSnapshot | null;
  changed: string[] | null;
  pmOwn: string[] | null;
  engineOwn: string[] | null;
  edited: string[] | null;
};

export type RepoGuardPoint = { files: Set<string> | null; snap: RepoSnapshot | null };

/** Capture endpoints and retain the existing filename-based edit guard; neither proves whole-run immutability. */
export function createRepoGuard(input: { bb: ServerCore["bb"]; host: ServerCore["host"]; hostId: string | null | undefined;
  path: string | null | undefined; readOnly: boolean; pmThreadId?: string | null; watchedFrom: number; role: string; stepKey: string }) {
  const { bb, host, hostId, path, readOnly, pmThreadId, watchedFrom, role, stepKey } = input;
  const point = async (): Promise<RepoGuardPoint> => {
    if (!path || !hostId) return { files: null, snap: null };
    if (!readOnly) return { files: await gitRepoStatus(host, hostId, path), snap: null };
    const snap = await gitRepoSnapshot(host, hostId, path);
    // Keep plain status coverage when the host lacks snapshot plumbing; the measurement remains null.
    return snap ? { files: new Set(snap.files), snap } : { files: await gitRepoStatus(host, hostId, path), snap: null };
  };
  const compare = async (before: Set<string> | null, after: Set<string> | null, editable: (file: string) => boolean):
    Promise<Pick<RepoGuardDetail, "changed" | "pmOwn" | "engineOwn" | "edited">> => {
    if (!before || !after || !path) return { changed: null, pmOwn: null, engineOwn: null, edited: null };
    const changed = detectRepoEdits(before, after, editable);
    const pmOwn = changed.length && pmThreadId ? namedByChat(await chatTextSince(bb, pmThreadId, watchedFrom), changed) : new Set<string>();
    if (pmOwn.size) bb.log.warn(`workflow step ${stepKey}: ${[...pmOwn].join(", ")} changed during the ${role} helper's run, named by the PM chat: its own edit, not the helper's`);
    const engineOwn = changed.length ? writtenByEngineSince(path, watchedFrom) : new Set<string>();
    return { changed, pmOwn: [...pmOwn], engineOwn: [...engineOwn], edited: changed.filter((file) => !pmOwn.has(file) && !engineOwn.has(file)) };
  };
  return { point, compare };
}

/** The PM chat's events since `since`, as text (the newest 200; none when they cannot be read or carry no time, so nothing is excused). */
async function chatTextSince(bb: ChainRuntime["ctx"]["bb"], threadId: string, since: number): Promise<string[]> {
  const listed = await bestEffort(bb.log, "workflow helper chat events", listThreadEventsPaged(bb as never, { threadId, order: "desc", limit: "200" }), []) as unknown[];
  const at = (event: unknown): number => {
    const raw = (event as { createdAt?: unknown })?.createdAt;
    return typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  };
  return (Array.isArray(listed) ? listed : []).filter((event) => at(event) >= since).map((event) => JSON.stringify(event));
}
