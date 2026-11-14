import { isAbsolute, relative, resolve } from "node:path";
import { isNotFound, orMiss, sha256Hex } from "@lane-pilot/kit";
import {
  getTaskPlan, hasTaskHome, noteTaskFileRead, openTaskHome, placeTaskHome, readTaskFile, recordTaskFile, resolveTaskFile, taskHomeOf, TASK_HOME_EXCLUDE,
  type ResolvedTaskFile, type TaskFileIo, type TaskFileKind, type TaskFileProducer,
} from "../../storage";
import type { ServerCore } from "../../contracts/server";
import type { TaskV2 } from "../../contracts";

/**
 * The task home on the task's host (docs/task-folder.md): the bb file calls behind `TaskFileIo`, the dispatch-time home (contract, PLAN.md and a
 * snapshot of the PM's shared plan files), and the small helpers the main-path nodes use to hand each other `{task_id, kind}`.
 */

type Files = { sdk: { files: {
  read(args: { hostId: string; rootPath: string; path: string }): Promise<unknown> | unknown;
  write(args: { hostId: string; rootPath: string; path: string; content: string; contentEncoding: "utf8"; createParents: boolean; expectedSha256: null }): Promise<unknown> | unknown;
} } };

/** Absolute-path reads and writes on one host, rooted at `rootPath` (the bb file API needs a root). A missing file reads as null. */
export function bbTaskFileIo(bb: Files, hostId: string, rootPath: string): TaskFileIo {
  return {
    read: async (absPath) => {
      const file = await orMiss(Promise.resolve().then(() => bb.sdk.files.read({ hostId, rootPath, path: absPath })), null, isNotFound);
      const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
      return typeof content === "string" ? content : null;
    },
    write: async (absPath, content) => {
      await bb.sdk.files.write({ hostId, rootPath, path: absPath, content, contentEncoding: "utf8", createParents: true, expectedSha256: null });
    },
  };
}

/** The io of a task's home in its base checkout, or null for a task on the old layout. */
export function taskHomeIo(ctx: Pick<ServerCore, "bb" | "db">, taskId: string): TaskFileIo | null {
  const home = taskHomeOf(ctx.db, taskId);
  return home ? bbTaskFileIo(ctx.bb as unknown as Files, home.host_id, home.base_path) : null;
}

