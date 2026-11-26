export type DocsPlace = { hostId: string; path: string };

/** The docs place list, implemented by src/rooms/docs (createDocs) and handed through the services bag. */
export interface DocsPort {
  docsPlaces(projectId: string): Promise<Array<DocsPlace & { scopes: string[]; name: string }>>;
}
