import { sha256Hex } from "@lane-pilot/kit";
import type { CodeCritiqueFinding, CodeCritiqueSettings } from "./code-critique";

export type FrozenCritiquePolicy = {
  enabled: boolean;
  mode: "advisory" | "gate";
  autoFix: boolean;
  maxRounds: number;
  agent: string;
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
};

export type FrozenDispatchContext = {
  memoryText: string;
  executionPacket: string;
  executionPacketSha256: string;
  pmReadContext: string;
  agent: string;
  helperMode: string;
  helperRequired: boolean;
};

export type WriterIdentity = {
  attemptId: string;
  providerId: string;
  model: string;
  reasoningLevel: string;
  serviceTier: "default" | "fast" | null;
  environmentId: string | null;
  workspacePath: string;
};

export type ReviewerIdentity = {
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
  mode: "advisory" | "gate";
  maxRounds: number;
  autoFix: boolean;
};

export type CodeCritiqueLedger = {
  artifactRevisionSha256: string;
  evidenceSha256?: string;
  revisionSha256: string;
  findingsHash: string;
  repairRound: number;
  spawnAttempted: boolean;
  repairObserved?: boolean;
  repairThreadId?: string;
  /** When the repair went as a message into the writer's own thread: completion waits for a turn after it. */
  repairSentAt?: number;
  writer?: WriterIdentity;
  reviewer?: ReviewerIdentity;
  findings?: CodeCritiqueFinding[];
  policy?: FrozenCritiquePolicy;
};

export function findingsHash(findings: readonly CodeCritiqueFinding[]): string {
  return sha256Hex(JSON.stringify(findings.map((row) => ({
    id: row.id, severity: row.severity, finding: row.finding, criterion: row.criterion, path: row.path ?? null,
  }))));
}

export function sameWriterIdentity(expected: WriterIdentity, actual: WriterIdentity): boolean {
  return expected.attemptId === actual.attemptId
    && expected.providerId === actual.providerId
    && expected.model === actual.model
    && expected.reasoningLevel === actual.reasoningLevel
    && expected.serviceTier === actual.serviceTier
    && expected.environmentId === actual.environmentId
    && expected.workspacePath === actual.workspacePath;
}

export function nextRepairAction(input: {
  ledger?: CodeCritiqueLedger;
  nextRound: number;
  attemptId?: string;
  artifactRevisionSha256?: string;
  revisionSha256?: string;
}): "spawn" | "wait" | "unknown" {
  const ledger = input.ledger;
  if (!ledger) return "spawn";
  const claimed = ledger.spawnAttempted && ledger.repairRound === input.nextRound;
  if (claimed) {
    if (input.attemptId && ledger.writer?.attemptId && ledger.writer.attemptId !== input.attemptId) return "unknown";
    if (!ledger.repairThreadId) return "unknown";
    if (ledger.repairObserved) return "spawn";
    return "wait";
  }
  return "spawn";
}

export function persistLedgerFields(result: unknown): Record<string, unknown> {
  const ledger = repairLedgerFromResult(result);
  if (!ledger) return {};
  return {
    repairRound: ledger.repairRound,
    spawnAttempted: ledger.spawnAttempted,
    ...(ledger.repairObserved ? { repairObserved: true } : {}),
    artifactRevisionSha256: ledger.artifactRevisionSha256,
    revisionSha256: ledger.revisionSha256,
    ...(ledger.evidenceSha256 ? { evidenceSha256: ledger.evidenceSha256 } : {}),
    ...(ledger.repairThreadId ? { repairThreadId: ledger.repairThreadId } : {}),
    ...(ledger.writer ? { writer: ledger.writer } : {}),
    ...(ledger.findingsHash ? { findingsHash: ledger.findingsHash } : {}),
  };
}

export function freezeCritiquePolicy(input: {
  settings: CodeCritiqueSettings;
  providerId: string;
  model: string;
  reasoningEffort: string;
  serviceTier: string;
}): FrozenCritiquePolicy {
  return {
    enabled: input.settings.enabled,
    mode: input.settings.mode,
    autoFix: input.settings.autoFix,
    maxRounds: input.settings.maxRounds,
    agent: input.settings.agent,
    providerId: input.providerId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
  };
}

export function settingsFromFrozenPolicy(policy: FrozenCritiquePolicy): CodeCritiqueSettings {
  return {
    enabled: policy.enabled,
    mode: policy.mode,
    autoFix: policy.autoFix,
    maxRounds: policy.maxRounds,
    agent: policy.agent,
  };
}

export function critiquePolicyFromResult(result: unknown): FrozenCritiquePolicy | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = (result as { policy?: unknown }).policy;
  if (!row || typeof row !== "object") return undefined;
  const policy = row as Record<string, unknown>;
  if (typeof policy.providerId !== "string" || typeof policy.model !== "string") return undefined;
  if (typeof policy.maxRounds !== "number" || !Number.isSafeInteger(policy.maxRounds)) return undefined;
  return {
    enabled: policy.enabled !== false,
    mode: policy.mode === "advisory" ? "advisory" : "gate",
    autoFix: policy.autoFix !== false,
    maxRounds: policy.maxRounds,
    agent: typeof policy.agent === "string" && policy.agent.trim() ? policy.agent.trim() : "code-critic",
    providerId: policy.providerId,
    model: policy.model,
    reasoningEffort: typeof policy.reasoningEffort === "string" ? policy.reasoningEffort : "medium",
    serviceTier: typeof policy.serviceTier === "string" ? policy.serviceTier : "standard",
  };
}

export function repairLedgerFromResult(result: unknown): CodeCritiqueLedger | undefined {
  if (!result || typeof result !== "object") return undefined;
  const row = result as Record<string, unknown>;
  if (typeof row.revisionSha256 !== "string" && typeof row.artifactRevisionSha256 !== "string") return undefined;
  const artifactRevisionSha256 = typeof row.artifactRevisionSha256 === "string" && row.artifactRevisionSha256
    ? row.artifactRevisionSha256
    : String(row.revisionSha256 ?? "");
  if (!artifactRevisionSha256) return undefined;
  const repairRound = typeof row.repairRound === "number" && Number.isSafeInteger(row.repairRound) ? row.repairRound : 0;
  const writer = row.writer && typeof row.writer === "object" ? row.writer as WriterIdentity : undefined;
  const reviewer = row.reviewer && typeof row.reviewer === "object" ? row.reviewer as ReviewerIdentity : undefined;
  const policy = critiquePolicyFromResult(result);
  return {
    artifactRevisionSha256,
    evidenceSha256: typeof row.evidenceSha256 === "string" ? row.evidenceSha256 : undefined,
    revisionSha256: artifactRevisionSha256,
    findingsHash: typeof row.findingsHash === "string" ? row.findingsHash : "",
    repairRound,
    spawnAttempted: row.spawnAttempted === true,
    ...(row.repairObserved === true ? { repairObserved: true } : {}),
    ...(typeof row.repairThreadId === "string" && row.repairThreadId ? { repairThreadId: row.repairThreadId } : {}),
    ...(typeof row.repairSentAt === "number" && Number.isFinite(row.repairSentAt) ? { repairSentAt: row.repairSentAt } : {}),
    ...(writer ? { writer } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(Array.isArray(row.findings) ? { findings: row.findings as CodeCritiqueFinding[] } : {}),
    ...(policy ? { policy } : {}),
  };
}
