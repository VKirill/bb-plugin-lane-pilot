import { isAbsolute, relative, resolve } from "node:path";
import { isNotFound, orMiss, sha256Hex } from "@lane-pilot/kit";
import {
  getTaskPlan, hasTaskHome, listStageReceipts, noteTaskFileRead, openTaskHome, placeTaskHome, readTaskFile, recordTaskFile, resolveTaskFile, taskHomeOf, TASK_HOME_EXCLUDE,
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

const slugOf = (command: string) => command.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "check";

/**
 * The attempt's checks in its home: `attempts/<a>/checks.json` (every command, exit code, duration) and each failed check's full output as
 * `attempts/<a>/logs/NN-<cmd>.log` (kind check-log). Returns the repository path of the first failed log, which the next attempt's brief names.
 */
export async function recordCheckFiles(ctx: Pick<ServerCore, "bb" | "db">, input: {
  taskId: string; runId: string; attemptId: string; verifies: ReadonlyArray<{ command: string; exitCode: number; stdout?: string; stderr?: string; durationMs?: number }>;
  cleanOutput: (text: string) => string;
}): Promise<{ checks: string; checkLog: string | null } | null> {
  if (!hasTaskHome(ctx.db, input.taskId)) return null;
  const producer: TaskFileProducer = { node: "checks", graph: "lp-task-pipeline", stage_id: "verification", run_id: input.runId, attempt_id: input.attemptId };
  let checkLog: string | null = null;
  const logs: Array<string | null> = [];
  for (const [index, row] of input.verifies.entries()) {
    if (row.exitCode === 0) { logs.push(null); continue; }
    const name = `attempts/${input.attemptId}/logs/${String(index + 1).padStart(2, "0")}-${slugOf(row.command)}.log`;
    const file = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "check-log", name, attemptId: input.attemptId, producer, readers: ["writer"],
      content: `${`$ ${row.command}\nexit ${row.exitCode}\n\n${input.cleanOutput(row.stdout ?? "")}\n${input.cleanOutput(row.stderr ?? "")}`.trim()}\n` });
    logs.push(name);
    checkLog ??= file?.repoPath ?? null;
  }
  const checks = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "checks", name: `attempts/${input.attemptId}/checks.json`, attemptId: input.attemptId, producer,
    readers: ["code-critique", "acceptance"],
    content: `${JSON.stringify({ checks: input.verifies.map((row, index) => ({ command: row.command, exit_code: row.exitCode, ...(row.durationMs !== undefined ? { duration_ms: row.durationMs } : {}), ...(logs[index] ? { log: logs[index] } : {}) })) }, null, 2)}\n` });
  return checks ? { checks: checks.repoPath, checkLog } : null;
}

/**
 * The accepted attempt's receipts, written once into the home in the base checkout: `acceptance.json` and `receipt.json` (and the writer's
 * real output as its attempt's report.md when the finish did not record it). Null for a task on the old layout. A failed write throws.
 */
export async function recordAcceptanceFiles(ctx: Pick<ServerCore, "bb" | "db" | "log">, input: { taskId: string; runId: string; attemptId: string; output: string; acceptance: string; receipt: string }): Promise<{ acceptancePath: string; receiptPath: string } | null> {
  if (!hasTaskHome(ctx.db, input.taskId)) return null;
  if (input.output.trim() && !resolveTaskFile(ctx.db, input.taskId, "writer-report", { attemptId: input.attemptId })) await recordWriterReport(ctx, input, input.output);
  const producer: TaskFileProducer = { node: "acceptance", graph: "lp-task-pipeline", stage_id: "acceptance-receipt", run_id: input.runId, attempt_id: input.attemptId };
  const acceptance = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "acceptance", name: "acceptance.json", content: input.acceptance, attemptId: input.attemptId, producer, readers: ["pm", "after-accept", "lessons"] });
  const receipt = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "receipt", name: "receipt.json", content: input.receipt, attemptId: input.attemptId, producer, readers: ["pm", "after-accept"] });
  return acceptance && receipt ? { acceptancePath: acceptance.absPath, receiptPath: receipt.absPath } : null;
}

/**
 * One code-critique round of an attempt in its home: `attempts/<a>/barrier-input.json` (what the critic judged) and
 * `attempts/<a>/code-critique.r<K>.json` (its verdict and repair ledger), so the repair round K reads its findings by the manifest. False for
 * a task on the old layout; a failed write is logged and never fails the finish.
 */