const SHARED_PLAN = /(?<![\w/.~-])(\.agents\/plans\/[^\s`'"()<>\]\[,;]+)/g;

/**
 * The shared plan files a PM plan points at: the whole plan when it is one path line, and every `.agents/plans/<x>` it mentions (also
 * the old-layout `.agents/plans/items/` logs a Lane Pilot repair plan names). Repository-relative, inside `basePath`, in order of first mention.
 */
export function planSourcePaths(plan: string, basePath: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const cleaned = raw.trim().replace(/[.:]+$/, "");
    if (!cleaned) return;
    const root = resolve(basePath);
    const full = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
    const inside = relative(root, full).split("\\").join("/");
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || inside.startsWith(".agents/tasks/")) return;
    if (!found.includes(inside)) found.push(inside);
  };
  const one = plan.trim();
  if (one && !/[\r\n]/.test(one) && one.length <= 1000 && /\.(md|markdown|txt|json|ya?ml)$/i.test(one) && !/\s/.test(one)) add(one);
  for (const match of plan.matchAll(SHARED_PLAN)) add(match[1]!);
  return found;
}

/** `context/plan-source.md`: each shared file the plan named, with its source path and sha256, so the task never reads the shared folder again. */
export function planSourceMarkdown(sources: Array<{ path: string; text: string | null }>): string {
  const head = ["---", "schema: lp.plan-source/1", "sources:", ...sources.flatMap((source) => [
    `  - source_path: ${source.path}`,
    source.text === null ? "    missing: true" : `    sha256: ${sha256Hex(source.text)}`,
  ]), "---", ""];
  const body = sources.map((source) => `## ${source.path}\n\n${source.text === null ? "(the file could not be read at dispatch)" : source.text.trimEnd()}\n`);
  return `${head.join("\n")}\n${body.join("\n")}`;
}

const DISPATCH: TaskFileProducer = { node: "dispatch", graph: "lp-task-pipeline", stage_id: "dispatch" };

/**
 * The home a dispatched task starts with: `contract.v1.json`, `PLAN.md` (the plan TEXT: a plan that is only a path line is replaced by the
 * file's text) and, when the plan points at shared `.agents/plans/*` files, `context/plan-source.md` with their snapshot. Throws on a failed
 * write: a task whose home could not be written is not dispatched.
 */
export async function writeDispatchHome(db: ServerCore["db"], io: TaskFileIo, input: {
  taskId: string; projectId: string; runId: string; basePath: string; hostId: string; task: TaskV2; plan: string; phaseId?: string | null;
}): Promise<{ planText: string; files: ResolvedTaskFile[] }> {
  openTaskHome(db, { taskId: input.taskId, projectId: input.projectId, runId: input.runId, basePath: input.basePath, hostId: input.hostId, phaseId: input.phaseId ?? null });
  const base = input.basePath.replace(/\/+$/, "");
  const sources = await Promise.all(planSourcePaths(input.plan, base).map(async (path) => ({ path, text: await io.read(`${base}/${path}`) })));
  // A plan that is only a path line: the writer, the critic and the reader get the file's text, not the line.
  const one = input.plan.trim();
  const onlyPath = sources.length > 0 && !/\s/.test(one) && planSourcePaths(one, base)[0] === sources[0]!.path;
  const planText = onlyPath && sources[0]!.text !== null ? sources[0]!.text! : input.plan;
  const files: ResolvedTaskFile[] = [];
  files.push(await recordTaskFile(db, io, { taskId: input.taskId, kind: "contract", name: "contract.v1.json", content: `${JSON.stringify(input.task, null, 2)}\n`, producer: DISPATCH, readers: ["pm-read", "plan-critique", "writer"] }));
  files.push(await recordTaskFile(db, io, { taskId: input.taskId, kind: "plan", name: "PLAN.md", content: planText.endsWith("\n") ? planText : `${planText}\n`, producer: DISPATCH, readers: ["pm-read", "plan-critique", "writer"] }));
  if (sources.length) files.push(await recordTaskFile(db, io, { taskId: input.taskId, kind: "plan-source", name: "context/plan-source.md", content: planSourceMarkdown(sources), producer: DISPATCH, readers: ["plan-critique", "writer"] }));
  return { planText, files };
}

/**
 * The plan a stage reads: PLAN.md through the manifest for a task with a home (a home without one stops the stage), the dispatch's in-memory plan
 * for a task on the old layout.
 */
export async function stagePlanText(ctx: Pick<ServerCore, "bb" | "db">, taskId: string, reader: string, legacyPlan: string): Promise<string> {
  const io = taskHomeIo(ctx, taskId);
  if (!io) return legacyPlan;
  const found = resolveTaskFile(ctx.db, taskId, "plan");
  if (!found) throw new Error(`task ${taskId}: its manifest lists no PLAN.md (kind plan); the stage stops instead of guessing a plan`);
  const read = await readTaskFile(ctx.db, io, { taskId, kind: "plan", reader });
  if (read) return read.text;
  // The file cannot be read on its host, but the database keeps the plan the dispatch wrote: taken only when its hash is the manifest row's.
  const saved = getTaskPlan(ctx.db, taskId);
  const text = saved === null ? null : saved.endsWith("\n") ? saved : `${saved}\n`;
  if (text !== null && sha256Hex(text) === found.sha256) {
    noteTaskFileRead(ctx.db, { taskId, path: found.path, kind: "plan", reader: `${reader}:db-copy`, sha256: found.sha256, legacy: false });
    return saved!;
  }
  throw new Error(`task ${taskId}: its home's PLAN.md cannot be read and no stored copy matches its manifest hash; the stage stops instead of guessing a plan`);
}

/** Records one file of a task with a home (best effort for callers that must not fail on it); null for a task on the old layout. */
export async function recordTaskHomeFile(ctx: Pick<ServerCore, "bb" | "db">, input: {
  taskId: string; kind: TaskFileKind; name: string; content: string; producer: TaskFileProducer; attemptId?: string | null; round?: number | null; readers?: readonly string[];
  mirrorRoot?: string | null;
}): Promise<ResolvedTaskFile | null> {
  const home = taskHomeOf(ctx.db, input.taskId);
  if (!home) return null;
  const io = bbTaskFileIo(ctx.bb as unknown as Files, home.host_id, home.base_path);
  const mirror = input.mirrorRoot && input.mirrorRoot !== home.base_path ? { io: bbTaskFileIo(ctx.bb as unknown as Files, home.host_id, input.mirrorRoot), root: input.mirrorRoot } : null;
  return recordTaskFile(ctx.db, io, { ...input, mirror });
}

/** Puts the task's own home into its worktree (nothing of another task); the paths placed. */
export async function placeTaskHomeIn(ctx: Pick<ServerCore, "bb" | "db">, input: { taskId: string; hostId: string; worktreePath: string; basePath: string }): Promise<string[]> {
  const home = taskHomeOf(ctx.db, input.taskId);
  const from = bbTaskFileIo(ctx.bb as unknown as Files, home?.host_id ?? input.hostId, home?.base_path ?? input.basePath);
  const to = bbTaskFileIo(ctx.bb as unknown as Files, input.hostId, input.worktreePath);
  return placeTaskHome(ctx.db, from, to, { taskId: input.taskId, worktreePath: input.worktreePath });
}

/** The brief's view of the task home: its folder and the files its manifest lists (no folder listing). Null for a task on the old layout. */
export function taskHomeBrief(db: ServerCore["db"], taskId: string, attemptId?: string): { path: string; files: string[]; plan: string | null; checkLog: string | null; attemptFolder: string | null } | null {
  if (!hasTaskHome(db, taskId)) return null;
  const rows = db.prepare("SELECT path FROM lane_pilot_task_file WHERE task_id=? AND superseded_by IS NULL ORDER BY created_at, rowid").all(taskId) as Array<{ path: string }>;
  const plan = resolveTaskFile(db, taskId, "plan");
  const checkLog = resolveTaskFile(db, taskId, "check-log");
  return {
    path: `.agents/tasks/${taskId}/`,
    files: rows.map((row) => row.path),
    plan: plan?.repoPath ?? null,
    checkLog: checkLog?.repoPath ?? null,
    attemptFolder: attemptId ? `.agents/tasks/${taskId}/attempts/${attemptId}/` : null,
  };
}

/** Where the writer leaves a note of its attempt (QUESTIONS.md, CHECKPOINT.md), repository-relative in its workspace: the attempt folder of its home, or the old task folder. */
export function writerNotePath(db: ServerCore["db"], taskId: string, attemptId: string, name: "QUESTIONS.md" | "CHECKPOINT.md"): string {
  return hasTaskHome(db, taskId) ? `.agents/tasks/${taskId}/attempts/${attemptId}/${name}` : `.agents/plans/items/${taskId}/${name}`;
}

type AttemptRef = { taskId: string; attemptId: string; runId: string };

/** The writer's real report as the attempt's `report.md` (kind writer-report). A failed record is logged; the finish goes on. */
export async function recordWriterReport(ctx: Pick<ServerCore, "bb" | "db" | "log">, input: AttemptRef, output: string): Promise<ResolvedTaskFile | null> {
  if (!hasTaskHome(ctx.db, input.taskId)) return null;
  return recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "writer-report", name: `attempts/${input.attemptId}/report.md`, content: output.endsWith("\n") ? output : `${output}\n`,
    attemptId: input.attemptId, producer: { node: "writer", graph: "lp-task-pipeline", stage_id: "writer-agent", run_id: input.runId, attempt_id: input.attemptId },
    readers: ["plan-fact", "code-critique", "acceptance", "lessons"] })
    .catch((cause: unknown) => { ctx.log(`writer ${input.taskId}: report.md not recorded: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
}

/** The writer's QUESTIONS.md / CHECKPOINT.md read from its worktree, kept in the attempt folder of the task home (the worktree goes at the merge). */
export async function keepWriterNotes(ctx: Pick<ServerCore, "bb" | "db" | "log">, input: AttemptRef, notes: Partial<Record<"QUESTIONS.md" | "CHECKPOINT.md", string | null>>): Promise<void> {
  if (!hasTaskHome(ctx.db, input.taskId)) return;
  for (const [name, text] of Object.entries(notes)) {
    if (!text) continue;
    await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: name === "QUESTIONS.md" ? "questions" : "checkpoint", name: `attempts/${input.attemptId}/${name}`, content: text,
      attemptId: input.attemptId, producer: { node: "writer", graph: "lp-task-pipeline", stage_id: "writer-agent", run_id: input.runId, attempt_id: input.attemptId }, readers: ["pm"] })
      .catch((cause: unknown) => ctx.log(`writer ${input.taskId}: ${name} not kept: ${cause instanceof Error ? cause.message : String(cause)}`));
  }
}

/**
 * Appends a question and its answer to the attempt's QA.md in the task home (and the same file in the running worktree). False for a task on
 * the old layout: the caller then writes its old QA.md. A failed write never fails the caller.
 */
export async function appendTaskQaHome(ctx: Pick<ServerCore, "bb" | "db">, input: { taskId: string; attemptId?: string | null; question: string; answer?: string; mirrorRoot?: string | null }): Promise<boolean> {
  const home = taskHomeOf(ctx.db, input.taskId);
  if (!home) return false;
  const attemptId = input.attemptId ?? (ctx.db.prepare("SELECT id FROM lane_pilot_attempt WHERE task_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.taskId) as { id: string } | undefined)?.id ?? null;
  const name = attemptId ? `attempts/${attemptId}/QA.md` : "QA.md";
  try {
    const io = bbTaskFileIo(ctx.bb as unknown as Files, home.host_id, home.base_path);
    const prior = await io.read(`${home.base_path}/.agents/tasks/${input.taskId}/${name}`);
    const answerLine = input.answer === undefined ? "A: open — the writer is parked here" : `A (PM): ${input.answer.trim().slice(0, 4000)}`;
    const entry = `## ${new Date().toISOString()}\nQ (writer): ${input.question}\n${answerLine}\n`;
    const content = prior ? `${prior.trimEnd()}\n\n${entry}\n` : `# Q&A — ${input.taskId}\n\n${entry}\n`;
    await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "qa", name, content, attemptId, mirrorRoot: input.mirrorRoot ?? null,
      producer: { node: "qa", graph: "lp-task-pipeline", stage_id: "writer-agent", ...(attemptId ? { attempt_id: attemptId } : {}) }, readers: ["writer", "pm"] });
  } catch { /* a failed QA note never fails its caller */ }
  return true;
}

