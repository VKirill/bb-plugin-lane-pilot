import { resolvePlanningHome } from "../../../contracts";
import { type ServerCore } from "../../../contracts/server";
import { resolveWriterBinding, type ProjectSourceBinding } from "../../../native-agent";
import { isPmChat } from "../../../native-agent/server";
import { closeOwnerItem, listOpenOwnerItemKeys } from "../../../owner-waiting";
import { sendServiceMessage } from "../../../relay/server";
import { listCliPmProjects, listCliPmThreads, loadPrototypeConfig, planningHomeInputs } from "../../../storage";
import { bindBacklogIssued } from "../../../tasks/server";
import {
  backlogBoard,
  backlogReadCommand,
  issueMessage,
  offerKey,
  parseBacklogOutput,
  PER_DAY,
  PER_PROJECT_PER_DAY,
  type BacklogBoard,
  type TodoMeta,
} from "../../models/backlog";
import {
  backlogIssuedTo,
  countIssuedSince,
  countProjectIssuedSince,
  listIssuedTodoIds,
  readLastScanAt,
  recordBacklogIssue,
  scanMinutesOf,
  writeLastScanAt,
} from "../repositories/backlog-repository";

/**
 * The backlog scanner (SMA D2-9). Every hour, for each project whose owner's PM chat (a run of kind `cli`) was active in the last two weeks,
 * it reads `.agents/todos/items/*\/meta.yaml` on the project's host and issues the first issuable item to that PM: one per project a day and
 * three a day in all, each item once. Nothing else is touched: the PM writes the contract, and the item's status stays the PM's.
 */
const DAY = 86_400_000;

