import { resolve } from "node:path";
import type { ServerCore } from "../../contracts/server";
import { getAttempt, getRun, getRunWriterHost, getTask, taskBasePath } from "../../storage";
import { clearRevertIntent, getAttemptChange, listTaskReceipts, readRevertIntents, revertIntentKey, settleRevert, type RevertIntent, type RevertIntentKv } from "../store";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

type HostIdentity = { hostId: string; cwd: string };

const gitIdentity = async (host: ServerCore["host"], target: HostIdentity): Promise<{ commit: string; tree: string } | null> => {
  const ran = await host.call("runCommand", { requestedHostId: target.hostId, cwd: target.cwd, timeoutSec: 30,
    command: "commit=\"$(git rev-parse --verify HEAD)\" || exit $?; tree=\"$(git rev-parse --verify HEAD^{tree})\" || exit $?; printf 'COMMIT %s\\nTREE %s\\n' \"$commit\" \"$tree\"" },
    { hostId: target.hostId, timeoutMs: 45_000 }).catch(() => null) as { exitCode?: number; stdout?: string } | null;
  if (!ran || ran.exitCode !== 0) return null;
  const lines = String(ran.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const commit = lines.find((line) => line.startsWith("COMMIT "))?.slice(7);
  const tree = lines.find((line) => line.startsWith("TREE "))?.slice(5);
  return commit && tree && SHA.test(commit) && SHA.test(tree) && lines.length === 2 ? { commit, tree } : null;
};

const landedRevert = async (host: ServerCore["host"], intent: RevertIntent): Promise<{ landed: true; head: string } | { landed: false }> => {
  // Positive proof is monotonic: the expected scratch commit must now be in the base history. A negative answer is never a
  // verdict because the host may have dropped the RPC while gitIntegrate still owns the checkout.
  const q = shellQuote;
  const command = [
    `base=\"$(git rev-parse --verify HEAD)\" || exit $?`,
    `git cat-file -e ${q(`${intent.baseHead}^{commit}`)} || exit $?`,
    `git cat-file -e ${q(`${intent.expectedCommit}^{commit}`)} || exit $?`,
    `git merge-base --is-ancestor ${q(intent.baseHead)} \"$base\" || exit 20`,
    `git merge-base --is-ancestor ${q(intent.expectedCommit)} \"$base\" || exit 21`,
    `if git merge-base --is-ancestor ${q(intent.expectedCommit)} ${q(intent.baseHead)}; then exit 22; fi`,
    ...intent.changeSha.split(",").map((commit) => `git log --format=%B ${q(`${intent.baseHead}..${intent.expectedCommit}`)} | grep -F -q -e ${q(`This reverts commit ${commit}.`)} -e ${q(`This reverts commit ${commit},`)} || exit 24`),
    `git log --format=%B ${q(intent.baseHead)}..\"$base\" | grep -F -x -- ${q(intent.trailer)} >/dev/null || exit 25`,
    `tree=\"$(git rev-parse --verify ${q(`${intent.expectedCommit}^{tree}`)})\" || exit $?`,
    `[ \"$tree\" = ${q(intent.expectedTree)} ] || exit 23`,
    `printf 'BASE %s\\nTREE %s\\n' \"$base\" \"$tree\"`,
  ].join("; ");
  const ran = await host.call("runCommand", { requestedHostId: intent.hostId, cwd: intent.basePath, timeoutSec: 30, command },
    { hostId: intent.hostId, timeoutMs: 45_000 }).catch(() => null) as { exitCode?: number; stdout?: string } | null;
  if (!ran || ran.exitCode !== 0) return { landed: false };
  const lines = String(ran.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const head = lines.find((line) => line.startsWith("BASE "))?.slice(5);
  const tree = lines.find((line) => line.startsWith("TREE "))?.slice(5);
  return head && tree && SHA.test(head) && tree.toLowerCase() === intent.expectedTree.toLowerCase() && lines.length === 2 ? { landed: true, head } : { landed: false };
};

export function createRevertIntentRecovery(ctx: ServerCore, log: (line: string) => void) {
  const { db, host } = ctx;
  const kv = () => ctx.bb.storage.kv as unknown as RevertIntentKv;

  async function bindingValid(intent: RevertIntent, settled = false): Promise<boolean> {
    const run = getRun(db, intent.runId);
    const task = getTask(db, intent.taskId);
    if (!run || !task || task.run_id !== intent.runId || run.project_id !== intent.projectId) return false;
    const configured = typeof ctx.configForRun === "function" ? await ctx.configForRun(run.project_id, run).catch(() => null) : null;
    const actualHost = getRunWriterHost(db, intent.runId) ?? configured?.hostId;
    const actualBase = taskBasePath(db, intent.runId, intent.taskId);
    if (!actualHost || actualHost !== intent.hostId || !actualBase || resolve(actualBase) !== resolve(intent.basePath)) return false;
    const commits = intent.changeSha.split(",");
    if (commits.length !== intent.attemptIds.length) return false;
    if (intent.trailer !== `Lane-Pilot-Revert: ${intent.taskId}` || intent.opId !== revertOpId(intent.runId, intent.taskId, intent.attemptIds, intent.changeSha, intent.expectedCommit)) return false;
    return intent.attemptIds.every((attemptId, index) => {
      const attempt = getAttempt(db, attemptId);
      const change = getAttemptChange(db, attemptId);
      return Boolean(attempt && attempt.state === "accepted" && attempt.run_id === intent.runId && attempt.task_id === intent.taskId
        && change && change.runId === intent.runId && change.taskId === intent.taskId && change.mergeCommit === commits[index]
        && (change.outcome === "merged" || (settled && change.outcome === "reverted")));
    });
  }

  async function recoverRevertIntents(): Promise<string[]> {
    let keys: string[];
    try { keys = await kv().list("rollback-revert-intent:"); }
    catch (cause) { log(`rollback intents not listed: ${cause instanceof Error ? cause.message : String(cause)}`); return []; }
    const settled: string[] = [];
    for (const key of keys) {
      const parts = key.slice("rollback-revert-intent:".length).split(":");
      if (parts.length !== 3) { log(`rollback intent ${key} has an untrusted key; it remains pending`); continue; }
      let runId: string, taskId: string;
      try { runId = decodeURIComponent(parts[0]!); taskId = decodeURIComponent(parts[1]!); }
      catch { log(`rollback intent ${key} has an invalid identity; it remains pending`); continue; }
      const read = await readRevertIntents(kv(), runId, taskId);
      if (read.state !== "pending" || revertIntentKey(read.intent) !== key) { if (read.state === "unknown") log(read.reason); continue; }
      const intent = read.intent;
      const alreadySettled = intent.attemptIds.every((attemptId) => getAttemptChange(db, attemptId)?.outcome === "reverted");
      const matchingSettlement = listTaskReceipts(db, intent.taskId, "revert").some((receipt) => receipt.state === "merged" && receipt.runId === intent.runId
        && receipt.projectId === intent.projectId && receipt.changeSha === intent.changeSha && (receipt.detail as { opId?: unknown })?.opId === intent.opId);
      if (alreadySettled && !matchingSettlement) {
        log(`rollback intent ${intent.opId} has reverted rows without its matching settlement receipt; it remains pending`);
        continue;
      }
      if (!await bindingValid(intent, alreadySettled)) {
        log(`rollback intent ${intent.opId} has mismatched run, task, host, base, attempt, or change provenance; it remains pending`);
        continue;
      }
      if (alreadySettled) {
        try { await clearRevertIntent(kv(), intent); } catch (cause) { log(`rollback intent ${intent.opId} could not clear after settlement: ${cause instanceof Error ? cause.message : String(cause)}`); }
        continue;
      }
      const verdict = await landedRevert(host, intent);
      if (!verdict.landed) continue;
      try {
        settleRevert(db, { projectId: intent.projectId, runId: intent.runId, taskId: intent.taskId, attemptIds: intent.attemptIds,
          baseSha: intent.baseHead, changeSha: intent.changeSha, resultCommit: verdict.head,
          summary: `recovered rollback of ${intent.taskId} from durable intent; Git proves ${intent.expectedCommit.slice(0, 12)} is in main`,
          detail: { recoveredFromRevertIntent: true, opId: intent.opId, expectedCommit: intent.expectedCommit, expectedTree: intent.expectedTree } });
        await clearRevertIntent(kv(), intent);
        settled.push(intent.taskId);
      } catch (cause) { log(`rollback intent ${intent.opId} landed but could not settle: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return settled;
  }

  return { gitIdentity: (target: HostIdentity) => gitIdentity(host, target), recoverRevertIntents };
}

export const revertOpId = (runId: string, taskId: string, attempts: readonly string[], changeSha: string, expectedCommit: string) =>
  `${runId}/${taskId}/${attempts.join(",")}/${changeSha}/${expectedCommit}`;
