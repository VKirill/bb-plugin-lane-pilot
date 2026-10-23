// Public API of capability: the migrations and the pure table logic (the probing service is behind ./server).
export { capabilityMigrations } from "./migrations";
export { adapterVersions, capabilityTable, CAPABILITIES, dueProbes, probeSetupFailed, providersInUse } from "./logic";
export type { Capability, CapabilityReceipt, CapabilityState } from "./logic";
export { listReceipts } from "./store";
