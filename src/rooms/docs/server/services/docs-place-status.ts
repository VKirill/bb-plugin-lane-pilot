import { bestEffort } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { codeDocsVerdict, docsCadence, docsFactsKey, fallbackDocsVerdict } from "../../models";
import type { DocsCadence, DocsPlace, StoredDocsVerdict } from "../../models";
import {
  listProjectFolderPlaces,
  readLatestDocsTaskAt,
  readStoredDocsVerdict,
  saveStoredDocsVerdict,
} from "../repositories/docs-place-repository";

export type { DocsPlace, StoredDocsVerdict };

/** A verdict older than this is asked again even when the folder looks the same. */
const VERDICT_TTL_MS = 30 * 24 * 3_600_000;

/**
 * Whether docs are worth keeping for this folder on this machine. Facts come from the folder itself; code
 * settles the clear cases, System One the borderline ones. Kept until the facts move or a month passes.
 */
export async function docsVerdict(
  ctx: ServerCore,
  projectId: string,
  place: DocsPlace,
  opts: { force?: boolean; now?: number } = {},
): Promise<StoredDocsVerdict | null> {
  const { bb, host } = ctx;
  const now = opts.now ?? Date.now();
  const stored = await readStoredDocsVerdict(bb.storage.kv, place);
  const facts = await bestEffort(
    bb.log,
    `docs worthiness facts ${place.path}`,
    host.call("docsWorthinessFacts", { requestedHostId: place.hostId, projectCwd: place.path }, { hostId: place.hostId, timeoutMs: 60_000 }),
    null,
  );
  if (!facts) return stored;
  const factsKey = docsFactsKey(facts);
  const docsSince = stored?.docsSince ?? (facts.docsPages > 0 ? now : null);
  if (stored && !opts.force && stored.factsKey === factsKey && now - stored.at < VERDICT_TTL_MS) {
    return { ...stored, facts, docsSince };
  }
  const verdict = codeDocsVerdict(facts) ?? fallbackDocsVerdict(facts);
  const next: StoredDocsVerdict = { ...verdict, projectId, hostId: place.hostId, path: place.path, factsKey, facts, at: now, docsSince };
  await saveStoredDocsVerdict(bb.storage.kv, place, next);
  return next;
}

/** The last time a writer task in this folder was pointed at its docs: read_first or the execution packet named a docs page. */
export function docsLastRead(ctx: ServerCore, place: DocsPlace): number | null {
  return readLatestDocsTaskAt(ctx.db, place);
}

/** Where a folder in auto mode stands: verdict, and for kept docs how often they are refreshed. */
export async function docsPlaceStatus(
  ctx: ServerCore,
  projectId: string,
  place: DocsPlace,
  opts: { force?: boolean; now?: number } = {},
): Promise<{ verdict: StoredDocsVerdict | null; cadence: DocsCadence; lastReadAt: number | null }> {
  const now = opts.now ?? Date.now();
  const verdict = await docsVerdict(ctx, projectId, place, opts);
  const lastReadAt = docsLastRead(ctx, place);
  const cadence =
    verdict?.need && verdict.facts.docsPages > 0 && verdict.docsSince !== null
      ? docsCadence({ lastReadAt, docsSince: verdict.docsSince, now })
      : "nightly";
  return { verdict, cadence, lastReadAt };
}

/** Every folder of a project on every machine: its sources and its section folders. */
export async function docsPlaces(ctx: ServerCore, projectId: string): Promise<Array<DocsPlace & { scopes: string[]; name: string }>> {
  return listProjectFolderPlaces(ctx, projectId);
}
