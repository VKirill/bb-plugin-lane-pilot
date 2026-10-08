// Public API of native-install: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { parseExecutionLineWindows } from "./capabilities";
export type { PathWindows } from "./capabilities";
export { inventoryCoexistence, runCoexistenceOperation } from "./coexistence";
export { NATIVE_HOOK_SOURCES } from "./native-hook-sources";
export { createNativeInstaller, experimental_vkLifecycle } from "./native-install-lifecycle";
export { atomicText } from "./native-install-owned";
export { prepareOpencodeMinimal } from "./opencode-min-config";
export { connectOpencodeStack, detectStack, importConfigStack, installStack, rollbackStack, snapshotStack } from "./stack-ops";
export type { HostContext } from "./stack-ops";
