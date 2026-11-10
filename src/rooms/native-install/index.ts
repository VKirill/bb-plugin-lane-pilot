// Public API of native-install: what other rooms import. Everything else in this room is private.
// Add a name here to make it public; scripts/refactor/barrels.ts wrote the first version from the existing imports.
export { inventoryCoexistence, runCoexistenceOperation } from "./coexistence";
export { createNativeInstaller, experimental_vkLifecycle } from "./native-install-lifecycle";

export { connectOpencodeStack, detectStack, importConfigStack, installStack, rollbackStack, snapshotStack } from "./stack-ops";
export type { HostContext } from "./stack-ops";
export { featureRegistry, featureRegistryGaps } from "./feature-registry";
export type { FeatureCapability, FeatureRuntime } from "./feature-registry";
