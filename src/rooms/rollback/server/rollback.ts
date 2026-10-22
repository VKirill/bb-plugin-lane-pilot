import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bookkeepingSetting } from "@lane-pilot/settings-catalog";
import { taskV2Schema, type PrototypeConfig, type TaskV2 } from "../../contracts";
import { getAttempt, getRun, getRunSettingsScopes, getRunWriterHost, getTask, loadProjectSettings, taskBasePath } from "../../storage";
import { retargetTask } from "../../tasks";
import { gateResolverFor, parseIntegrationGateSettings } from "../../verification/server";
import type { ServerCore, Services } from "../../core/server";
import {
  appendTaskReceipt, getAttemptChange, listTaskReceipts, upsertAttemptChange,
  type ChangedFile, type TaskReceipt, type TaskReceiptKind, type TaskReceiptState,
} from "../store";

/**
 * Rolling accepted work back, and proving it still holds (SMA wall 4 and rule 9; gap analysis P2-1, P2-2).
 *
 * - The record: every attempt gets its base (the commit its worktree started from), and what it changed, deletions included,
 *   so «roll back to what» is answered from the database. A merge adds main's HEAD before it and the merge commit.
 * - `reverify`: the task's verification[] again, on a fresh worktree of the merged change (the recorded base plus the
 *   accepted change), item by item, with a receipt.
 * - `revert`: `git revert` of the task's merge commit(s) in a scratch worktree, never a reset or a force; checked, then
 *   merged through the same base-checkout lock as every writer merge. A revert that conflicts with later work is refused
 *   with the commits to deal with first; nothing is guessed.
 */

const MERGE_QUEUE_MS = 15 * 60_000;
const GATE_TIMEOUT_SEC = 30 * 60;
const TAIL = 600;

export type RollbackItem = { command: string; exitCode: number; ok: boolean; hostError?: true; tail: string };

export type RollbackResult = {
  ok: boolean;
  state: TaskReceiptState;
  taskId: string;
  attemptId: string | null;
  /** The commit the accepted work started from, and the merge that put it in main. */
  base: string | null;
  change: string | null;
  summary: string;
  /** With a refusal: the one thing to do next. */
  next?: string;
  items?: RollbackItem[];
  receiptId?: number;
  [extra: string]: unknown;
};

export type RollbackTarget = {
  taskId: string; task: TaskV2; runId: string; projectId: string; hostId: string; basePath: string; config: PrototypeConfig;
};

const safeName = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 50);
const nonce = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const tail = (text: string) => text.trim().slice(-TAIL);

