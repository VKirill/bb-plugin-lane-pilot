import type { ServerCore } from "../../../contracts/server";
import { docsLastRead, docsPlaceStatus, docsPlaces, docsVerdict, type DocsPlace } from "./docs-place-status";

/** Read-only docs inventory and worthiness services (`docsPlaces`, `docs_overview`). */
export function createDocs(ctx: ServerCore) {
  return {
    docsPlaces: (projectId: string) => docsPlaces(ctx, projectId),
    docsVerdict: (projectId: string, place: DocsPlace, opts: { force?: boolean; now?: number } = {}) =>
      docsVerdict(ctx, projectId, place, opts),
    docsPlaceStatus: (projectId: string, place: DocsPlace, opts: { force?: boolean; now?: number } = {}) =>
      docsPlaceStatus(ctx, projectId, place, opts),
    docsLastRead: (place: DocsPlace) => docsLastRead(ctx, place),
  };
}

export type DocsApi = ReturnType<typeof createDocs>;
