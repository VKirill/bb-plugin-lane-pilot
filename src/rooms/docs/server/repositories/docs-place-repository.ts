import { basename, resolve } from "node:path";
import { isNotFound, orMiss } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { latestDocsTaskAt, loadProjectSettings } from "../../../storage";
import { sha256 } from "../../../tasks/server";
import type { DocsPlace, StoredDocsVerdict } from "../../models";

const WORTH_KEY = (place: DocsPlace) => `docs-worthiness:${place.hostId}:${sha256(resolve(place.path)).slice(0, 16)}`;

/** Reads the cached docs-worthiness verdict for one host/folder place from KV. */
export async function readStoredDocsVerdict(
  kv: ServerCore["bb"]["storage"]["kv"],
  place: DocsPlace,
): Promise<StoredDocsVerdict | null> {
  return (await kv.get(WORTH_KEY(place))) as StoredDocsVerdict | null;
}

/** Persists a docs-worthiness verdict for one host/folder place into KV. */
export async function saveStoredDocsVerdict(
  kv: ServerCore["bb"]["storage"]["kv"],
  place: DocsPlace,
  verdict: StoredDocsVerdict,
): Promise<void> {
  await kv.set(WORTH_KEY(place), verdict);
}

/** Reads the timestamp of the latest task that touched docs/ for this place. */
export function readLatestDocsTaskAt(db: ServerCore["db"], place: DocsPlace): number | null {
  return latestDocsTaskAt(db, { root: resolve(place.path), hostId: place.hostId });
}

/** Loads scoped settings for a project place. */
export function readProjectDocsSettings(db: ServerCore["db"], projectId: string, scopes: string[]) {
  return loadProjectSettings(db, projectId, scopes);
}

/** Lists every project source folder and folder section copy across enrolled machines. */
export async function listProjectFolderPlaces(
  ctx: ServerCore,
  projectId: string,
): Promise<Array<DocsPlace & { scopes: string[]; name: string }>> {
  const { bb, listProjectSections, sectionChain } = ctx;
  const places: Array<DocsPlace & { scopes: string[]; name: string }> = [];
  const described = (await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound)) as {
    name?: string;
    sources?: Array<{ hostId?: string; path?: string }>;
  } | null;
  for (const source of described?.sources ?? []) {
    if (source.hostId && source.path && !places.some((place) => place.hostId === source.hostId && place.path === source.path)) {
      places.push({ scopes: [], hostId: source.hostId, path: source.path, name: described?.name ?? basename(source.path) });
    }
  }
  const sections = await listProjectSections(projectId);
  for (const section of sections) {
    if (section.kind === "folder") {
      for (const copy of section.paths) {
        if (copy.path && copy.hostId) {
          places.push({ scopes: sectionChain(sections, section.id), hostId: copy.hostId, path: copy.path, name: section.name });
        }
      }
    }
  }
  return places;
}
