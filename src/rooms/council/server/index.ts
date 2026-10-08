// Public API of council/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { councilRpc, createCouncil, mountCouncilTools } from "./council";
export type { CouncilApi } from "./council";
