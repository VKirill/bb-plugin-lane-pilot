import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * Mirrors Lane Pilot tasks into BB Tasks (official `tasks` plugin, I3), for a project that turns `tasks.mirror` on.
 * The mirror only writes: Lane Pilot's database stays the truth, nothing is read back, and a mirror that fails (the plugin
 * absent or disabled, no tracker project linked to this BB project, a rejected call) is dropped quietly and never touches
 * a writer.
 *
 * Contract used (`plugins/tasks/shared/contract.ts`, `plugins/tasks/delegate/contract.ts`), called with `bb.sdk.plugins.callRpc`:
 * `listProjects` (the tracker project whose `linkedBbProjectId` is this BB project), `createTask`, `updateTask` (status),
 * `createComment` (always `notify:false`: a comment must not wake a worker thread), `taskThreadsAttach` (the writer's thread).
 * Status: todo while queued, in_progress while a writer works, done when accepted, canceled when canceled, in_review when
 * blocked (it waits for the PM or the owner).
 */
export const TASKS_MIRROR_KEY = "tasks.mirror";
export const TASKS_PLUGIN_ID = "tasks";
const PROJECT_TTL_MS = 5 * 60_000;
const MAPPING_PREFIX = "tasks-mirror:";

export type MirrorStatus = "todo" | "in_progress" | "in_review" | "done" | "canceled";

export function tasksMirrorEnabled(settings: Record<string, unknown>): boolean {
  const raw = settings[TASKS_MIRROR_KEY];
  // On unless turned off: a project without a linked Tasks project mirrors nothing anyway (owner: no switches to flip).
  return !(raw === false || raw === 0 || raw === "false");
}

const projectsSchema = z.object({ projects: z.array(z.object({ id: z.string(), linkedBbProjectId: z.string().nullable() }).passthrough()) }).passthrough();
const mutationSchema = z.object({ ok: z.boolean(), task: z.object({ id: z.string(), key: z.string() }).passthrough().optional() }).passthrough();
const anySchema = z.object({}).passthrough();

type CallRpc = (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;
type Mapping = { taskId: string; key: string };

export type MirrorTask = { projectId: string; runId: string; taskId: string; title: string; objective: string; acceptance: string[] };

export function createTasksMirror(bb: Pick<BbPluginApi, "sdk" | "storage" | "log">, effectiveSettings: (projectId: string, runId: string) => Promise<Record<string, unknown>>) {
  const callRpc = (bb.sdk as { plugins?: { callRpc?: CallRpc } }).plugins?.callRpc;
  const trackerProjects = new Map<string, { at: number; id: string | null }>();
  const opening = new Map<string, Promise<Mapping | null>>();
  let lastWarn = 0;

  const warn = (message: string) => {
    if (Date.now() - lastWarn < 10 * 60_000) return;
    lastWarn = Date.now();
    bb.log.info(`Lane Pilot Tasks mirror: ${message}`);
  };

  async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
    return await callRpc!({ pluginId: TASKS_PLUGIN_ID, method, input, outputSchema: schema as z.ZodType<unknown>, signal: AbortSignal.timeout(10_000) }) as T;
  }

  /** The tracker project linked to the BB project, or null (looked up again after five minutes). */
  async function trackerProject(projectId: string): Promise<string | null> {
    const cached = trackerProjects.get(projectId);
    if (cached && Date.now() - cached.at < PROJECT_TTL_MS) return cached.id;
    const listed = await call("listProjects", {}, projectsSchema);
    const found = listed.projects.find((row) => row.linkedBbProjectId === projectId)?.id ?? null;
    trackerProjects.set(projectId, { at: Date.now(), id: found });
    if (!found) warn(`no BB Tasks project is linked to ${projectId}; link one in Tasks to mirror its tasks`);
    return found;
  }

  async function mappingOf(task: MirrorTask): Promise<Mapping | null> {
    const key = `${MAPPING_PREFIX}${task.projectId}:${task.taskId}`;
    const stored = await bb.storage.kv.get<Mapping>(key).catch(() => null);
    if (stored?.taskId) return stored;
    const projectId = await trackerProject(task.projectId);
    if (!projectId) return null;
    const description = [`Lane Pilot task \`${task.taskId}\` (run ${task.runId}).`, "", task.objective,
      ...(task.acceptance.length ? ["", "Acceptance:", ...task.acceptance.map((line) => `- ${line}`)] : [])].join("\n");
    const created = await call("createTask", { projectId, title: task.title, description, status: "todo" }, mutationSchema);
    if (!created.ok || !created.task) return null;
    const mapping = { taskId: created.task.id, key: created.task.key };
    await bb.storage.kv.set(key, mapping as never);
    return mapping;
  }

  /**
   * One task's mirror: calls run in order, each swallowing its own failure. Nothing is awaited by the caller.
   * Disabled projects and absent plugins make every call a no-op.
   */
  function open(task: MirrorTask) {
    let chain: Promise<unknown> = Promise.resolve();
    let mapping: Promise<Mapping | null> | null = null;
    const resolve = (): Promise<Mapping | null> => {
      mapping ??= (async () => {
        if (!callRpc) return null;
        if (!tasksMirrorEnabled(await effectiveSettings(task.projectId, task.runId))) return null;
        const key = `${task.projectId}:${task.taskId}`;
        const running = opening.get(key);
        if (running) return await running;
        const made = mappingOf(task).finally(() => opening.delete(key));
        opening.set(key, made);
        return await made;
      })().catch((cause) => { warn(`${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      return mapping;
    };
    const step = (work: (mapped: Mapping) => Promise<unknown>) => {
      chain = chain.then(async () => {
        const mapped = await resolve();
        if (mapped) await work(mapped).catch((cause) => warn(`${cause instanceof Error ? cause.message : String(cause)}`));
      });
    };
    const status = (mapped: Mapping, next: MirrorStatus) => call("updateTask", { taskId: mapped.taskId, status: next }, mutationSchema);
    const comment = (mapped: Mapping, body: string) => call("createComment", { taskId: mapped.taskId, body, notify: false }, anySchema);
    return {
      /** A writer started: the task is in progress. */
      running: (note?: string) => step(async (mapped) => { await status(mapped, "in_progress"); if (note) await comment(mapped, note); }),
      /** A writer thread works on the task: it shows on the tracker task with its live status. */
      thread: (threadId: string, note?: string) => step(async (mapped) => {
        await call("taskThreadsAttach", { taskId: mapped.taskId, threadId }, anySchema);
        if (note) await comment(mapped, note);
      }),
      /** A milestone worth a comment, no status change. */
      note: (body: string) => step((mapped) => comment(mapped, body)),
      /** The task ended: accepted, canceled or blocked, with the line for the comment. */
      finish: (outcome: "accepted" | "canceled" | "blocked", body: string) => step(async (mapped) => {
        await status(mapped, outcome === "accepted" ? "done" : outcome === "canceled" ? "canceled" : "in_review");
        await comment(mapped, body);
      }),
    };
  }

  return { open };
}

export type TasksMirror = ReturnType<typeof createTasksMirror>;
export type TaskMirrorHandle = ReturnType<TasksMirror["open"]>;
