import type {
  ProofCurrencyVerdict,
  ReceiptVerificationResult,
  VerdictCriterion,
  VerdictOutcome,
  VerdictReceipt,
} from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";

export function contractHashOf(task: unknown): string {
  return sha256Hex(JSON.stringify(task));
}

export function receiptHashOf(fields: {
  contractHash: string;
  treeHash: string;
  targetCommit: string;
  verdict: VerdictOutcome;
  criteria: readonly VerdictCriterion[];
}): string {
  return sha256Hex(JSON.stringify({
    contractHash: fields.contractHash,
    treeHash: fields.treeHash,
    targetCommit: fields.targetCommit,
    verdict: fields.verdict,
    criteria: fields.criteria.map((c) => ({ command: c.command, exitCode: c.exitCode })),
  }));
}

/** Preliminary `not_run` receipt written before any verification check executes. */
export function buildPreliminaryReceipt(input: {
  task: unknown;
  treeHash: string;
  targetCommit: string;
  commands: readonly string[];
  recordedAt?: string;
}): VerdictReceipt {
  const contractHash = contractHashOf(input.task);
  const criteria: VerdictCriterion[] = input.commands.map((command) => ({ command, exitCode: null }));
  const verdict: VerdictOutcome = "not_run";
  const receiptHash = receiptHashOf({
    contractHash,
    treeHash: input.treeHash,
    targetCommit: input.targetCommit,
    verdict,
    criteria,
  });
  return {
    schemaVersion: 1,
    contractHash,
    treeHash: input.treeHash,
    targetCommit: input.targetCommit,
    receiptHash,
    verdict,
    criteria,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

/** Finalizes a preliminary `not_run` receipt with actual per-criterion outcomes. `not_run` is never `pass`. */
export function finalizeVerdictReceipt(
  preliminary: VerdictReceipt,
  results: ReadonlyArray<{ command: string; exitCode: number; hostError?: boolean; verdict?: VerdictOutcome }>,
  options: { treeHash?: string; targetCommit?: string; verdict?: VerdictOutcome; recordedAt?: string } = {},
): VerdictReceipt {
  const criteria: VerdictCriterion[] = results.map((row) => ({
    command: row.command,
    exitCode: row.hostError ? null : row.exitCode,
  }));
  let verdict: VerdictOutcome;
  if (options.verdict) {
    verdict = options.verdict;
  } else if (results.length === 0 || results.some((row) => row.hostError || row.verdict === "not_run")) {
    verdict = "not_run";
  } else if (results.every((row) => row.exitCode === 0 && (row.verdict === undefined || row.verdict === "pass"))) {
    verdict = "pass";
  } else {
    verdict = "fail";
  }
  const treeHash = options.treeHash ?? preliminary.treeHash;
  const targetCommit = options.targetCommit ?? preliminary.targetCommit;
  const receiptHash = receiptHashOf({
    contractHash: preliminary.contractHash,
    treeHash,
    targetCommit,
    verdict,
    criteria,
  });
  return {
    schemaVersion: 1,
    contractHash: preliminary.contractHash,
    treeHash,
    targetCommit,
    receiptHash,
    verdict,
    criteria,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
  };
}

/** Re-checks contract hash, git tree hash, target commit, and receipt hash at acceptance. */
export function verifyVerdictReceiptHashes(
  receipt: VerdictReceipt,
  expected: { task: unknown; treeHash: string; targetCommit: string },
): { ok: true } | { ok: false; reason: string } {
  const expectedContractHash = contractHashOf(expected.task);
  if (receipt.contractHash !== expectedContractHash) {
    return { ok: false, reason: `contract hash mismatch (receipt ${receipt.contractHash.slice(0, 12)} != current ${expectedContractHash.slice(0, 12)})` };
  }
  if (receipt.treeHash !== expected.treeHash) {
    return { ok: false, reason: `git tree hash mismatch (receipt ${receipt.treeHash.slice(0, 12)} != current ${expected.treeHash.slice(0, 12)})` };
  }
  if (receipt.targetCommit !== expected.targetCommit) {
    return { ok: false, reason: `target commit mismatch (receipt ${receipt.targetCommit.slice(0, 12)} != current ${expected.targetCommit.slice(0, 12)})` };
  }
  const expectedReceiptHash = receiptHashOf(receipt);
  if (receipt.receiptHash !== expectedReceiptHash) {
    return { ok: false, reason: `receipt hash tampered (${receipt.receiptHash.slice(0, 12)} != ${expectedReceiptHash.slice(0, 12)})` };
  }
  return { ok: true };
}

/** Validates receipt integrity, verdict (`pass` only), and optional proof currency at acceptance. */
export function acceptVerdictReceipt(
  receipt: VerdictReceipt,
  expected: { task: unknown; treeHash: string; targetCommit: string; proofCurrencyVerdict?: ProofCurrencyVerdict | null },
): ReceiptVerificationResult {
  const hashCheck = verifyVerdictReceiptHashes(receipt, expected);
  if (!hashCheck.ok) return { ok: false, kind: "hash_mismatch", reason: hashCheck.reason };
  if (receipt.verdict === "not_run") return { ok: false, kind: "not_run", reason: "verdict receipt is not_run" };
  if (receipt.verdict !== "pass") return { ok: false, kind: "fail", reason: `verdict receipt is ${receipt.verdict}` };
  if (expected.proofCurrencyVerdict !== undefined && expected.proofCurrencyVerdict !== null && expected.proofCurrencyVerdict !== "current") {
    return { ok: false, kind: "stale_proof", reason: `proof currency is ${expected.proofCurrencyVerdict}` };
  }
  return { ok: true };
}
