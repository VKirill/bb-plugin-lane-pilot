// Public API of capability: the migrations and the pure table logic (the probing service is behind ./server).
export { capabilityMigrations } from "./migrations";
export { adapterVersions, capabilityState, capabilityTable, CAPABILITIES, DOCUMENTARY_CELLS, DOCUMENTARY_ROLES, documentaryProved, dueProbes, isDocumentaryRole, probeSetupFailed, providersInUse, receiptKey } from "./logic";
export type { Capability, CapabilityReceipt, CapabilityState } from "./logic";
export { listReceipts } from "./store";
