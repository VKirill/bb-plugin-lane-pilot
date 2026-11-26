// Public API of docs/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { createDocs } from "./services/docs";
export type { DocsApi } from "./services/docs";
export { docsRpc } from "./handlers/docs-rpc";
export type { DocsPlace } from "./services/docs-place-status";
export { room } from "./room";
