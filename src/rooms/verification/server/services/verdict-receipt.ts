import type { ProofCurrencyVerdict, VerdictReceipt } from "@lane-pilot/contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { bestEffort, isNotFound, orMiss, sha256Hex, stringAt } from "@lane-pilot/kit";
import type { ServerCore } from "../../../contracts/server";
import { writeReplacing } from "../../../storage";
import { acceptanceArtifactDir } from "../../../tasks";
import {
  acceptVerdictReceipt,
  buildPreliminaryReceipt,
  contractHashOf,
  finalizeVerdictReceipt,
} from "../../models/verdict-receipt";
import { hostGit, proofCurrency } from "./proof-currency";

const RECEIPT_FILE = "verdict-receipt.json";
export const verdictReceiptKvKey = (attemptId: string): string => `verdictReceipt:${attemptId}`;
export const verdictReceiptPath = (projectCwd: string, runId: string, taskId: string, homed?: boolean): string =>
  homed ? `${projectCwd}/.agents/tasks/${taskId}/${RECEIPT_FILE}` : `${acceptanceArtifactDir(projectCwd, runId, taskId)}/${RECEIPT_FILE}`;

export type RepoReceiptSnapshot = {
  treeHash: string;
  targetCommit: string;
  gitBacked: boolean;
};

