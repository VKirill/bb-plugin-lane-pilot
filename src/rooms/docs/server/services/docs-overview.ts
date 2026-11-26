import { configuredSetting, type ServerCore } from "../../../contracts/server";
import { parseDocsSettings } from "../../models";
import { DOCS_ENABLED_KEY } from "../../settings";
import { readProjectDocsSettings } from "../repositories/docs-place-repository";
import type { DocsApi } from "./docs";

export type DocsOverviewServices = Pick<DocsApi, "docsPlaces" | "docsPlaceStatus" | "docsLastRead">;
type DocsStatus = Awaited<ReturnType<DocsOverviewServices["docsPlaceStatus"]>>;

/** How long the verdict of a folder is reused by the tab, and how long one open waits for a slow machine. */
const DOCS_STATUS_TTL_MS = 5 * 60_000;
const DOCS_STATUS_WAIT_MS = 1_500;

/** Builds the cached docs overview query over a project's folder places. */
export function createDocsOverview(ctx: ServerCore, docs: DocsOverviewServices) {
  const { db } = ctx;
  const docsStatusCache = new Map<string, { at: number; status: DocsStatus }>();

  return async ({ projectId, recheck }: { projectId: string; recheck?: boolean }) => {
    const places = await docs.docsPlaces(projectId);
    const rows = await Promise.all(places.map(async (place) => {
      const settings = readProjectDocsSettings(db, projectId, place.scopes);
      const mode = parseDocsSettings(Object.fromEntries([DOCS_ENABLED_KEY, "docs.maintain", "docs.since", "docs.page_cap", "docs.hour"].map((key) => [key, configuredSetting(settings, key)]))).mode;
      let status: DocsStatus;
      if (mode !== "auto") status = { verdict: null, cadence: "nightly" as const, lastReadAt: docs.docsLastRead(place) };
      else {
        const key = `${projectId}|${place.hostId}|${place.path}`;
        const hit = docsStatusCache.get(key);
        if (!recheck && hit && Date.now() - hit.at < DOCS_STATUS_TTL_MS) status = hit.status;
        else {
          const pending = docs.docsPlaceStatus(projectId, place, { force: recheck }).then((fresh) => {
            docsStatusCache.set(key, { at: Date.now(), status: fresh });
            return fresh;
          });
          if (recheck) status = await pending;
          else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const early = await Promise.race([
              pending.catch((cause: unknown) => {
                ctx.log(`docs: docs status unreadable for ${place.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
                return null;
              }),
              new Promise<null>((done) => { timer = setTimeout(() => done(null), DOCS_STATUS_WAIT_MS); }),
            ]);
            clearTimeout(timer);
            status = early ?? hit?.status ?? { verdict: null, cadence: "nightly" as const, lastReadAt: docs.docsLastRead(place) };
          }
        }
      }
      const v = status.verdict;
      return {
        hostId: place.hostId, path: place.path, name: place.name, scopes: place.scopes, mode,
        verdict: v ? {
          need: v.need, reason: v.reason, confidence: v.confidence, at: v.at,
          facts: { codeFiles: v.facts.codeFiles, contentFiles: v.facts.contentFiles, commits30d: v.facts.commits30d, manifests: v.facts.manifests.slice(0, 5), docsPages: v.facts.docsPages },
        } : null,
        cadence: status.cadence, lastReadAt: status.lastReadAt,
      };
    }));
    return { places: rows };
  };
}
