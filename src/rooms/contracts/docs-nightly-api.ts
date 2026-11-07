export type DocsPlace = { hostId:string; path:string };

/** The docs place list, implemented by src/rooms/docs (createDocsNightly) and handed through the services bag. */
export interface DocsNightlyPort {
  docsPlaces(projectId:string): Promise<Array<DocsPlace & { scopes:string[]; name:string }>>;
}