export function createRollback(ctx: ServerCore, services: Services) {
  const { db, host } = ctx;
  const log = (line: string) => ctx.log(line);

  // ---- the record ----

  /** The commit an attempt's worktree started from. The first one stays. Never throws: the record must not stop an attempt. */
  function noteBase(attemptId: string, baseSha: string | null | undefined): void {
    try {
      const attempt = getAttempt(db, attemptId);
      if (attempt && baseSha) upsertAttemptChange(db, { attemptId, runId: attempt.run_id, taskId: attempt.task_id }, { baseSha });
    } catch (cause) { log(`rollback record: base of ${attemptId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  /**
   * Makes sure the attempt has a base on record: the commit its workspace stood on when the writer started. A worktree Lane Pilot
   * made names its own (createWorktree); a BB environment, a folder in place or a continued writer asks git here. In the
   * background and never failing: the record must not slow or stop a start.
   */
  function ensureBase(attemptId: string, hostId: string, workspacePath: string): void {
    void (async () => {
      try {
        if (getAttemptChange(db, attemptId)?.baseSha) return;
        const base = await host.call("gitOwnershipBase", { requestedHostId: hostId, projectCwd: workspacePath }, { hostId, timeoutMs: 30_000 });
        if (base?.status === "ready") noteBase(attemptId, base.headSha);
      } catch (cause) { log(`rollback record: base of ${attemptId} not asked: ${cause instanceof Error ? cause.message : String(cause)}`); }
    })();
  }

  /** What a merge did: main before it, the merge commit and the files it changed. */
  function noteMerge(attemptId: string, merged: { status: string; commit: string | null; base?: string | null | undefined; changed?: ChangedFile[] | undefined }): void {
    try {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return;
      upsertAttemptChange(db, { attemptId, runId: attempt.run_id, taskId: attempt.task_id }, {
        outcome: merged.status, mergeCommit: merged.status === "merged" ? merged.commit : undefined,
        mergeParent: merged.base ?? undefined, changed: merged.status === "merged" ? merged.changed : undefined,
      });
    } catch (cause) { log(`rollback record: merge of ${attemptId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  /**
   * What an attempt's worktree holds, asked of git on the project's machine and written down: where it started, what it changed
   * (deletions as D), how much is uncommitted. Called when a stop is confirmed and before a failed attempt's worktree goes,
   * so the work that comes back is on record before anything is cleaned up (rule 9).
   */
  async function noteWorktree(input: { attemptId: string; hostId: string; basePath: string; worktreePath: string; outcome: string; savedAs?: string | null }): Promise<void> {
    try {
      const attempt = getAttempt(db, input.attemptId);
      if (!attempt) return;
      const state = await host.call("gitWorktreeState", { requestedHostId: input.hostId, basePath: input.basePath, worktreePath: input.worktreePath }, { hostId: input.hostId, timeoutMs: 60_000 });
      if (state.status !== "ready") {
        upsertAttemptChange(db, { attemptId: input.attemptId, runId: attempt.run_id, taskId: attempt.task_id }, { outcome: input.outcome });
        return;
      }
      upsertAttemptChange(db, { attemptId: input.attemptId, runId: attempt.run_id, taskId: attempt.task_id }, {
        baseSha: state.base, outcome: input.outcome, changed: state.changed,
        worktree: { head: state.head, dirty: state.dirty, ahead: state.ahead, savedAs: input.savedAs ?? null, at: Date.now() },
      });
    } catch (cause) { log(`rollback record: worktree of ${input.attemptId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  /** The worktree was returned (saved as a patch) and removed: where the saved work is goes on the attempt's record. */
  function noteSaved(attemptId: string, saved: { status: string; path: string | null; dirty: number; ahead: number } | undefined): void {
    try {
      const attempt = getAttempt(db, attemptId);
      if (!attempt || !saved || saved.status === "missing") return;
      const before = getAttemptChange(db, attemptId)?.worktree;
      upsertAttemptChange(db, { attemptId, runId: attempt.run_id, taskId: attempt.task_id }, {
        worktree: { head: before?.head ?? null, dirty: saved.dirty, ahead: saved.ahead, savedAs: saved.path, at: Date.now() },
      });
    } catch (cause) { log(`rollback record: saved work of ${attemptId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
  }

  /** A stop was confirmed: what the attempt's own worktree holds goes on record before anything is cleaned up (rule 9). A shared folder is not the attempt's to describe. */
  async function noteStopped(attemptId: string): Promise<void> {
    const attempt = getAttempt(db, attemptId);
    const basePath = attempt ? taskBasePath(db, attempt.run_id, attempt.task_id) : null;
    const hostId = attempt ? getRunWriterHost(db, attempt.run_id) : null;
    if (!attempt?.workspace_path || !basePath || !hostId || resolve(attempt.workspace_path) === resolve(basePath)) return;
    await noteWorktree({ attemptId, hostId, basePath, worktreePath: attempt.workspace_path, outcome: "stopped" });
  }

  // ---- finding what to roll back ----

  async function targetOf(ref: string): Promise<{ target: RollbackTarget; attemptId: string | null } | { error: string }> {
    const attempt = getAttempt(db, ref);
    const taskId = attempt ? attempt.task_id : ref;
    const row = getTask(db, taskId);
    if (!row) return { error: `no task or attempt "${ref}" in Lane Pilot's records` };
    const parsed = taskV2Schema.safeParse(row.contract);
    if (!parsed.success) return { error: `task ${taskId} has no readable contract` };
    const run = getRun(db, row.run_id);
    if (!run) return { error: `run ${row.run_id} of task ${taskId} is gone` };
    const config = await ctx.configForRun(run.project_id, run);
    const basePath = taskBasePath(db, run.id, taskId);
    const hostId = getRunWriterHost(db, run.id) ?? config?.hostId ?? null;
    if (!config || !basePath || !hostId) return { error: `the run of ${taskId} has no project folder or host recorded, so there is no checkout to work in` };
    return { target: { taskId, task: parsed.data, runId: run.id, projectId: run.project_id, hostId, basePath, config: { ...config, hostId } }, attemptId: attempt?.id ?? null };
  }

  /** The task's accepted attempts, newest first. */
  function acceptedAttempts(taskId: string): Array<{ id: string; updatedAt: number }> {
    return (db.prepare("SELECT id, updated_at AS updatedAt FROM lane_pilot_attempt WHERE task_id=? AND state='accepted' ORDER BY updated_at DESC, rowid DESC").all(taskId) as Array<{ id: string; updatedAt: number }>);
  }

  type Change = { attemptId: string; mergeCommit: string; mergeParent: string | null; changed: ChangedFile[] };

  /** The attempt's merge in main: from the record, else found in main by the attempt's trailer (work accepted before the record existed) and recorded. */
  async function changeOf(t: RollbackTarget, attemptId: string): Promise<Change | { refused: string }> {
    const recorded = getAttemptChange(db, attemptId);
    if (recorded?.mergeCommit) return { attemptId, mergeCommit: recorded.mergeCommit, mergeParent: recorded.mergeParent, changed: recorded.changed };
    const found = await host.call("gitMergeInfo", { requestedHostId: t.hostId, basePath: t.basePath, attemptId }, { hostId: t.hostId, timeoutMs: 60_000 });
    if (found.status !== "found" || !found.commit) {
      return { refused: found.status === "failed" ? `git could not look for the merge of attempt ${attemptId} in ${t.basePath}: ${found.reason ?? "unknown"}` : `attempt ${attemptId} left no merge commit in ${t.basePath} (it was accepted in place, in a folder without git, or its work was already in main)` };
    }
    if (!found.inMain) return { refused: `the merge ${found.commit.slice(0, 12)} of attempt ${attemptId} is no longer in the history of ${t.basePath} (history was rewritten)` };
    upsertAttemptChange(db, { attemptId, runId: t.runId, taskId: t.taskId }, { outcome: "merged", mergeCommit: found.commit, mergeParent: found.base, changed: found.changed });
    return { attemptId, mergeCommit: found.commit, mergeParent: found.base, changed: found.changed };
  }

  // ---- worktrees on the project's host ----

  async function makeWorktree(t: RollbackTarget, name: string, commit?: string): Promise<{ path: string } | { error: string }> {
    const created = await host.call("gitCreateWorktree", { requestedHostId: t.hostId, basePath: t.basePath, name: safeName(name), ...(commit ? { commit } : {}) },
      { hostId: t.hostId, timeoutMs: 120_000 }).catch((cause: unknown) => ({ status: "failed" as const, path: null, reason: cause instanceof Error ? cause.message : String(cause) }));
    if (created.status !== "ready" || !created.path) return { error: `could not make a worktree: ${created.reason ?? "unknown"}` };
    // Dependencies linked like a writer's worktree; a host that cannot still gets a clean tree.
    await host.call("gitPrepareWorktree", { requestedHostId: t.hostId, basePath: t.basePath, worktreePath: created.path }, { hostId: t.hostId, timeoutMs: 600_000 }).catch(() => undefined);
    return { path: created.path };
  }

  async function dropWorktree(t: RollbackTarget, path: string | null): Promise<void> {
    if (!path) return;
    await host.call("gitRemoveWorktree", { requestedHostId: t.hostId, basePath: t.basePath, worktreePath: path }, { hostId: t.hostId, timeoutMs: 60_000 })
      .catch((cause: unknown) => log(`rollback: could not remove ${path}: ${cause instanceof Error ? cause.message : String(cause)}`));
  }

  /** The task's verification[] on a tree, item by item. */
  async function runChecks(t: RollbackTarget, root: string, commands?: TaskV2["verification"]): Promise<RollbackItem[]> {
    const task = retargetTask({ ...t.task, verification: commands ?? t.task.verification }, root);
    if (!task.verification.length) return [];
    const results = await services.runVerification(t.config, task, t.runId);
    return results.map((row) => ({
      command: row.command, exitCode: row.exitCode, ok: row.exitCode === 0 && !row.hostError,
      ...(row.hostError ? { hostError: true as const } : {}), tail: row.exitCode === 0 ? "" : tail(`${row.stderr}\n${row.stdout}`),
    }));
  }

  function receipt(t: RollbackTarget, kind: TaskReceiptKind, state: TaskReceiptState, summary: string, extra: Partial<Pick<TaskReceipt, "attemptId" | "baseSha" | "changeSha" | "resultCommit">> & { detail?: unknown } = {}): number {
    try {
      return appendTaskReceipt(db, { kind, projectId: t.projectId, runId: t.runId, taskId: t.taskId, state, summary, attemptId: extra.attemptId ?? null,
        baseSha: extra.baseSha ?? null, changeSha: extra.changeSha ?? null, resultCommit: extra.resultCommit ?? null, detail: extra.detail ?? {} });
    } catch (cause) { log(`rollback receipt not kept: ${cause instanceof Error ? cause.message : String(cause)}`); return 0; }
  }

  const refuse = (t: RollbackTarget | null, kind: TaskReceiptKind, ref: string, reason: string, next: string, extra: { attemptId?: string | null; detail?: unknown } = {}): RollbackResult => {
    const taskId = t?.taskId ?? ref;
    const receiptId = t ? receipt(t, kind, "refused", reason, { attemptId: extra.attemptId ?? null, detail: { next, ...(extra.detail as object | undefined) } }) : 0;
    return { ok: false, state: "refused", taskId, attemptId: extra.attemptId ?? null, base: null, change: null, summary: reason, next, ...(receiptId ? { receiptId } : {}), ...(extra.detail as object | undefined) };
  };

  // ---- reverify ----

  /**
   * The task's verification[] again, on the recorded base plus the accepted change: a fresh worktree of the merge commit
   * (its tree is the base with the change on it). One command, no prompts; the answer is per item and a receipt is kept.
   */
  async function reverify(ref: string): Promise<RollbackResult> {
    const found = await targetOf(ref);
    if ("error" in found) return { ok: false, state: "refused", taskId: ref, attemptId: null, base: null, change: null, summary: found.error, next: "check the id with `bb lane-pilot state <project-id>`" };
    const { target: t } = found;
    const accepted = acceptedAttempts(t.taskId);
    const attemptId = found.attemptId ?? accepted[0]?.id ?? null;
    if (!attemptId) return refuse(t, "reverify", ref, `task ${t.taskId} has no accepted attempt, so there is no accepted change to check`, `redispatch the task, or pass an attempt that was accepted`);
    if (getAttempt(db, attemptId)?.state !== "accepted") return refuse(t, "reverify", ref, `attempt ${attemptId} is ${getAttempt(db, attemptId)?.state}, not accepted: its work is not in main`, `reverify the task's accepted attempt${accepted[0] ? ` (${accepted[0].id})` : ""}`, { attemptId });
    if (!t.task.verification.length) return refuse(t, "reverify", ref, `task ${t.taskId} has no verification[] to run`, `nothing to do; the contract named no checks`, { attemptId });
    const change = await changeOf(t, attemptId);
    if ("refused" in change) return refuse(t, "reverify", ref, change.refused, `check the task's result with \`bb lane-pilot state\`; a task accepted in place has no commit to check out`, { attemptId });
    const made = await makeWorktree(t, `reverify-${safeName(t.taskId)}-${nonce()}`, change.mergeCommit);
    if ("error" in made) {
      const id = receipt(t, "reverify", "error", made.error, { attemptId, baseSha: change.mergeParent, changeSha: change.mergeCommit });
      return { ok: false, state: "error", taskId: t.taskId, attemptId, base: change.mergeParent, change: change.mergeCommit, summary: made.error, next: "check the disk and the project host, then run it again", receiptId: id };
    }
    try {
      let items: RollbackItem[];
      try { items = await runChecks(t, made.path); }
      catch (cause) {
        const reason = `the checks could not start: ${cause instanceof Error ? cause.message : String(cause)}`;
        const id = receipt(t, "reverify", "error", reason, { attemptId, baseSha: change.mergeParent, changeSha: change.mergeCommit });
        return { ok: false, state: "error", taskId: t.taskId, attemptId, base: change.mergeParent, change: change.mergeCommit, summary: reason, next: "fix what the message names (a secret, the host) and run it again", receiptId: id };
      }
      const failed = items.filter((row) => !row.ok);
      const unknown = failed.some((row) => row.hostError);
      const state: TaskReceiptState = failed.length === 0 ? "passed" : unknown && failed.every((row) => row.hostError) ? "error" : "failed";
      // The change is checked as it was accepted, not as main stands now: a task already reverted says so.
      const revertedIn = listTaskReceipts(db, t.taskId, "revert").find((row) => row.state === "merged")?.resultCommit ?? null;
      const summary = `${items.length - failed.length}/${items.length} checks of ${t.taskId} pass on ${change.mergeCommit.slice(0, 12)} (base ${change.mergeParent?.slice(0, 12) ?? "unknown"})${revertedIn ? `; the task was reverted in ${revertedIn.slice(0, 12)}, this is the change as it was accepted` : ""}`;
      const id = receipt(t, "reverify", state, summary, { attemptId, baseSha: change.mergeParent, changeSha: change.mergeCommit, detail: { items, revertedIn } });
      return { ok: state === "passed", state, taskId: t.taskId, attemptId, base: change.mergeParent, change: change.mergeCommit, summary, items, receiptId: id, revertedIn,
        ...(state === "passed" ? {} : { next: state === "error" ? "the host could not run the checks; run it again" : "the accepted change no longer passes its own checks: look at the failing items, or `bb lane-pilot revert " + t.taskId + "`" }) };
    } finally {
      await dropWorktree(t, made.path);
    }
  }

  // ---- revert ----

  /** Merges the revert through the base-checkout lock, waiting in the queue like every writer merge. */
  async function mergeRevert(t: RollbackTarget, worktreePath: string, message: string): Promise<{ status: string; commit: string | null; reason: string | null; conflicts: string[] }> {
    const settings = loadProjectSettings(db, t.projectId, getRunSettingsScopes(db, t.runId));
    const integrate = () => host.call("gitIntegrate", { requestedHostId: t.hostId, basePath: t.basePath, worktreePath, message, removeWorktree: true, bookkeeping: bookkeepingSetting(settings) },
      { hostId: t.hostId, timeoutMs: 180_000 });
    let merged = await integrate();
    const since = Date.now();
    while (merged.status === "busy" && Date.now() - since < MERGE_QUEUE_MS && !ctx.isDisposed()) {
      await sleep(20_000);
      merged = await integrate();
    }
    return { status: merged.status, commit: merged.commit, reason: merged.reason, conflicts: merged.conflicts };
  }

  /** "taskid: title" is how every writer commit starts; the later commits that block a revert are named by their task. */
  const taskOfSubject = (subject: string) => /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}): /.exec(subject)?.[1] ?? null;

  async function revert(ref: string, options: { dryRun?: boolean; skipGate?: boolean } = {}): Promise<RollbackResult> {
    const found = await targetOf(ref);
    if ("error" in found) return { ok: false, state: "refused", taskId: ref, attemptId: null, base: null, change: null, summary: found.error, next: "check the id with `bb lane-pilot state <project-id>`" };
    const { target: t } = found;
    const attempts = found.attemptId ? [{ id: found.attemptId, updatedAt: 0 }] : acceptedAttempts(t.taskId);
    if (!attempts.length) return refuse(t, "revert", ref, `task ${t.taskId} has no accepted attempt: nothing of it is in main to revert`, `a task that did not land needs no revert; cancel or redispatch it`);
    const changes: Change[] = [];
    for (const attempt of attempts) {
      if (getAttempt(db, attempt.id)?.state !== "accepted") return refuse(t, "revert", ref, `attempt ${attempt.id} is ${getAttempt(db, attempt.id)?.state}, not accepted: its work is not in main`, `revert the task by its id to take every accepted attempt`, { attemptId: attempt.id });
      const change = await changeOf(t, attempt.id);
      if ("refused" in change) return refuse(t, "revert", ref, change.refused, `without a merge commit there is nothing for git revert to undo; restore the files by hand or dispatch a task that removes the work`, { attemptId: attempt.id });
      changes.push(change);
    }
    const commits = changes.map((change) => change.mergeCommit);
    const changeSha = commits.join(",");
    const previous = listTaskReceipts(db, t.taskId, "revert").find((row) => row.state === "merged" && row.changeSha === changeSha);
    if (previous) return refuse(t, "revert", ref, `task ${t.taskId} was already reverted in ${previous.resultCommit?.slice(0, 12) ?? "main"}`, `nothing to do`, { attemptId: changes[0]!.attemptId });
    const oldest = changes[changes.length - 1]!;
    const files = [...new Map(changes.flatMap((change) => change.changed).map((file) => [file.path, file])).values()];
    const attemptId = changes[0]!.attemptId;

    const scratch = await makeWorktree(t, `revert-${safeName(t.taskId)}-${nonce()}`);
    if ("error" in scratch) {
      const id = receipt(t, "revert", "error", scratch.error, { attemptId, baseSha: oldest.mergeParent, changeSha });
      return { ok: false, state: "error", taskId: t.taskId, attemptId, base: oldest.mergeParent, change: changeSha, summary: scratch.error, next: "check the disk and the project host, then run it again", receiptId: id };
    }
    let baseline: { path: string } | null = null;
    let handedOver = false;
    try {
      const reverted = await host.call("gitRevertCommits", { requestedHostId: t.hostId, worktreePath: scratch.path, commits }, { hostId: t.hostId, timeoutMs: 120_000 });
      if (reverted.status === "conflict") {
        const later = reverted.later.map((entry) => ({ ...entry, task: taskOfSubject(entry.subject) }));
        const tasks = [...new Set(later.map((entry) => entry.task).filter((name): name is string => Boolean(name) && name !== t.taskId))];
        const next = `later commits change the same lines (${later.slice(0, 4).map((entry) => `${entry.sha.slice(0, 10)} ${entry.subject}`).join("; ") || "see conflicts"}). Revert ${tasks.length ? tasks.map((name) => `\`bb lane-pilot revert ${name}\``).join(" and ") + " first, or" : "those first, or"} dispatch a task whose objective is to remove ${t.taskId}'s change by hand on current main.`;
        return refuse(t, "revert", ref, reverted.reason ?? "the revert conflicts with later commits", next, { attemptId, detail: { conflicts: reverted.conflicts, later } });
      }
      if (reverted.status === "empty") return refuse(t, "revert", ref, reverted.reason ?? "the change is already undone", `nothing to do`, { attemptId });
      if (reverted.status !== "reverted") {
        const id = receipt(t, "revert", "error", reverted.reason ?? "git revert failed", { attemptId, baseSha: oldest.mergeParent, changeSha });
        return { ok: false, state: "error", taskId: t.taskId, attemptId, base: oldest.mergeParent, change: changeSha, summary: reverted.reason ?? "git revert failed", next: "look at the project's git state on its host and run it again", receiptId: id };
      }

      // The task's own checks, where they mean something: a check that is red on the reverted tree but was green on the commit
      // before the task blocks; one that is red there too (it tests the feature itself, or main was red already) is only noted.
      const verification: { ran: RollbackItem[]; blocking: RollbackItem[]; notMeaningful: RollbackItem[] } = { ran: [], blocking: [], notMeaningful: [] };
      try { verification.ran = await runChecks(t, scratch.path); }
      catch (cause) {
        const reason = `the task's checks could not start on the reverted tree: ${cause instanceof Error ? cause.message : String(cause)}`;
        const id = receipt(t, "revert", "error", reason, { attemptId, baseSha: oldest.mergeParent, changeSha });
        return { ok: false, state: "error", taskId: t.taskId, attemptId, base: oldest.mergeParent, change: changeSha, summary: reason, next: "fix what the message names and run it again", receiptId: id };
      }
      const red = verification.ran.filter((row) => !row.ok);
      if (red.length) {
        const baseCommit = oldest.mergeParent;
        const made = baseCommit ? await makeWorktree(t, `revert-base-${safeName(t.taskId)}-${nonce()}`, baseCommit) : null;
        if (made && "path" in made) {
          baseline = made;
          const wanted = t.task.verification.filter((command) => red.some((row) => row.command === command.command));
          const before = await runChecks(t, made.path, wanted).catch(() => [] as RollbackItem[]);
          for (const row of red) (before.find((entry) => entry.command === row.command)?.ok ? verification.blocking : verification.notMeaningful).push(row);
        } else {
          verification.blocking.push(...red);
        }
      }

      // The project's own checks (the integration gate command, explicit or detected), on the reverted tree.
      let gate: { command: string; exitCode: number; baselineRed: boolean; tail: string } | null = null;
      if (!options.skipGate) {
        const resolved = await gateResolverFor(ctx)({ runId: t.runId, hostId: t.hostId, basePath: t.basePath,
          gate: parseIntegrationGateSettings(loadProjectSettings(db, t.projectId, getRunSettingsScopes(db, t.runId))) }).catch(() => null);
        if (resolved) {
          const ran = await host.call("gateRun", { requestedHostId: t.hostId, basePath: scratch.path, command: resolved.command, timeoutSec: GATE_TIMEOUT_SEC },
            { hostId: t.hostId, timeoutMs: (GATE_TIMEOUT_SEC + 60) * 1000 });
          gate = { command: resolved.command, exitCode: ran.exitCode, baselineRed: false, tail: ran.exitCode === 0 ? "" : tail(`${ran.stderr}\n${ran.stdout}`) };
          if (ran.exitCode !== 0) {
            // Red on main already: the revert did not make it so.
            const onMain = await host.call("gateRun", { requestedHostId: t.hostId, basePath: t.basePath, command: resolved.command, timeoutSec: GATE_TIMEOUT_SEC },
              { hostId: t.hostId, timeoutMs: (GATE_TIMEOUT_SEC + 60) * 1000 }).catch(() => null);
            gate.baselineRed = Boolean(onMain && onMain.exitCode !== 0);
          }
        }
      }
      const gateBlocks = Boolean(gate && gate.exitCode !== 0 && !gate.baselineRed);
      const detail = { files, checks: verification, gate };

      if (verification.blocking.length || gateBlocks) {
        const names = [...verification.blocking.map((row) => row.command), ...(gateBlocks ? [gate!.command] : [])];
        const reason = `reverting ${t.taskId} breaks ${names.join(", ")}, which pass without the revert`;
        return refuse(t, "revert", ref, reason, `look at the failing output in the receipt (bb lane-pilot state), fix main by hand or dispatch a task that removes ${t.taskId}'s change together with what depends on it`, { attemptId, detail });
      }
      const summary = `revert of ${t.taskId} (${commits.map((sha) => sha.slice(0, 10)).join(", ")}) is clean: ${files.length} file(s) restored, ${verification.ran.length - verification.blocking.length - verification.notMeaningful.length}/${verification.ran.length} task checks green${verification.notMeaningful.length ? `, ${verification.notMeaningful.length} not meaningful (red before the task too)` : ""}${gate ? `, gate ${gate.exitCode === 0 ? "green" : "red as on main"}` : ""}`;
      if (options.dryRun) {
        const id = receipt(t, "revert", "dry_run", summary, { attemptId, baseSha: oldest.mergeParent, changeSha, detail });
        return { ok: true, state: "dry_run", taskId: t.taskId, attemptId, base: oldest.mergeParent, change: changeSha, summary, receiptId: id, files, checks: verification, gate };
      }

      const merged = await mergeRevert(t, scratch.path, `Revert ${t.taskId}\n\nReverts ${commits.join(", ")}\nLane-Pilot-Revert: ${t.taskId}`);
      if (merged.status !== "merged" && merged.status !== "up-to-date") {
        const reason = merged.status === "conflict" ? `main moved while the revert was checked and the merge conflicts in ${merged.conflicts.join(", ") || "its files"}` : `the merge did not land: ${merged.status}${merged.reason ? ` (${merged.reason})` : ""}`;
        return refuse(t, "revert", ref, reason, merged.status === "busy" ? "another merge held the base checkout for 15 minutes; run the revert again" : "run the revert again on the new main", { attemptId, detail });
      }
      handedOver = true;
      const id = receipt(t, "revert", "merged", summary, { attemptId, baseSha: oldest.mergeParent, changeSha, resultCommit: merged.commit, detail });
      for (const change of changes) upsertAttemptChange(db, { attemptId: change.attemptId, runId: t.runId, taskId: t.taskId }, { outcome: "reverted" });
      log(`rollback: ${t.taskId} reverted in ${merged.commit?.slice(0, 12) ?? "main"}`);
      return { ok: true, state: "merged", taskId: t.taskId, attemptId, base: oldest.mergeParent, change: changeSha, summary, receiptId: id, commit: merged.commit, files, checks: verification, gate };
    } finally {
      // After a merge the host removed the scratch worktree itself (removeWorktree); anything else is dropped here, with its branch.
      if (!handedOver) await dropWorktree(t, scratch.path);
      await dropWorktree(t, baseline?.path ?? null);
    }
  }

  /** What is on record for a task or an attempt: its attempts' bases, merges and changed files, and the receipts. */
  function status(ref: string) {
    const attempt = getAttempt(db, ref);
    const taskId = attempt ? attempt.task_id : ref;
    const attempts = (db.prepare("SELECT id, state FROM lane_pilot_attempt WHERE task_id=? ORDER BY attempt_no").all(taskId) as Array<{ id: string; state: string }>)
      .map((row) => ({ ...row, change: getAttemptChange(db, row.id) ?? null }));
    return { taskId, attempts, receipts: listTaskReceipts(db, taskId) };
  }

  /**
   * The pieces the baseline and the regression pass reuse (src/rooms/baseline): the task's target, its merge, a throwaway worktree on the
   * project's host and the task's checks in it. Nothing here writes to the project's checkout.
   */
  const kit = { targetOf, changeOf, makeWorktree, dropWorktree, runChecks };

  return { rollback: { noteBase, ensureBase, noteMerge, noteWorktree, noteSaved, noteStopped, reverify, revert, status, kit } };
}

export type RollbackApi = ReturnType<typeof createRollback>["rollback"];
