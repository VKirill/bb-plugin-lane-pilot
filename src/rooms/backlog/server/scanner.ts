import { listCliPmProjects, listCliPmThreads, loadProjectSettings, loadPrototypeConfig } from "../../storage";
import { SETTING_BACKLOG_SCAN_MINUTES } from "@lane-pilot/settings-catalog";
import { scheduleIsolated } from "../../platform/server";
import { type ServerCore } from "../../contracts/server";
import { isPmChat } from "../../native-agent/server";
import { closeOwnerItem, listOpenOwnerItemKeys, postOwnerItem, rpcLine } from "../../owner-waiting";
import { backlogIssuedTo } from "../store";
import { bindBacklogIssued } from "../../tasks/server";
import { backlogBoard, backlogReadCommand, issueMessage, parseBacklogOutput, type BacklogBoard, type TodoMeta } from "../logic";
import { planningRoot } from "../../contracts";

/**
 * The backlog scanner (SMA D2-9). Every hour, for each project whose owner's PM chat (a run of kind `cli`) was active in the last two weeks,
 * it reads `.agents/todos/items/*\/meta.yaml` on the project's host and issues the first issuable item to that PM: one per project a day and
 * three a day in all, each item once. Nothing else is touched: the PM writes the contract, and the item's status stays the PM's.
 */
const DAY = 86_400_000;
export const PER_PROJECT_PER_DAY = 1;
export const PER_DAY = 3;

const offerKey = (projectId: string, todoId: string) => `backlog:${projectId}:${todoId}`;
/** The last time a project's todos were scanned (SMA m_in_cadence): the tick wakes every five minutes, the interval is the owner's setting. */
const lastScanKey = (projectId: string) => `backlog:last-scan:${projectId}`;

/** The project's scan interval in minutes — the person's setting (backlog.scan_minutes), 60 by default. */
function scanMinutesOf(db: Parameters<typeof loadProjectSettings>[0], projectId: string): number {
  const raw = loadProjectSettings(db, projectId)[SETTING_BACKLOG_SCAN_MINUTES];
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 60;
}