/** Captures current candidate git tree hash (committed + working changes) and target commit, or `null` if unavailable. */
export async function captureWorkspaceReceiptSnapshot(input: {
  host: ServerCore["host"];
  hostId: string;
  projectCwd: string;
  basePath?: string | null;
}): Promise<RepoReceiptSnapshot | null> {
  const targetDir = input.basePath || input.projectCwd;
  const cmd = [
    `HEAD_COMMIT=$(git -C '${targetDir.replace(/'/g, `'\\''`)}' rev-parse --verify HEAD 2>/dev/null) || exit 2;`,
    `TMPIDX=$(mktemp) && trap 'rm -f "$TMPIDX"' EXIT;`,
    `GIT_INDEX_FILE="$TMPIDX" git read-tree HEAD 2>/dev/null || true;`,
    `GIT_INDEX_FILE="$TMPIDX" git add -A -- . ':!.agents' >/dev/null 2>&1 || true;`,
    `TREE_HASH=$(GIT_INDEX_FILE="$TMPIDX" git write-tree 2>/dev/null) || exit 3;`,
    `printf '%s\\n%s\\n' "$TREE_HASH" "$HEAD_COMMIT"`,
  ].join(" ");
  const res = await bestEffort(
    () => undefined,
    "capture workspace receipt snapshot",
    runOnHost(input.host, { hostId: input.hostId, cwd: input.projectCwd, command: cmd, timeoutSec: 15, timeoutMs: 15_000 }),
    null,
  );
  if (!res || res.exitCode !== 0) return null;
  const lines = res.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || !/^[0-9a-f]{40,}$/i.test(lines[0]!) || !/^[0-9a-f]{40,}$/i.test(lines[1]!)) return null;
  return { treeHash: lines[0]!, targetCommit: lines[1]!, gitBacked: true };
}

const NOOP_LOG = () => undefined;

function logOf(ctx: Pick<ServerCore, "bb" | "log">): NonNullable<ServerCore["log"]> {
  return ctx.log ?? ctx.bb?.log ?? NOOP_LOG;
}

function logInfo(ctx: Pick<ServerCore, "bb" | "log">, line: string): void {
  ctx.bb?.log?.info?.(line);
  ctx.log?.(line);
}

function logWarn(ctx: Pick<ServerCore, "bb" | "log">, line: string): void {
  ctx.bb?.log?.warn?.(line);
  ctx.log?.(line);
}

/** Writes the preliminary or finalized verdict receipt to KV + artifact path(s) and emits the audit INFO log. */
export async function persistVerdictReceipt(
  ctx: Pick<ServerCore, "bb" | "log">,
  input: {
    hostId: string;
    projectCwd: string;
    basePath?: string | null;
    runId: string;
    taskId: string;
    attemptId: string;
    homed?: boolean;
    receipt: VerdictReceipt;
  },
): Promise<void> {
  const payload = `${JSON.stringify(input.receipt, null, 2)}\n`;
  await bestEffort(
    logOf(ctx),
    "verdict receipt kv write",
    ctx.bb.storage.kv.set(verdictReceiptKvKey(input.attemptId), input.receipt as never),
    undefined,
  );
  if (!input.homed) {
    await bestEffort(
      logOf(ctx),
      "verdict receipt file write",
      Promise.resolve().then(() =>
        writeReplacing(ctx.bb.sdk.files, {
          hostId: input.hostId,
          rootPath: input.projectCwd,
          path: verdictReceiptPath(input.projectCwd, input.runId, input.taskId, false),
          content: payload,
          createParents: true,
        }),
      ),
      undefined,
    );
  }
  const basePath = input.basePath;
  if (basePath && (input.homed || basePath !== input.projectCwd)) {
    await bestEffort(
      logOf(ctx),
      "verdict receipt base copy",
      Promise.resolve().then(() =>
        writeReplacing(ctx.bb.sdk.files, {
          hostId: input.hostId,
          rootPath: basePath,
          path: verdictReceiptPath(basePath, input.runId, input.taskId, input.homed),
          content: payload,
          createParents: true,
        }),
      ),
      undefined,
    );
  }
  logInfo(ctx, `INFO receipt written hash=${input.receipt.receiptHash.slice(0, 12)} verdict=${input.receipt.verdict}`);
}

export async function beginVerdictReceipt(
  ctx: Pick<ServerCore, "bb" | "host" | "log">,
  input: {
    hostId: string;
    projectCwd: string;
    basePath?: string | null;
    runId: string;
    taskId: string;
    attemptId: string;
    homed?: boolean;
    task: { verification: Array<{ command: string }> };
  },
): Promise<{ preliminary: VerdictReceipt; snapshot: RepoReceiptSnapshot | null }> {
  const snapshot = await captureWorkspaceReceiptSnapshot({
    host: ctx.host,
    hostId: input.hostId,
    projectCwd: input.projectCwd,
    basePath: input.basePath,
  });
  const preliminary = buildPreliminaryReceipt({
    task: input.task,
    treeHash: snapshot?.treeHash ?? sha256Hex(`mock-tree:${input.attemptId}`),
    targetCommit: snapshot?.targetCommit ?? sha256Hex(`mock-commit:${input.runId}`),
    commands: input.task.verification.map((item) => item.command),
  });
  await persistVerdictReceipt(ctx, {
    hostId: input.hostId,
    projectCwd: input.projectCwd,
    basePath: input.basePath,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    homed: input.homed,
    receipt: preliminary,
  });
  return { preliminary, snapshot };
}

export async function finishVerdictReceipt(
  ctx: Pick<ServerCore, "bb" | "log">,
  input: {
    preliminary: VerdictReceipt;
    hostId: string;
    projectCwd: string;
    basePath?: string | null;
    runId: string;
    taskId: string;
    attemptId: string;
    homed?: boolean;
    verifies: ReadonlyArray<{ command: string; exitCode: number; hostError?: boolean }>;
  },
): Promise<VerdictReceipt> {
  const receipt = finalizeVerdictReceipt(input.preliminary, input.verifies);
  await persistVerdictReceipt(ctx, {
    hostId: input.hostId,
    projectCwd: input.projectCwd,
    basePath: input.basePath,
    runId: input.runId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    homed: input.homed,
    receipt,
  });
  return receipt;
}

export async function loadVerdictReceipt(
  ctx: Pick<ServerCore, "bb" | "log">,
  input: { hostId: string; projectCwd: string; basePath?: string | null; runId: string; taskId: string; attemptId: string; homed?: boolean },
): Promise<VerdictReceipt | null> {
  const root = input.homed && input.basePath ? input.basePath : input.projectCwd;
  const filePath = verdictReceiptPath(root, input.runId, input.taskId, input.homed);
  const fileRead = await bestEffort(
    logOf(ctx),
    "verdict receipt file read",
    Promise.resolve().then(() =>
      orMiss(ctx.bb.sdk.files.read({ hostId: input.hostId, rootPath: root, path: filePath }), null, isNotFound),
    ),
    null,
  );
  const content = fileRead ? stringAt(fileRead, "content") : null;
  if (content) {
    try {
      const parsed = JSON.parse(content) as VerdictReceipt;
      if (parsed && parsed.schemaVersion === 1 && typeof parsed.contractHash === "string") return parsed;
    } catch {
      // fall through to KV or fail on corrupted payload
    }
  }
  const fromKv = await bestEffort(
    logOf(ctx),
    "verdict receipt kv read",
    ctx.bb.storage.kv.get(verdictReceiptKvKey(input.attemptId)),
    null,
  );
  if (fromKv && typeof fromKv === "object" && "schemaVersion" in fromKv) return fromKv as VerdictReceipt;
  return null;
}

/** Re-checks contract hash, git tree hash, target commit, and proof currency before acceptance lands. */
export async function verifyAcceptanceReceiptIntegrity(
  ctx: Pick<ServerCore, "bb" | "host" | "log">,
  input: {
    hostId: string;
    projectCwd: string;
    basePath?: string | null;
    runId: string;
    taskId: string;
    attemptId: string;
    homed?: boolean;
    task: { verification: Array<{ command: string }> };
    produced: readonly string[];
  },
): Promise<{ ok: true; receipt: VerdictReceipt | null } | { ok: false; kind: "hash_mismatch" | "not_run" | "fail" | "stale_proof"; reason: string }> {
  const receipt = await loadVerdictReceipt(ctx, input);
  if (!receipt) return { ok: true, receipt: null };
  const snapshot = await captureWorkspaceReceiptSnapshot({
    host: ctx.host,
    hostId: input.hostId,
    projectCwd: input.projectCwd,
    basePath: input.basePath,
  });
  if (!snapshot) {
    // Non-git mock host: still check contractHash and receipt integrity/verdict
    if (receipt.contractHash !== contractHashOf(input.task)) {
      logWarn(ctx, "WARN hash mismatch at acceptance (receipt refused)");
      return { ok: false, kind: "hash_mismatch", reason: "contract hash mismatch at acceptance" };
    }
    if (receipt.verdict !== "pass") {
      return { ok: false, kind: receipt.verdict === "not_run" ? "not_run" : "fail", reason: `verdict receipt is ${receipt.verdict}` };
    }
    return { ok: true, receipt };
  }

  let currencyVerdict: ProofCurrencyVerdict | null = null;
  if (input.produced.length > 0 && /^[0-9a-f]{40,}$/i.test(receipt.targetCommit)) {
    const targetDir = input.basePath || input.projectCwd;
    const currency = await proofCurrency({
      commit: receipt.targetCommit,
      paths: input.produced,
      git: hostGit((command) => runOnHost(ctx.host, { hostId: input.hostId, cwd: targetDir, command, timeoutSec: 15, timeoutMs: 15_000 })),
      receiptId: receipt.receiptHash.slice(0, 12),
      log: (line) => logInfo(ctx, line),
    });
    currencyVerdict = currency.verdict;
  }

  const verdict = acceptVerdictReceipt(receipt, {
    task: input.task,
    treeHash: snapshot.treeHash,
    targetCommit: snapshot.targetCommit,
    proofCurrencyVerdict: currencyVerdict,
  });
  if (!verdict.ok) {
    if (verdict.kind === "hash_mismatch") logWarn(ctx, "WARN hash mismatch at acceptance (receipt refused)");
    else if (verdict.kind === "stale_proof") logWarn(ctx, "WARN stale/unknown proof at acceptance");
    return verdict;
  }
  return { ok: true, receipt };
}