/**
 * A changed task (lane_pilot_update_task): the new contract edition as `contract.v<N>.json` and the new `PLAN.md`, recorded in the home and
 * written again into the open worktree of its attempt, so the running writer reads the same words the PM sent. False for a task on the old layout.
 */
export async function recordTaskEdition(ctx: Pick<ServerCore, "bb" | "db">, input: { taskId: string; task: TaskV2; plan: string; mirrorRoot?: string | null }): Promise<boolean> {
  if (!hasTaskHome(ctx.db, input.taskId)) return false;
  const edition = (ctx.db.prepare("SELECT COALESCE(MAX(edition),1) AS n FROM lane_pilot_task_contract_edition WHERE task_id=?").get(input.taskId) as { n: number }).n;
  const producer: TaskFileProducer = { node: "update-task", graph: "lp-task-pipeline", stage_id: "dispatch" };
  const mirrorRoot = input.mirrorRoot ?? null;
  await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "contract", name: `contract.v${edition}.json`, content: `${JSON.stringify(input.task, null, 2)}\n`, producer, readers: ["pm-read", "plan-critique", "writer"], mirrorRoot });
  await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "plan", name: "PLAN.md", content: input.plan.endsWith("\n") ? input.plan : `${input.plan}\n`, producer, readers: ["pm-read", "plan-critique", "writer"], mirrorRoot });
  return true;
}

/** The worktree of the task's open attempt (running, blocked or queued), or null. */
export function openAttemptWorktree(db: ServerCore["db"], taskId: string, basePath: string): string | null {
  const row = db.prepare("SELECT workspace_path FROM lane_pilot_attempt WHERE task_id=? AND state IN ('running','blocked','queued') AND workspace_path IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(taskId) as { workspace_path: string } | undefined;
  return row && row.workspace_path.replace(/\/+$/, "") !== basePath.replace(/\/+$/, "") ? row.workspace_path : null;
}

export { TASK_HOME_EXCLUDE };
