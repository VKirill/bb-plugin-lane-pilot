// Public API of settings/server: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { preferencesRpc } from "./rpc/preferences";
export { selectionsRpc } from "./rpc/selections";
export { settingsRpc } from "./rpc/settings";
