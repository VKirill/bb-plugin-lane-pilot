import { loadPrototypeConfig } from "../../storage";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { backlogBoard, backlogReadCommand, issueMessage, parseBacklogOutput, type BacklogBoard } from "../logic";

/**
 * The backlog scanner (SMA D2-9). Every hour, for each project whose owner's PM chat (a run of kind `cli`) was active in the last two weeks,
 * it reads `.agents/todos/items/*\/meta.yaml` on the project's host and issues the first issuable item to that PM: one per project a day and
 * three a day in all, each item once. Nothing else is touched: the PM writes the contract, and the item's status stays the PM's.
 */
const DAY = 86_400_000;
export const PER_PROJECT_PER_DAY = 1;
export const PER_DAY = 3;

export function createBacklog(ctx: ServerCore) {
  const { db, bb, host } = ctx;

  /** The project's newest owner PM chat active in the last two weeks, or null. */
  async function pmOf(projectId: string, now: number): Promise<string | null> {
    const rows = db.prepare("SELECT pm_thread_id FROM lane_pilot_run WHERE project_id=? AND kind='cli' AND pm_thread_id IS NOT NULL AND updated_at>=? ORDER BY updated_at DESC LIMIT 20")
      .all(projectId, now - 14 * DAY) as Array<{ pm_thread_id: string }>;
    // A workflow architect's chat has a run and the role pm too, marked by architectProjectId; the backlog's task goes to the owner's PM chat only.
    for (const row of rows) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: row.pm_thread_id }).catch(() => null) as Record<string, unknown> | null;
      if (metadata?.role === "pm" && !metadata.architectProjectId) return row.pm_thread_id;
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
    const out: Array<{ projectId: string; issued: string | null; board: { issuable: number; needsEstimate: number; decompose: number; blocked: number } }> = [];
    for (const { project_id: projectId } of projects) {
      if (ctx.isDisposed()) break;
      const pm = await pmOf(projectId, now);
      const current = await board(projectId);
      const counts = { issuable: current.issuable.length, needsEstimate: current.needsEstimate.length, decompose: current.decompose.length, blocked: current.blocked.length };
      const projectToday = (db.prepare("SELECT count(*) AS n FROM lane_pilot_backlog_issue WHERE project_id=? AND issued_at>=?").get(projectId, now - DAY) as { n: number }).n;
      const next = current.issuable[0];
      if (!pm || !next || projectToday >= PER_PROJECT_PER_DAY || issuedToday() >= PER_DAY) { out.push({ projectId, issued: null, board: counts }); continue; }
      await bb.sdk.threads.send({ threadId: pm, mode: "queue-if-active", input: [{ type: "text", text: issueMessage(next), mentions: [] }] } as never);
      db.prepare("INSERT OR IGNORE INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run(projectId, next.id, pm, next.estimate, now);
      ctx.log(`backlog: ${projectId} issued ${next.id} to ${pm}`);
      out.push({ projectId, issued: next.id, board: counts });
    }
    return out;
  }

  return { backlog: { board, scan } };
}
export type BacklogApi = ReturnType<typeof createBacklog>["backlog"];

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
