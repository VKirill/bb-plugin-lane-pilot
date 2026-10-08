// Public API of qa: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { runBrowserQaOnHost } from "./browser-qa";
export { QA_HOST_KEY, mapListedQaHosts, qaSpawnClaimed } from "./qa-host";
