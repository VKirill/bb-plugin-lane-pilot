import type { RequiredCapability } from "../upstream-adapter/capabilities";

export const COEXISTENCE_MANAGERS = [
  "agents-marker",
  "managed-checkout",
  "claude-cache",
  "claude-settings",
  "opencode-config",
  "opencode-plugin",
] as const;

export type CoexistenceManager = (typeof COEXISTENCE_MANAGERS)[number];

export const COEXISTENCE_OPERATIONS = [
  "install",
  "connect",
  "update",
  "reload",
  "disconnect",
  "rollback",
] as const;

export type CoexistenceOperation = (typeof COEXISTENCE_OPERATIONS)[number];
export type CoexistenceOwner = "lane-pilot" | "user" | "upstream" | "unknown";
export type CoexistenceDecision = "reuse" | "install" | "upgrade" | "conflict" | "skip" | "disconnect-owned";
export type CoexistenceStatus = "ok" | "conflict" | "blocked" | "failed" | "skipped" | "rolled_back";

export type CoexistenceEvidence = {
  kind: string;
  path: string | null;
  sha256: string | null;
  detail: string;
};

export type CoexistenceManagerState = {
  manager: CoexistenceManager;
  path: string;
  installed: boolean;
  configured: boolean;
  loaded: boolean | null;
  compatible: boolean | null;
  modified: boolean | null;
  version: string | null;
  sourceSha: string | null;
  sha256: string | null;
  owner: CoexistenceOwner;
  decision: CoexistenceDecision;
  capabilities: string[];
  missingCapabilities: RequiredCapability[];
  evidence: CoexistenceEvidence[];
};

export type CoexistenceInventory = {
  schemaVersion: 1;
  hostId: string;
  targetSha: string;
  managers: CoexistenceManagerState[];
};

export type CoexistenceInventoryInput = {
  projectId: string;
  hostId: string;
  targetSha?: string;
};

export type CoexistenceOperationInput = {
  projectId: string;
  hostId: string;
  operation: CoexistenceOperation;
  manager: CoexistenceManager;
  path: string;
  expectedSha256?: string | null;
  snapshotId?: string | null;
  targetSha?: string | null;
  confirmExternalOps?: false;
};

export type CoexistenceOperationResult = {
  schemaVersion: 1;
  hostId: string;
  operation: CoexistenceOperation;
  manager: CoexistenceManager;
  path: string;
  status: CoexistenceStatus;
  beforeSha256: string | null;
  afterSha256: string | null;
  snapshotId: string | null;
  owner: CoexistenceOwner;
  evidence: CoexistenceEvidence[];
  reason: string | null;
};
