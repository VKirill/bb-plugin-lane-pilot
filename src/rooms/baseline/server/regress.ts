import { relative } from "node:path";
import { getAttempt, getTask, listCheckDurations, listStageReceipts, taskBasePath } from "../../storage";
import type { RollbackApi, RollbackItem, RollbackTarget } from "../../rollback/server";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { readingFrom, readingNote } from "../../verification";
import {
  bisectCommand, bisectStepsFor, estimateSec, messageOwner, parseRegressSettings, planChecks,
  type RegressSettings, type VerificationItem,
} from "../logic";
import {
  closeRegression, getRegression, insertPass, insertRegression, lastPass, listRegressions, openRegression, releaseSettlement, settledByHand, touchRegression,
  type RegressionRecord,
} from "../store";

/**
 * The regression pass after acceptance (SMA atlas delta D1-2: «regression of earlier phases», «seven-day rollback watch»).
 *
 * A task accepted with green checks can go red later, when other work lands on top of it. The pass takes the last N accepted tasks of a
 * project (within the last K days), puts the project's current main in ONE throwaway worktree and runs their verification[] there. Mode
 * `cheap` (the default, the nightly watch) leaves out a check over the cap; mode `full` (the run-goal check) does not. A check with
 * secrets is left out either way; a command shared by several tasks runs once; a main that
 * did not move since the last pass is not run again. A check that was green at acceptance and is red now is confirmed green at its own merge
 * commit, then `git bisect` between that commit and main, in a scratch worktree, names the first bad commit and the task it belongs to.
 * The finding is a row (`lane_pilot_regression`) the morning list reads. Nothing is ever reverted or merged by the pass.
 */

export type RegressOptions = {
  projectId?: string | undefined;
  lastN?: number | undefined;
  days?: number | undefined;
  /** Run the checks and report, write nothing and bisect nothing. */
  dryRun?: boolean | undefined;
  /** Only pick the tasks and the checks and say what would run. */
  plan?: boolean | undefined;
  /** Run even if main has not moved since the last pass. */
  force?: boolean | undefined;
  /** Only the tasks of this run, all of them (the run-goal check, src/rooms/run-goal); implies force. */
  runId?: string | undefined;
  /** Only the tasks whose base checkout is one of these (a phase candidate's trees, src/rooms/phase/server/candidate.ts). */
  basePaths?: readonly string[] | undefined;
  /** cheap: drop a check over regress.check_cap_sec. full: run it. Secrets stay out of both. Default cheap. */
  mode?: "cheap" | "full" | undefined;
  signal?: AbortSignal | undefined;
  now?: number | undefined;
};

/** A check whose green value is the package's own version: every legitimate bump makes it red — never a regression (W32 rank 8). */
const pinsPackageVersion = (command: string): boolean => /package\.json/.test(command) && /"version"/.test(command);

export type TaskReport = {
  taskId: string; attemptId: string | null; mergeCommit: string | null;
  checks: Array<{ command: string; state: "green" | "red" | "unknown" | "skipped" | "planned"; note?: string | undefined }>;
  skipped?: string | undefined;
};

export type RegressFinding = {
  taskId: string; command: string; kind: "regression" | "unstable"; bisect: RegressionRecord["bisectStatus"]; culpritCommit: string | null; culpritTask: string | null;
  culpritSubject: string | null; note: string | null; id: number | null; fresh: boolean;
  /** The files the red task and the culprit task both changed (the run-goal check reads them to tell a meant rewrite from a break). */
  sharedFiles: string[];
};

export type ProjectPass = {
  projectId: string; head: string | null; skipped?: string; settings: RegressSettings; tasks: TaskReport[];
  findings: RegressFinding[]; closed: number[]; commandsRun: number; durationMs: number;
};

export type RegressResult = { dryRun: boolean; plan: boolean; projects: ProjectPass[]; open: RegressionRecord[] };

type Candidate = {
  target: RollbackTarget; attemptId: string; mergeCommit: string; eligible: VerificationItem[]; report: TaskReport;
};

const DAY = 86_400_000;
const tail = (text: string) => text.trim().slice(-300);
const keyOf = (item: VerificationItem, root: string) => `${root}\u0000${item.cwd}\u0000${item.command}`;

