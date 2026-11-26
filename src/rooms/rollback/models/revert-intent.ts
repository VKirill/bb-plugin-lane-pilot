/** Durable write-ahead records for a rollback's host-side merge. These live in KV, not task receipts: a receipt has no
 * intent state and its append helper is deliberately best-effort. */
export const REVERT_INTENT_PREFIX = "rollback-revert-intent:";

export type RevertIntent = {
  opId: string;
  runId: string;
  taskId: string;
  projectId: string;
  hostId: string;
  basePath: string;
  attemptIds: string[];
  changeSha: string;
  baseHead: string;
  expectedCommit: string;
  expectedTree: string;
  trailer: string;
  createdAt: number;
};

export type RevertIntentKv = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(prefix?: string): Promise<string[]>;
};

export type RevertIntentRead =
  | { state: "pending"; intent: RevertIntent }
  | { state: "none" }
  | { state: "unknown"; reason: string };

export type RevertSettlement = {
  projectId: string;
  runId: string;
  taskId: string;
  attemptIds: string[];
  baseSha: string;
  changeSha: string;
  resultCommit: string | null;
  summary: string;
  detail: unknown;
};

const keyPart = (value: string) => encodeURIComponent(value);

export const revertIntentKey = (intent: Pick<RevertIntent, "runId" | "taskId" | "opId">) =>
  `${REVERT_INTENT_PREFIX}${keyPart(intent.runId)}:${keyPart(intent.taskId)}:${keyPart(intent.opId)}`;

export const revertOpId = (runId: string, taskId: string, attempts: readonly string[], changeSha: string, expectedCommit: string) =>
  `${runId}/${taskId}/${attempts.join(",")}/${changeSha}/${expectedCommit}`;

export const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);

export const isCommitList = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.split(",").every((commit) => isSha(commit));

export const isValidRevertIntent = (value: unknown): value is RevertIntent => {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RevertIntent>;
  return typeof row.opId === "string" && typeof row.runId === "string" && typeof row.taskId === "string" && typeof row.projectId === "string"
    && typeof row.hostId === "string" && typeof row.basePath === "string" && Array.isArray(row.attemptIds) && row.attemptIds.length > 0
    && new Set(row.attemptIds).size === row.attemptIds.length && row.attemptIds.every((id) => typeof id === "string" && id.length > 0)
    && isCommitList(row.changeSha) && isSha(row.baseHead) && isSha(row.expectedCommit) && isSha(row.expectedTree) && typeof row.trailer === "string"
    && typeof row.createdAt === "number" && Number.isFinite(row.createdAt);
};