export function createBacklog(ctx: ServerCore) {
  const { db, bb, host } = ctx;
  // The queue tool asks who an item was issued to before it closes the item (SMA m_in_close_line): this room answers.
  bindBacklogIssued(db, (projectId, todoId) => backlogIssuedTo(db, projectId, todoId));

  // Reload closes SQLite while a scan may still be awaiting KV, SDK or host reads.
  function assertActive(): void {
    if (ctx.isDisposed()) throw new Error("backlog stopped: plugin disposed");
  }

  /** The project's newest owner PM chat active in the last two weeks, or null. */
  async function pmOf(projectId: string, now: number): Promise<string | null> {
    assertActive();
    const rows = listCliPmThreads(db, projectId, now - 14 * DAY);
    // A workflow architect's chat has a run and the role pm too, marked by architectProjectId; the backlog's task goes to the owner's PM chat only.
    for (const row of rows) {
      assertActive();
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: row.pm_thread_id }).catch(() => null) as Record<string, unknown> | null;
      assertActive();
      if (metadata?.role === "pm" && !metadata.architectProjectId && await isPmChat(ctx, row.pm_thread_id)) return row.pm_thread_id;
    }
    return null;
  }

  /** Canonical writer workspace for the project: project.sources wins over stale legacy PrototypeConfig paths (P00.05). */
  async function workspaceOf(projectId: string): Promise<{ hostId: string; writerWorkspacePath: string } | null> {
    assertActive();
    const config = loadPrototypeConfig(db, projectId);
    let sources: ProjectSourceBinding[] = [];
    if (typeof bb.sdk?.projects?.get === "function") {
      let proj: { sources?: unknown } | null = null;
      try {
        proj = await bb.sdk.projects.get({ projectId }) as { sources?: unknown } | null;
      } catch {
        proj = null;
      }
      assertActive();
      if (Array.isArray(proj?.sources)) {
        sources = proj.sources.filter(
          (row): row is ProjectSourceBinding =>
            Boolean(row && typeof row === "object" && typeof (row as { hostId?: unknown }).hostId === "string" && typeof (row as { path?: unknown }).path === "string"),
        );
      }
    }
    const resolved = resolveWriterBinding({
      projectId,
      sources,
      explicit: { hostId: config?.hostId ?? null, path: config?.writerWorkspacePath ?? null },
    });
    if (resolved.status === "resolved") {
      return { hostId: resolved.hostId, writerWorkspacePath: resolved.path };
    }
    return config?.hostId && config?.writerWorkspacePath
      ? { hostId: config.hostId, writerWorkspacePath: config.writerWorkspacePath }
      : null;
  }

  /** The planning home `.agents/todos` is read under (SMA d_project_planning), checked on the project's host the first time; null: the checkout. */
  function homeOf(projectId: string, config: { hostId: string; writerWorkspacePath: string }): Promise<string | null> {
    return resolvePlanningHome({ host: host as never, hostId: config.hostId, cwd: config.writerWorkspacePath, inputs: planningHomeInputs(db, projectId), log: bb.log });
  }

  /** The project's meta.yaml items as they are on its host right now (no fetch; the board fetches first). */
  async function items(projectId: string): Promise<TodoMeta[]> {
    assertActive();
    const config = await workspaceOf(projectId);
    if (!config?.writerWorkspacePath) return [];
    const planningHome = await homeOf(projectId, config);
    assertActive();
    const ran = await host.call("gateRun", { requestedHostId: config.hostId, basePath: planningHome ?? config.writerWorkspacePath, command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    return parseBacklogOutput(ran.stdout);
  }

  async function board(projectId: string): Promise<BacklogBoard & { error?: string; readAt?: string; fetched?: boolean; behind?: number | null; lastScanAt?: number | null }> {
    assertActive();
    const readAt = new Date().toISOString();
    const scannedAt = await readLastScanAt(bb.storage.kv, projectId);
    assertActive();
    const config = await workspaceOf(projectId);
    if (!config?.writerWorkspacePath) return { issuable: [], needsEstimate: [], decompose: [], blocked: [], readAt, fetched: false, behind: null, lastScanAt: scannedAt, error: "the project has no workspace configured" };
    // Fresh data first (SMA m_in_scan): fetch, then read; whoever sees the result gets its age and how far the branch is behind.
    const freshened = await host.call("gateRun", { requestedHostId: config.hostId, basePath: config.writerWorkspacePath, command: "git fetch --quiet && git rev-list --count HEAD..@{u}", timeoutSec: 20 }, { hostId: config.hostId, timeoutMs: 30_000 })
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    assertActive();
    const fetched = freshened.exitCode === 0;
    const behindCount = Number((freshened.stdout ?? "").trim());
    const behind = fetched && Number.isFinite(behindCount) ? behindCount : null;
    const planningHome = await homeOf(projectId, config);
    assertActive();
    const ran = await host.call("gateRun", { requestedHostId: config.hostId, basePath: planningHome ?? config.writerWorkspacePath, command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));
    assertActive();
    const issued = listIssuedTodoIds(db, projectId);
    const result = backlogBoard(parseBacklogOutput(ran.stdout));
    return { ...result, issuable: result.issuable.filter((item) => !issued.has(item.id)), readAt, fetched, behind, lastScanAt: scannedAt };
  }

  /**
   * Checks eligible projects and issues the first ready todo to the project's PM autonomously under PER_PROJECT_PER_DAY
   * and PER_DAY with no owner card created.
   */
  async function scan(now = Date.now(), options?: { projectId?: string; force?: boolean }) {
    assertActive();
    const issuedToday = () => countIssuedSince(db, now - DAY);
    const allProjects = listCliPmProjects(db, now - 14 * DAY);
    const projects = options?.projectId ? allProjects.filter((row) => row.project_id === options.projectId) : allProjects;
    const out: Array<{ projectId: string; offered: string | null; scanned: boolean; lastScanAt: number | null; board: { issuable: number; needsEstimate: number; decompose: number; blocked: number } | null }> = [];
    for (const { project_id: projectId } of projects) {
      if (ctx.isDisposed()) break;
      // The interval is the person's setting unless a project calendar schedule triggered this scan directly (`force`).
      const scannedAt = await readLastScanAt(bb.storage.kv, projectId);
      assertActive();
      if (!options?.force && scannedAt !== null && now - scannedAt < scanMinutesOf(db, projectId) * 60_000) {
        out.push({ projectId, offered: null, scanned: false, lastScanAt: scannedAt, board: null });
        continue;
      }
      const pm = await pmOf(projectId, now);
      const current = await board(projectId);
      assertActive();
      const counts = { issuable: current.issuable.length, needsEstimate: current.needsEstimate.length, decompose: current.decompose.length, blocked: current.blocked.length };
      const projectToday = countProjectIssuedSince(db, projectId, now - DAY);
      // Any legacy open offer whose item was closed or re-estimated elsewhere is closed automatically.
      const issuable = new Set(current.issuable.map((row) => row.id));
      for (const key of listOpenOwnerItemKeys(db, { source: "backlog", projectId })) {
        if (!issuable.has(key.slice(offerKey(projectId, "").length))) closeOwnerItem(db, key, "janitor:not issuable", now);
      }
      const next = current.issuable[0];
      assertActive();
      const done = async (offered: string | null) => {
        assertActive();
        await writeLastScanAt(bb.storage.kv, projectId, now);
        out.push({ projectId, offered, scanned: true, lastScanAt: now, board: counts });
      };
      if (!pm || !next || projectToday >= PER_PROJECT_PER_DAY || issuedToday() >= PER_DAY) { await done(null); continue; }
      const issued = await issue(projectId, next.id, now);
      await done(issued.ok ? next.id : null);
    }
    return out;
  }

  /** The owner's «выдать» (the list's button, the RPC `backlog_issue`): the order goes to the project's PM and the item is recorded as issued. */
  async function issue(projectId: string, todoId: string, now = Date.now()): Promise<{ ok: true; pmThreadId: string } | { ok: false; reason: string }> {
    const pm = await pmOf(projectId, now);
    if (!pm) return { ok: false, reason: "в проекте нет чата Lane Pilot, который работал за последние две недели" };
    const item = (await board(projectId)).issuable.find((row) => row.id === todoId);
    assertActive();
    if (!item) return { ok: false, reason: `в бэклоге проекта нет пункта ${todoId}, готового к работе (уже выдан, закрыт или ждёт оценки)` };
    const issueConfig = await workspaceOf(projectId);
    assertActive();
    const planningHome = issueConfig?.hostId && issueConfig.writerWorkspacePath ? await homeOf(projectId, issueConfig).catch(() => null) : null;
    assertActive();
    await sendServiceMessage(bb as never, { threadId: pm, mode: "queue-if-active", text: issueMessage(item, planningHome) });
    assertActive();
    recordBacklogIssue(db, { projectId, todoId, pmThreadId: pm, estimate: item.estimate, issuedAt: now });
    closeOwnerItem(db, offerKey(projectId, todoId), "owner", now);
    ctx.log(`backlog: ${projectId} issued ${todoId} to ${pm} on the owner's word`);
    return { ok: true, pmThreadId: pm };
  }

  return { backlog: { board, scan, issue, items } };
}
export type BacklogApi = ReturnType<typeof createBacklog>["backlog"];
