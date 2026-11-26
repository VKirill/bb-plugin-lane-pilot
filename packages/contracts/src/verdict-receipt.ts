export type VerdictOutcome = "pass" | "fail" | "not_run";

export type ProofCurrencyVerdict = "current" | "stale" | "not_on_history" | "unknown";

export type VerdictCriterion = {
  command: string;
  exitCode: number | null;
};

export type VerdictReceipt = {
  schemaVersion: 1;
  contractHash: string;
  treeHash: string;
  targetCommit: string;
  receiptHash: string;
  verdict: VerdictOutcome;
  criteria: VerdictCriterion[];
  recordedAt: string;
};

export type ReceiptVerificationResult =
  | { ok: true }
  | { ok: false; kind: "hash_mismatch" | "not_run" | "fail" | "stale_proof"; reason: string };