export function createRegression(ctx: ServerCore, services: Services) {
  const { db, host } = ctx;
  const log = (line: string) => ctx.log(line);
  const kit = (): RollbackApi["kit"] => (services.rollback as RollbackApi).kit;

  /**
   * The pass's worktrees, kept in KV while they live. A plugin reload in the middle of a pass skips its `finally`, and the worktree
   * stayed (regress-mvkeq7xe of cakekeeper.ru, 1.3 GB, left on 2026-10-23 and found four days later while the Mac mini's disk ran out).
   */
  const WORKTREE_KEY = "regress-worktree:";
  const LEFTOVER_AFTER_MS = 6 * 3_600_000;
  async function madeWorktree(t: RollbackTarget, name: string, commit: string): Promise<{ path: string } | { error: string }> {
    const result = await kit().makeWorktree(t, name, commit);
    if ("path" in result) await ctx.bb.storage.kv.set(`${WORKTREE_KEY}${result.path}`, { hostId: t.hostId, basePath: t.basePath, at: Date.now() }).catch(() => undefined);
    return result;
  }
  async function dropped(t: RollbackTarget, path: string): Promise<void> {
    await kit().dropWorktree(t, path);
    await ctx.bb.storage.kv.delete(`${WORKTREE_KEY}${path}`).catch(() => undefined);
  }
  /** Removes the worktrees a stopped pass left; a pass is bounded by four hours, so one older than six is nobody's. */
  async function sweepLeftovers(now: number): Promise<void> {
    for (const key of await ctx.bb.storage.kv.list(WORKTREE_KEY).catch(() => [] as string[])) {
      const entry = await ctx.bb.storage.kv.get(key).catch(() => null) as { hostId?: string; basePath?: string; at?: number } | null;
      if (!entry?.hostId || !entry.basePath || now - (entry.at ?? 0) < LEFTOVER_AFTER_MS) continue;
      const path = key.slice(WORKTREE_KEY.length);
      await dropped({ hostId: entry.hostId, basePath: entry.basePath } as RollbackTarget, path);
      log(`regress: removed a worktree a stopped pass left: ${path}`);
    }
  }

  async function head(hostId: string, basePath: string): Promise<string | null> {
    const base = await host.call("gitOwnershipBase", { requestedHostId: hostId, projectCwd: basePath }, { hostId, timeoutMs: 30_000 }).catch(() => null);
    return base?.status === "ready" ? base.headSha : null;
  }

  /** A read-only git question on the project's host, in its checkout. */
  async function ask(t: RollbackTarget, command: string): Promise<{ exitCode: number; stdout: string }> {
    const ran = await host.call("gateRun", { requestedHostId: t.hostId, basePath: t.basePath, command, timeoutSec: 60 }, { hostId: t.hostId, timeoutMs: 120_000 });
    return { exitCode: ran.exitCode, stdout: ran.stdout };
  }

  /** The checks the task passed when it was accepted; every check, when the stage receipt does not say. */
  function greenAtAcceptance(runId: string, taskId: string, items: readonly VerificationItem[]): Set<string> {
    const receipt = listStageReceipts(db, runId, taskId).find((row) => row.stageId === "verification");
    const rows = (receipt?.result as { verification?: unknown } | null | undefined)?.verification;
    if (Array.isArray(rows) && rows.length) {
      return new Set(rows.filter((row): row is { command: string; exitCode: number } => Boolean(row) && typeof (row as { command?: unknown }).command === "string" && (row as { exitCode?: unknown }).exitCode === 0).map((row) => row.command));
    }
    return new Set(items.map((item) => item.command));
  }

  async function candidatesOf(projectId: string, settings: RegressSettings, now: number, tasks: TaskReport[], runId: string | undefined, mode: "cheap" | "full"): Promise<Candidate[]> {
    const rows = (runId
      ? db.prepare(`SELECT a.id AS attempt_id, a.task_id AS task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
          WHERE r.project_id=? AND a.run_id=? AND a.state='accepted' ORDER BY a.updated_at DESC, a.rowid DESC`).all(projectId, runId)
      : db.prepare(`SELECT a.id AS attempt_id, a.task_id AS task_id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
          WHERE r.project_id=? AND a.state='accepted' AND a.updated_at>=? ORDER BY a.updated_at DESC, a.rowid DESC`).all(projectId, now - settings.days * DAY)) as Array<{ attempt_id: string; task_id: string }>;
    const seen = new Set<string>();
    const picked: Array<{ attempt_id: string; task_id: string }> = [];
    for (const row of rows) {
      if (seen.has(row.task_id)) continue;
      seen.add(row.task_id);
      picked.push(row);
      if (!runId && picked.length >= settings.lastN) break;
    }
    const out: Candidate[] = [];
    for (const row of picked) {
      const report: TaskReport = { taskId: row.task_id, attemptId: row.attempt_id, mergeCommit: null, checks: [] };
      tasks.push(report);
      const found = await kit().targetOf(row.attempt_id);
      if ("error" in found) { report.skipped = found.error; continue; }
      const { target } = found;
      if (!target.task.verification.length) { report.skipped = "the contract names no verification[]"; continue; }
      if (services.rollback.status(row.task_id).receipts.some((receipt) => receipt.kind === "revert" && receipt.state === "merged")) { report.skipped = "the task was reverted"; continue; }
      const change = await kit().changeOf(target, row.attempt_id).catch((cause: unknown) => ({ refused: cause instanceof Error ? cause.message : String(cause) }));
      if ("refused" in change) { report.skipped = change.refused; continue; }
      report.mergeCommit = change.mergeCommit;
      const green = greenAtAcceptance(target.runId, row.task_id, target.task.verification);
      const plan = planChecks(target.task.verification,
        (item) => estimateSec(listCheckDurations(db, projectId, { command: item.command, cwd: item.cwd, root: target.task.project_cwd }), item.timeout_sec ?? 120),
        { totalCapSec: Number.MAX_SAFE_INTEGER, perCheckCapSec: mode === "full" ? Number.MAX_SAFE_INTEGER : settings.checkCapSec });
      const eligible: VerificationItem[] = [];
      for (const entry of plan) {
        if (entry.skip) report.checks.push({ command: entry.item.command, state: "skipped", note: entry.skip });
        else if (!green.has(entry.item.command)) report.checks.push({ command: entry.item.command, state: "skipped", note: "it was not green when the task was accepted" });
        else { eligible.push(entry.item); report.checks.push({ command: entry.item.command, state: "planned" }); }
      }
      if (!eligible.length) { report.skipped = mode === "full" ? "no check that was green at acceptance" : "no cheap check that was green at acceptance"; continue; }
      out.push({ target, attemptId: row.attempt_id, mergeCommit: change.mergeCommit, eligible, report });
    }
    return out;
  }

  /** The first bad commit between the task's merge and main, and whose it is. */
  async function bisect(c: Candidate, item: VerificationItem, headSha: string, settings: RegressSettings): Promise<{ status: RegressionRecord["bisectStatus"]; commit: string | null; task: string | null; subject: string | null; note: string | null }> {
    const t = c.target;
    const range = await ask(t, `git merge-base --is-ancestor ${c.mergeCommit} ${headSha} && git rev-list --count ${c.mergeCommit}..${headSha}`).catch(() => null);
    if (!range || range.exitCode !== 0) return { status: "skipped", commit: null, task: null, subject: null, note: "the task's merge commit is not in the history of main any more (history was rewritten), so there is no range to bisect" };
    const commits = Number(range.stdout.trim());
    if (!Number.isFinite(commits) || commits < 1) return { status: "skipped", commit: null, task: null, subject: null, note: "main is still at the task's own merge commit" };
    const steps = bisectStepsFor(commits);
    if (steps > settings.bisectSteps) return { status: "skipped", commit: null, task: null, subject: null, note: `${commits} commits since the merge need ${steps} bisect steps, over the cap of ${settings.bisectSteps} (regress.bisect_steps)` };
    const inside = relative(t.basePath, item.cwd);
    const folder = inside.startsWith("..") ? "" : inside;
    const timeoutSec = Math.min(7200, (steps + 1) * settings.checkCapSec + 120);
    const found = await host.call("gateBisect", { requestedHostId: t.hostId, basePath: t.basePath, command: bisectCommand(folder, item.command), goodSha: c.mergeCommit, badSha: headSha, timeoutSec },
      { hostId: t.hostId, timeoutMs: (timeoutSec + 120) * 1000 }).catch((cause: unknown) => ({ status: "failed" as const, commit: null, reason: cause instanceof Error ? cause.message : String(cause) }));
    if (found.status === "failed") return { status: "failed", commit: null, task: null, subject: null, note: found.reason ?? "the bisect could not run" };
    if (found.status === "none" || !found.commit || !/^[a-f0-9]{7,64}$/.test(found.commit)) return { status: "none", commit: null, task: null, subject: null, note: `git bisect found no first bad commit in ${commits} commit(s): the check is flaky or depends on the machine` };
    const message = await ask(t, `git log -1 --format=%s ${found.commit}; echo '@@LP@@'; git log -1 --format=%B ${found.commit}; echo '@@LP@@'; m=$(git rev-list --merges --ancestry-path --reverse ${found.commit}..${headSha} | head -1); if [ -n "$m" ]; then git log -1 --format=%B "$m"; fi`).catch(() => null);
    const [subject = "", own = "", merge = ""] = (message?.stdout ?? "").split("@@LP@@\n");
    let owner = messageOwner(own);
    if (!owner.attemptId && !(owner.taskId && getTask(db, owner.taskId))) owner = messageOwner(merge);
    const task = (owner.attemptId ? getAttempt(db, owner.attemptId)?.task_id : null) ?? (owner.taskId && getTask(db, owner.taskId) ? owner.taskId : null);
    return { status: "found", commit: found.commit, task, subject: subject.trim().slice(0, 300) || null, note: null };
  }

  /** The files two tasks both changed, from the records of their accepted attempts. */
  function sharedFiles(taskA: string, taskB: string): string[] {
    const changed = (taskId: string) => new Set(services.rollback.status(taskId).attempts.filter((attempt) => attempt.state === "accepted").flatMap((attempt) => attempt.change?.changed.map((file) => file.path) ?? []));
    const other = changed(taskB);
    return [...changed(taskA)].filter((path) => other.has(path)).sort();
  }

  /** A check red now: is it a regression (green at its own merge commit) or only unstable, and who broke it. */
  async function judge(c: Candidate, item: VerificationItem, row: RollbackItem, headSha: string, settings: RegressSettings, dry: boolean): Promise<RegressFinding> {
    const base = { taskId: c.target.taskId, command: item.command };
    const finding = (patch: Partial<RegressFinding>): RegressFinding => ({ ...base, kind: "regression", bisect: "skipped", culpritCommit: null, culpritTask: null, culpritSubject: null, note: null, id: null, fresh: false, sharedFiles: [], ...patch });
    const existing = dry ? undefined : openRegression(db, c.target.taskId, item.command);
    if (existing) {
      const shared = existing.culpritTask ? sharedFiles(c.target.taskId, existing.culpritTask) : [];
      touchRegression(db, existing.id, headSha, { output: tail(row.tail), head: headSha, sharedFiles: shared });
      return finding({ kind: existing.kind, bisect: existing.bisectStatus, culpritCommit: existing.culpritCommit, culpritTask: existing.culpritTask, culpritSubject: existing.culpritSubject, note: existing.note, id: existing.id, sharedFiles: shared });
    }
    if (dry) return finding({ note: "dry run: not confirmed at the merge commit, not bisected" });
    const settled = settledByHand(db, c.target.taskId, item.command);
    if (settled) return finding({ kind: settled.kind, bisect: settled.bisectStatus, culpritCommit: settled.culpritCommit, culpritTask: settled.culpritTask, culpritSubject: settled.culpritSubject, id: settled.id,
      sharedFiles: settled.culpritTask ? sharedFiles(c.target.taskId, settled.culpritTask) : [],
      note: `settled by hand earlier (${settled.closedReason ?? "no reason"}): not opened again while the check stays red` });
    // A check pinned on the package's own version can only ever be red by a later, meant bump (W32 rank 8).
    if (pinsPackageVersion(item.command)) return finding({ note: "the check pins the package version: a later bump is meant, not a regression" });
    // Green at the merge commit too? A check that is red there as well never was a regression of later work.
    let kind: RegressFinding["kind"] = "regression";
    let note: string | null = null;
    const made = await madeWorktree(c.target, `regress-merge-${c.target.taskId}-${Date.now().toString(36)}`, c.mergeCommit);
    if ("path" in made) {
      try {
        // «Flaky or the machine» was a guess: the project's host says how loaded it is right before this run (not during it).
        const reading = readingFrom(await host.call("diskFree", { requestedHostId: c.target.hostId, path: c.target.basePath, machine: true }, { hostId: c.target.hostId, timeoutMs: 5_000 }).catch(() => null));
        const [again] = await kit().runChecks(c.target, made.path, [item]);
        if (again && !again.ok && !again.hostError) { kind = "unstable"; note = `red at its own merge commit ${c.mergeCommit.slice(0, 10)} as well: flaky or the machine, not later work; ${readingNote(reading)}`; }
      } finally { await dropped(c.target, made.path); }
    } else { note = `not confirmed at the merge commit (${made.error})`; }
    const found = kind === "regression" ? await bisect(c, item, headSha, settings) : { status: "skipped" as const, commit: null, task: null, subject: null, note: null };
    // A later task that changed the same files may have broken the check or changed what it pins on purpose (a release's version); the code cannot tell, the evidence says which files they share.
    const shared = found.task ? sharedFiles(c.target.taskId, found.task) : [];
    const stored = [note, found.note, shared.length ? `the culprit task changed the same file(s): ${shared.slice(0, 6).join(", ")}${shared.length > 6 ? ", ..." : ""}; if the change was meant, settle it with regress-close` : null].filter(Boolean).join("; ") || null;
    const id = insertRegression(db, { projectId: c.target.projectId, runId: c.target.runId, taskId: c.target.taskId, attemptId: c.attemptId, command: item.command, kind,
      greenAt: c.mergeCommit, redAt: headSha, bisectStatus: found.status, culpritCommit: found.commit, culpritTask: found.task, culpritSubject: found.subject, note: stored,
      evidence: { output: tail(row.tail), head: headSha, exitCode: row.exitCode, sharedFiles: shared } });
    log(`regress: ${c.target.taskId} \`${item.command}\` is red on main ${headSha.slice(0, 10)}${found.commit ? `, first bad commit ${found.commit.slice(0, 10)}${found.task ? ` (task ${found.task})` : ""}` : ` (${stored ?? "no culprit"})`}`);
    return finding({ kind, bisect: found.status, culpritCommit: found.commit, culpritTask: found.task, culpritSubject: found.subject, note: stored, id, fresh: true, sharedFiles: shared });
  }

  async function passFor(projectId: string, options: RegressOptions, deadline: number): Promise<ProjectPass> {
    const started = Date.now();
    const now = options.now ?? started;
    const values = (await ctx.effectiveProjectSettings(projectId).catch(() => ({ values: {} as Record<string, unknown> }))).values;
    const base = parseRegressSettings(values);
    const settings: RegressSettings = { ...base, ...(options.lastN ? { lastN: options.lastN } : {}), ...(options.days ? { days: options.days } : {}) };
    const dry = options.dryRun === true;
    const report: ProjectPass = { projectId, head: null, settings, tasks: [], findings: [], closed: [], commandsRun: 0, durationMs: 0 };
    const finish = (): ProjectPass => { report.durationMs = Date.now() - started; return report; };

    const mode = options.mode === "full" ? "full" : "cheap";
    const candidates = (await candidatesOf(projectId, settings, now, report.tasks, options.runId, mode))
      .filter((c) => !options.basePaths || options.basePaths.includes(c.target.basePath));
    // An open finding for a task that was reverted since is settled by that revert. Beside it the stale sweep (W32 rank 8):
    // rows that could never close by re-running — an unstable check flaky for a week, and a check pinned on the package
    // version — close here instead of rescanning forever.
    if (!dry && !options.plan) {
      for (const open of listRegressions(db, { projectId })) {
        if (services.rollback.status(open.taskId).receipts.some((r) => r.kind === "revert" && r.state === "merged") && closeRegression(db, open.id, "the task was reverted")) report.closed.push(open.id);
        else if (open.kind === "unstable" && open.foundAt <= now - 7 * DAY && closeRegression(db, open.id, "unstable for a week: flaky or the machine, not later work")) report.closed.push(open.id);
        else if (pinsPackageVersion(open.command) && closeRegression(db, open.id, "the check pins the package version: a later bump is meant, not a regression")) report.closed.push(open.id);
      }
    }
    if (options.plan) return finish();
    if (!candidates.length) { report.skipped = mode === "full" ? "no accepted task had a check to run" : "no accepted task with a cheap check in the window"; return finish(); }

    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) groups.set(`${c.target.hostId}\u0000${c.target.basePath}`, [...(groups.get(`${c.target.hostId}\u0000${c.target.basePath}`) ?? []), c]);
    for (const members of groups.values()) {
      const first = members[0]!.target;
      const headSha = await head(first.hostId, first.basePath);
      if (!headSha) { for (const m of members) m.report.skipped = "the project folder is not a git checkout"; continue; }
      report.head = headSha;
      // W32 rank 8: a finding whose merge commit left main's history can never be judged again (history was rewritten);
      // while it stays open it is rescanned on every pass.
      if (!dry) {
        for (const open of listRegressions(db, { projectId })) {
          if (!open.greenAt || taskBasePath(db, open.runId, open.taskId) !== first.basePath) continue;
          const ancestor = await ask(first, `git merge-base --is-ancestor ${open.greenAt} ${headSha}`).catch(() => null);
          if (ancestor && ancestor.exitCode !== 0 && closeRegression(db, open.id, `the merge commit is not in the history of main any more (${headSha.slice(0, 10)})`)) report.closed.push(open.id);
        }
      }
      const previous = lastPass(db, projectId);
      if (!options.force && !options.runId && !dry && previous?.headSha === headSha && now - previous.at < 20 * 3_600_000) {
        report.skipped = `main has not moved since the last pass (${headSha.slice(0, 10)})`;
        for (const m of members) m.report.skipped = report.skipped;
        continue;
      }
      const made = await madeWorktree(first, `regress-${Date.now().toString(36)}`, headSha);
      if ("error" in made) { for (const m of members) m.report.skipped = made.error; continue; }
      const cache = new Map<string, RollbackItem>();
      try {
        for (const c of members) {
          if (options.signal?.aborted || ctx.isDisposed()) { c.report.skipped = "stopped"; continue; }
          if (Date.now() > deadline || Date.now() - started > settings.budgetSec * 1000) { c.report.skipped = `over the time budget of the pass (${settings.budgetSec}s, regress.budget_sec)`; continue; }
          const fresh = c.eligible.filter((item) => !cache.has(keyOf(item, c.target.task.project_cwd)));
          if (fresh.length) {
            const ran = await kit().runChecks(c.target, made.path, fresh.map((item) => ({ ...item, timeout_sec: mode === "full" ? (item.timeout_sec ?? 120) : Math.min(item.timeout_sec ?? 120, settings.checkCapSec) }))).catch((cause: unknown) => { c.report.skipped = `the checks could not start: ${cause instanceof Error ? cause.message : String(cause)}`; return [] as RollbackItem[]; });
            ran.forEach((row, index) => { cache.set(keyOf(fresh[index]!, c.target.task.project_cwd), row); report.commandsRun += 1; });
          }
          for (const item of c.eligible) {
            const row = cache.get(keyOf(item, c.target.task.project_cwd));
            const line = c.report.checks.find((entry) => entry.command === item.command)!;
            if (!row) { line.state = "unknown"; continue; }
            if (row.hostError) { line.state = "unknown"; line.note = "the host could not run it"; continue; }
            if (row.ok) {
              line.state = "green";
              const open = dry ? undefined : openRegression(db, c.target.taskId, item.command);
              if (open && closeRegression(db, open.id, `green again on main ${headSha.slice(0, 10)}`)) report.closed.push(open.id);
              if (!dry && !open) releaseSettlement(db, c.target.taskId, item.command, headSha);
              continue;
            }
            line.state = "red";
            line.note = tail(row.tail);
            const settled = await judge(c, item, row, headSha, settings, dry).catch((cause: unknown) => {
              log(`regress: ${c.target.taskId} \`${item.command}\` red, judging failed: ${cause instanceof Error ? cause.message : String(cause)}`);
              return null;
            });
            if (settled) report.findings.push(settled);
          }
        }
      } finally {
        await dropped(first, made.path);
      }
    }
    if (!dry) {
      try { insertPass(db, { projectId, headSha: report.head, dryRun: false, durationMs: Date.now() - started, summary: { tasks: report.tasks.length, commandsRun: report.commandsRun, findings: report.findings.length, closed: report.closed.length, skipped: report.skipped ?? null } }); }
      catch (cause) { log(`regress pass of ${projectId} not kept: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return finish();
  }

  /** One pass over a project, or over every project with accepted work in the window. Read-only on the projects: worktrees only. */
  async function run(options: RegressOptions = {}): Promise<RegressResult> {
    const now = options.now ?? Date.now();
    await sweepLeftovers(Date.now()).catch((cause: unknown) => log(`regress: leftover sweep skipped: ${cause instanceof Error ? cause.message : String(cause)}`));
    const days = options.days ?? 365;
    const projects = options.projectId ? [options.projectId]
      : (db.prepare("SELECT DISTINCT r.project_id AS id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state='accepted' AND a.updated_at>=? ORDER BY r.project_id").all(now - days * DAY) as Array<{ id: string }>).map((row) => row.id);
    const deadline = now + 4 * 3_600_000;
    const passes: ProjectPass[] = [];
    for (const projectId of projects) {
      if (options.signal?.aborted || ctx.isDisposed()) break;
      passes.push(await passFor(projectId, options, deadline).catch((cause: unknown) => {
        log(`regress pass of ${projectId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return { projectId, head: null, skipped: `failed: ${cause instanceof Error ? cause.message : String(cause)}`, settings: parseRegressSettings({}), tasks: [], findings: [], closed: [], commandsRun: 0, durationMs: 0 } satisfies ProjectPass;
      }));
    }
    return { dryRun: options.dryRun === true, plan: options.plan === true, projects: passes, open: listRegressions(db, { projectId: options.projectId }) };
  }

  function list(options: { projectId?: string | undefined; all?: boolean | undefined } = {}): RegressionRecord[] {
    return listRegressions(db, { projectId: options.projectId, includeClosed: options.all === true });
  }

  /** The owner or the PM settles a finding by hand (the check was removed, the break was accepted). */
  function close(id: number, reason: string): { ok: boolean; reason: string } {
    if (!getRegression(db, id)) return { ok: false, reason: `no regression ${id}` };
    return closeRegression(db, id, reason) ? { ok: true, reason } : { ok: false, reason: `regression ${id} is closed already` };
  }

  /** The nightly pass: every project, the settings of each decide (regress.nightly off skips a project). */
  async function nightly(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const ids = (db.prepare("SELECT DISTINCT r.project_id AS id FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id WHERE a.state='accepted' AND a.updated_at>=? ORDER BY r.project_id").all(now - 60 * DAY) as Array<{ id: string }>).map((row) => row.id);
    for (const projectId of ids) {
      if (signal?.aborted || ctx.isDisposed()) return;
      const values = (await ctx.effectiveProjectSettings(projectId).catch(() => ({ values: {} as Record<string, unknown> }))).values;
      if (!parseRegressSettings(values).nightly) continue;
      const result = await run({ projectId, ...(signal ? { signal } : {}) });
      const pass = result.projects[0];
      if (pass) log(`regress nightly ${projectId}: ${pass.skipped ?? `${pass.tasks.length} task(s), ${pass.commandsRun} command(s) run, ${pass.findings.length} red, ${pass.closed.length} closed`}`);
    }
  }

  return { regression: { run, list, close, nightly } };
}

export type RegressionApi = ReturnType<typeof createRegression>["regression"];

/** Mounts the nightly pass at 03:25, after the rules scan and before the harness. */
export function mountRegress(ctx: ServerCore, api: RegressionApi): void {
  scheduleIsolated(ctx.bb, "regress-nightly", "25 3 * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    await api.nightly(signal).catch((cause: unknown) => ctx.log(`regress nightly failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 3 * 3_600_000 });
}