export async function recordCritiqueRound(ctx: Pick<ServerCore, "bb" | "db" | "log">, input: { taskId: string; runId: string; attemptId: string; round: number; barrierInput: unknown; verdict: unknown }): Promise<boolean> {
  if (!hasTaskHome(ctx.db, input.taskId)) return false;
  const producer: TaskFileProducer = { node: "code-critique", graph: "lp-task-pipeline", stage_id: "code-critique", run_id: input.runId, attempt_id: input.attemptId };
  try {
    await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "barrier-input", name: `attempts/${input.attemptId}/barrier-input.json`, attemptId: input.attemptId, round: input.round,
      content: `${JSON.stringify(input.barrierInput, null, 2)}\n`, producer, readers: ["code-critique"] });
    await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "code-critique", name: `attempts/${input.attemptId}/code-critique.r${input.round}.json`, attemptId: input.attemptId, round: input.round,
      content: `${JSON.stringify(input.verdict, null, 2)}\n`, producer, readers: ["writer", "acceptance"] });
  } catch (cause) {
    ctx.log(`writer ${input.taskId}: the critique round was not recorded in its home: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return true;
}

/**
 * A plan-critique verdict in the task's home: `critique/plan.r<K>.json`, K counting this task's plan critiques. Records the PLAN.md hash
 * the critic read, so a repeat on the same plan is visible. Null for a task on the old layout; failures are logged.
 */
export async function recordPlanCritique(ctx: Pick<ServerCore, "bb" | "db">, input: { taskId: string; runId: string; allowed: boolean; reason?: string | undefined; wfStepKey?: string }): Promise<ResolvedTaskFile | null> {
  if (!hasTaskHome(ctx.db, input.taskId)) return null;
  const round = (ctx.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task_file WHERE task_id=? AND kind='plan-critique'").get(input.taskId) as { n: number }).n + 1;
  const plan = resolveTaskFile(ctx.db, input.taskId, "plan");
  const receipt = listStageReceipts(ctx.db, input.runId, input.taskId).find((row) => row.stageId === "plan-critique");
  return recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "plan-critique", name: `critique/plan.r${round}.json`, round,
    content: `${JSON.stringify({ round, allowed: input.allowed, reason: input.reason ?? null, plan: plan ? { path: plan.path, sha256: plan.sha256 } : null, stage: receipt?.state ?? null, result: receipt?.result ?? null }, null, 2)}\n`,
    producer: { node: "plan-critique", graph: "lp-task-pipeline", stage_id: "plan-critique", run_id: input.runId, ...(input.wfStepKey ? { wf_step_key: input.wfStepKey } : {}) },
    readers: ["writer", "pm"] });
}

/**
 * The task's close in its home: `OUTCOME.md` (state, reason, merge commit, changed files) and `lessons.md` (each attempt's LESSON line, read
 * from the attempts' report.md by the manifest; the acceptance it closed on, read the same way). Both name what they read, by path and sha256.
 */
export async function recordTaskClose(ctx: Pick<ServerCore, "bb" | "db">, input: {
  taskId: string; runId: string; attemptId: string; status: string; reason: string; mergeCommit: string | null;
  changed: ReadonlyArray<{ status: string; path: string }>; lessonOf: (report: string) => string | null;
}): Promise<{ outcome: ResolvedTaskFile | null; lessons: ResolvedTaskFile | null } | null> {
  const io = taskHomeIo(ctx, input.taskId);
  if (!io) return null;
  const producer: TaskFileProducer = { node: "lessons", graph: "lp-task-pipeline", stage_id: "after-accept", run_id: input.runId, attempt_id: input.attemptId };
  const attempts = ctx.db.prepare("SELECT DISTINCT attempt_id FROM lane_pilot_task_file WHERE task_id=? AND kind='writer-report' AND attempt_id IS NOT NULL ORDER BY created_at, rowid").all(input.taskId) as Array<{ attempt_id: string }>;
  const lessons: string[] = [];
  const sources: string[] = [];
  for (const { attempt_id: attemptId } of attempts) {
    const report = await readTaskFile(ctx.db, io, { taskId: input.taskId, kind: "writer-report", attemptId, reader: "lessons", refreshManifest: false });
    if (!report) continue;
    sources.push(`- ${report.path} (sha256 ${report.sha256})`);
    const lesson = input.lessonOf(report.text);
    if (lesson) lessons.push(`- ${attemptId}: ${lesson}`);
  }
  const acceptance = input.status === "accepted" ? await readTaskFile(ctx.db, io, { taskId: input.taskId, kind: "acceptance", reader: "lessons", refreshManifest: false }) : null;
  if (acceptance) sources.push(`- ${acceptance.path} (sha256 ${acceptance.sha256})`);
  const outcome = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "outcome", name: "OUTCOME.md", attemptId: input.attemptId, producer: { ...producer, node: "outcome" }, readers: ["pm", "project-life"],
    content: [`# OUTCOME — ${input.taskId}`, "", `state: ${input.status}${input.reason ? ` · ${input.reason}` : ""}`, `merge: ${input.mergeCommit ?? "-"}`, "", "changed:",
      ...(input.changed.length ? input.changed.map((file) => `- ${file.status} ${file.path}`) : ["- (none)"]), ""].join("\n") });
  const recorded = await recordTaskHomeFile(ctx, { taskId: input.taskId, kind: "lesson", name: "lessons.md", attemptId: input.attemptId, producer, readers: ["memory", "project-life"],
    content: [`# Lessons — ${input.taskId}`, "", ...(lessons.length ? lessons : ["- (no attempt recorded a LESSON line)"]), "", "read from:", ...(sources.length ? sources : ["- (no report in the manifest)"]), ""].join("\n") });
  return { outcome, lessons: recorded };
}

export { TASK_HOME_EXCLUDE };