export function createBacklog(ctx: ServerCore) {
  const { db, bb, host } = ctx;
  // The queue tool asks who an item was issued to before it closes the item (SMA m_in_close_line): this room answers.
  bindBacklogIssued(db, (projectId, todoId) => backlogIssuedTo(db, projectId, todoId));

  /** The project's newest owner PM chat active in the last two weeks, or null. */
  async function pmOf(projectId: string, now: number): Promise<string | null> {
    const rows = listCliPmThreads(db, projectId, now - 14 * DAY);
    // A workflow architect's chat has a run and the role pm too, marked by architectProjectId; the backlog's task goes to the owner's PM chat only.
    for (const row of rows) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: row.pm_thread_id }).catch(() => null) as Record<string, unknown> | null;
      if (metadata?.role === "pm" && !metadata.architectProjectId && await isPmChat(ctx, row.pm_thread_id)) return row.pm_thread_id;
    }
    return null;
  }

  /** The root `.agents/todos` is read under (SMA d_project_planning): the planning home when set, else the checkout. */
  function todosRoot(projectId: string, writerWorkspacePath: string): string {
    return planningRoot({ writer_workspace_path: writerWorkspacePath }, loadProjectSettings(db, projectId)) ?? writerWorkspacePath;
  }

  /** The project's meta.yaml items as they are on its host right now (no fetch; the board fetches first). */
  async function items(projectId: string): Promise<TodoMeta[]> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config?.writerWorkspacePath) return [];
    const ran = await host.call("gateRun", { requestedHostId: config.hostId, basePath: todosRoot(projectId, config.writerWorkspacePath), command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    return parseBacklogOutput(ran.stdout);
  }

  async function lastScanAt(projectId: string): Promise<number | null> {
    const stored = await bb.storage.kv.get(lastScanKey(projectId)).catch(() => null) as number | null;
    return typeof stored === "number" && Number.isFinite(stored) ? stored : null;
  }

  async function board(projectId: string): Promise<BacklogBoard & { error?: string; readAt?: string; fetched?: boolean; behind?: number | null; lastScanAt?: number | null }> {
    const config = loadPrototypeConfig(db, projectId);
    const readAt = new Date().toISOString();
    const scannedAt = await lastScanAt(projectId);
    if (!config?.writerWorkspacePath) return { issuable: [], needsEstimate: [], decompose: [], blocked: [], readAt, fetched: false, behind: null, lastScanAt: scannedAt, error: "the project has no workspace configured" };
    // Fresh data first (SMA m_in_scan): fetch, then read; whoever sees the result gets its age and how far the branch is behind.
    const freshened = await host.call("gateRun", { requestedHostId: config.hostId, basePath: config.writerWorkspacePath, command: "git fetch --quiet && git rev-list --count HEAD..@{u}", timeoutSec: 20 }, { hostId: config.hostId, timeoutMs: 30_000 })
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const fetched = freshened.exitCode === 0;
    const behindCount = Number((freshened.stdout ?? "").trim());
    const behind = fetched && Number.isFinite(behindCount) ? behindCount : null;
    const ran = await host.call("gateRun", { requestedHostId: config.hostId, basePath: todosRoot(projectId, config.writerWorkspacePath), command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));
    const issued = new Set((db.prepare("SELECT todo_id FROM lane_pilot_backlog_issue WHERE project_id=?").all(projectId) as Array<{ todo_id: string }>).map((row) => row.todo_id));
    const result = backlogBoard(parseBacklogOutput(ran.stdout));
    return { ...result, issuable: result.issuable.filter((item) => !issued.has(item.id)), readAt, fetched, behind, lastScanAt: scannedAt };
  }

  async function scan(now = Date.now()) {
    const issuedToday = () => (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE issued_at>=?").get(now - DAY) as { n: number }).n;
    const projects = listCliPmProjects(db, now - 14 * DAY);
    const out: Array<{ projectId: string; offered: string | null; scanned: boolean; lastScanAt: number | null; board: { issuable: number; needsEstimate: number; decompose: number; blocked: number } | null }> = [];
    for (const { project_id: projectId } of projects) {
      if (ctx.isDisposed()) break;
      // The interval is the person's setting: a project whose last scan is younger than it is left alone this tick.
      const scannedAt = await lastScanAt(projectId);
      if (scannedAt !== null && now - scannedAt < scanMinutesOf(db, projectId) * 60_000) {
        out.push({ projectId, offered: null, scanned: false, lastScanAt: scannedAt, board: null });
        continue;
      }
      const pm = await pmOf(projectId, now);
      const current = await board(projectId);
      const counts = { issuable: current.issuable.length, needsEstimate: current.needsEstimate.length, decompose: current.decompose.length, blocked: current.blocked.length };
      const projectToday = (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE project_id=? AND issued_at>=?").get(projectId, now - DAY) as { n: number }).n;
      // An offer whose item was issued, closed or re-estimated elsewhere asks a question that is gone: close it before offering anew.
      const issuable = new Set(current.issuable.map((row) => row.id));
      for (const key of listOpenOwnerItemKeys(db, { source: "backlog", projectId })) {
        if (!issuable.has(key.slice(offerKey(projectId, "").length))) closeOwnerItem(db, key, "janitor:not issuable", now);
      }
      const next = current.issuable[0];
      const done = async (offered: string | null) => {
        await bb.storage.kv.set(lastScanKey(projectId), now as never).catch(() => undefined);
        out.push({ projectId, offered, scanned: true, lastScanAt: now, board: counts });
      };
      if (!pm || !next || projectToday >= PER_PROJECT_PER_DAY || issuedToday() >= PER_DAY) { await done(null); continue; }
      // backlog.auto_issue on: the scan itself sends the ready item into the project's PM chat, the same caps
      // guarding it (SMA dt_intake). Off stays the default: the owner's «выдать» issues (0.1.458).
      const autoIssue = loadProjectSettings(db, projectId)["backlog.auto_issue"];
      if (autoIssue === "on" || autoIssue === true) {
        const issued = await issue(projectId, next.id, now);
        await done(issued.ok ? next.id : null);
        continue;
      }
      // The offer says how fresh the backlog is, in the owner's words: read just now, behind the server, or not compared.
      const ageLine = !current.fetched ? " Свежесть бэклога не проверена: сервер с кодом не ответил."
        : current.behind ? ` Папка проекта отстаёт от сервера с кодом, новых правок там: ${current.behind}.`
        : "";
      // Since 0.1.458 the scanner offers, the owner issues: a work order into a PM chat is his word, not the plugin's own event (0.1.443;
      // the hourly send into a two-week-old chat was one of the leaks the Gemini grill of 0.1.456 found). One open offer per project: the first
      // ready item; the same key again changes nothing.
      const offered = postOwnerItem(db, { key: offerKey(projectId, next.id), source: "backlog", kind: "backlog_ready", projectId, wake: false,
        what: `В бэклоге проекта готова к работе задача «${next.title}»`,
        why: `Оценка ${next.estimate}, приоритет ${next.priority}. По вашему «выдать» она уйдёт в чат проекта как задание; сама система в чат проекта не пишет.${ageLine}`,
        evidence: [{ kind: "file", ref: `.agents/todos/items/${next.id}/AGENT.md`, label: "описание" }],
        actions: [{ id: "issue", label: "Выдать в работу", cli: rpcLine("backlog_issue", { projectId, todoId: next.id }), rpc: { method: "backlog_issue", input: { projectId, todoId: next.id } } }] }, now).created;
      if (offered) ctx.log(`backlog: ${projectId} offered ${next.id} on the owner's list`);
      await done(offered ? next.id : null);
    }
    return out;
  }

  /** The owner's «выдать» (the list's button, the RPC `backlog_issue`): the order goes to the project's PM and the item is recorded as issued. */
  async function issue(projectId: string, todoId: string, now = Date.now()): Promise<{ ok: true; pmThreadId: string } | { ok: false; reason: string }> {
    const pm = await pmOf(projectId, now);
    if (!pm) return { ok: false, reason: "в проекте нет чата Lane Pilot, который работал за последние две недели" };
    const item = (await board(projectId)).issuable.find((row) => row.id === todoId);
    if (!item) return { ok: false, reason: `в бэклоге проекта нет пункта ${todoId}, готового к работе (уже выдан, закрыт или ждёт оценки)` };
    await bb.sdk.threads.send({ threadId: pm, mode: "queue-if-active", input: [{ type: "text", text: issueMessage(item), mentions: [] }] } as never);
    db.prepare("INSERT OR IGNORE INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run(projectId, todoId, pm, item.estimate, now);
    closeOwnerItem(db, offerKey(projectId, todoId), "owner", now);
    ctx.log(`backlog: ${projectId} issued ${todoId} to ${pm} on the owner's word`);
    return { ok: true, pmThreadId: pm };
  }

  return { backlog: { board, scan, issue, items } };
}
export type BacklogApi = ReturnType<typeof createBacklog>["backlog"];

export function backlogRpc(api: BacklogApi) {
  return {
    backlog_issue: async ({ projectId, todoId }: { projectId: string; todoId: string }) => api.issue(projectId, todoId),
    backlog_board: async ({ projectId }: { projectId: string }) => api.board(projectId),
  };
}

export function mountBacklog(ctx: ServerCore, api: BacklogApi): void {
  // The tick wakes every five minutes off the quarter-hours; each project's own interval (backlog.scan_minutes) decides whether it scans.
  scheduleIsolated(ctx.bb, "backlog-scan", "3,8,13,18,23,28,33,38,43,48,53,58 * * * *", async () => {
    if (ctx.isDisposed()) return;
    await api.scan().catch((cause: unknown) => ctx.log(`backlog scan failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 20 * 60_000 });
}

export const BACKLOG_USAGE = "bb lane-pilot backlog <project-id> | --scan   (ready todos: issuable in queue order, to estimate, to split, blocked; --scan issues now within the caps)";
export async function runBacklogCli(api: BacklogApi, argv: readonly string[]): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  try {
    if (argv.length === 1 && argv[0] === "--scan") return { exitCode: 0, stdout: JSON.stringify(await api.scan(), null, 2) };
    if (argv.length === 1 && !argv[0]!.startsWith("--")) return { exitCode: 0, stdout: JSON.stringify(await api.board(argv[0]!), null, 2) };
    return { exitCode: 1, stderr: BACKLOG_USAGE };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
