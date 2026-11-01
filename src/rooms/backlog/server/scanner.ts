import { loadPrototypeConfig } from "../../storage";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { isPmChat } from "../../native-agent/server";
import { closeOwnerItem, postOwnerItem, rpcLine } from "../../owner-waiting";
import { backlogBoard, backlogReadCommand, issueMessage, parseBacklogOutput, type BacklogBoard } from "../logic";

/**
 * The backlog scanner (SMA D2-9). Every hour, for each project whose owner's PM chat (a run of kind `cli`) was active in the last two weeks,
 * it reads `.agents/todos/items/*\/meta.yaml` on the project's host and issues the first issuable item to that PM: one per project a day and
 * three a day in all, each item once. Nothing else is touched: the PM writes the contract, and the item's status stays the PM's.
 */
const DAY = 86_400_000;
export const PER_PROJECT_PER_DAY = 1;
export const PER_DAY = 3;

const offerKey = (projectId: string, todoId: string) => `backlog:${projectId}:${todoId}`;

export function createBacklog(ctx: ServerCore) {
  const { db, bb, host } = ctx;

  /** The project's newest owner PM chat active in the last two weeks, or null. */
  async function pmOf(projectId: string, now: number): Promise<string | null> {
    const rows = db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE project_id=? AND kind='cli' AND pm_thread_id IS NOT NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 20")
      .all(projectId, now - 14 * DAY) as Array<{ pm_thread_id: string }>;
    // A workflow architect's chat has a run and the role pm too, marked by architectProjectId; the backlog's task goes to the owner's PM chat only.
    for (const row of rows) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: row.pm_thread_id }).catch(() => null) as Record<string, unknown> | null;
      if (metadata?.role === "pm" && !metadata.architectProjectId && await isPmChat(ctx, row.pm_thread_id)) return row.pm_thread_id;
    }
    return null;
  }

  async function board(projectId: string): Promise<BacklogBoard & { error?: string }> {
    const config = loadPrototypeConfig(db, projectId);
    if (!config?.writerWorkspacePath) return { issuable: [], needsEstimate: [], decompose: [], blocked: [], error: "the project has no workspace configured" };
    const ran = await host.call("gateRun", { requestedHostId: config.hostId, basePath: config.writerWorkspacePath, command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })
      .catch((cause: unknown) => ({ exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }));
    const issued = new Set((db.prepare("SELECT todo_id FROM lane_pilot_backlog_issue WHERE project_id=?").all(projectId) as Array<{ todo_id: string }>).map((row) => row.todo_id));
    const result = backlogBoard(parseBacklogOutput(ran.stdout));
    return { ...result, issuable: result.issuable.filter((item) => !issued.has(item.id)) };
  }

  async function scan(now = Date.now()) {
    const issuedToday = () => (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE issued_at>=?").get(now - DAY) as { n: number }).n;
    const projects = db.prepare("SELECT DISTINCT project_id FROM lane_pilot_run WHERE kind='cli' AND pm_thread_id IS NOT NULL AND updated_at>=?").all(now - 14 * DAY) as Array<{ project_id: string }>;
    const out: Array<{ projectId: string; offered: string | null; board: { issuable: number; needsEstimate: number; decompose: number; blocked: number } }> = [];
    for (const { project_id: projectId } of projects) {
      if (ctx.isDisposed()) break;
      const pm = await pmOf(projectId, now);
      const current = await board(projectId);
      const counts = { issuable: current.issuable.length, needsEstimate: current.needsEstimate.length, decompose: current.decompose.length, blocked: current.blocked.length };
      const projectToday = (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE project_id=? AND issued_at>=?").get(projectId, now - DAY) as { n: number }).n;
      const next = current.issuable[0];
      if (!pm || !next || projectToday >= PER_PROJECT_PER_DAY || issuedToday() >= PER_DAY) { out.push({ projectId, offered: null, board: counts }); continue; }
      // Since 0.1.458 the scanner offers, the owner issues: a work order into a PM chat is his word, not the plugin's own event (0.1.443;
      // the hourly send into a two-week-old chat was one of the leaks the Gemini grill of 0.1.456 found). One open offer per project: the first
      // ready item; the same key again changes nothing.
      const offered = postOwnerItem(db, { key: offerKey(projectId, next.id), source: "backlog", kind: "backlog_ready", projectId, wake: false,
        what: `В бэклоге проекта готова к работе задача «${next.title}»`,
        why: `Оценка ${next.estimate}, приоритет ${next.priority}. По вашему «выдать» она уйдёт в чат проекта как задание; сама система в чат проекта не пишет.`,
        evidence: [{ kind: "file", ref: `.agents/todos/items/${next.id}/AGENT.md`, label: "описание" }],
        actions: [{ id: "issue", label: "Выдать в работу", cli: rpcLine("backlog_issue", { projectId, todoId: next.id }), rpc: { method: "backlog_issue", input: { projectId, todoId: next.id } } }] }, now).created;
      if (offered) ctx.log(`backlog: ${projectId} offered ${next.id} on the owner's list`);
      out.push({ projectId, offered: offered ? next.id : null, board: counts });
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

  return { backlog: { board, scan, issue } };
}
export type BacklogApi = ReturnType<typeof createBacklog>["backlog"];

export function backlogRpc(api: BacklogApi) {
  return { backlog_issue: async ({ projectId, todoId }: { projectId: string; todoId: string }) => api.issue(projectId, todoId) };
}

export function mountBacklog(ctx: ServerCore, api: BacklogApi): void {
  scheduleIsolated(ctx.bb, "backlog-scan", "41 * * * *", async () => {
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
