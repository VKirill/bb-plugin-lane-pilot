import { z } from "zod";
import { scheduleIsolated } from "../../core/server";
import type { ServerCore } from "../../core/server";
import { isSandboxProjectName } from "./canary";

/**
 * Lane Pilot's own projects (the drill's sandbox «LP sandbox …», the fixed task set's «LP bench …») stay out of the owner's sidebar: they
 * are BB projects only because every agent thread lives in one (owner, 2026-10-23: «а зачем это вообще выводить в бб?»). They are hidden
 * the way the owner hides a project by hand, project-folders' item style `hidden` (its sidebar leaves them out, their chats and work go on,
 * «Show hidden» shows them dimmed). A project the owner already styled is left as he set it.
 */
type ProjectsApi = { list(query: unknown): Promise<Array<{ id: string; name?: string }>> };
type CallRpc = (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown>;

export async function hideServiceProjects(deps: { projects: ProjectsApi | undefined; callRpc: CallRpc | undefined; log(line: string): void }): Promise<string[]> {
  if (!deps.projects || !deps.callRpc) return [];
  const service = (await deps.projects.list({ includePersonal: true })).filter((row) => isSandboxProjectName(row.name));
  if (!service.length) return [];
  const prefs = await deps.callRpc({ pluginId: "project-folders", method: "prefs_get", input: null, outputSchema: z.object({ items: z.record(z.string(), z.unknown()) }).passthrough() }) as { items: Record<string, unknown> };
  const hidden: string[] = [];
  for (const project of service) {
    if (prefs.items[`p:${project.id}`] !== undefined) continue;
    await deps.callRpc({ pluginId: "project-folders", method: "item_style_save", input: { key: `p:${project.id}`, style: { hidden: true } }, outputSchema: z.object({ ok: z.literal(true) }) });
    hidden.push(project.id);
  }
  if (hidden.length) deps.log(`Lane Pilot: hid its service project(s) from the sidebar: ${hidden.join(", ")}`);
  return hidden;
}

/** Once at start and every night: a bench project created since then is hidden too. Without project-folders nothing happens. */
export function mountServiceProjects(ctx: ServerCore): void {
  const { bb } = ctx;
  const run = async () => {
    if (ctx.isDisposed()) return;
    await hideServiceProjects({
      projects: (bb.sdk as unknown as { projects?: ProjectsApi }).projects,
      callRpc: (bb.sdk as unknown as { plugins?: { callRpc?: CallRpc } }).plugins?.callRpc,
      log: (line) => bb.log.info(line),
    }).catch((cause: unknown) => bb.log.info(`Lane Pilot could not hide its service projects: ${cause instanceof Error ? cause.message : String(cause)}`));
  };
  const timer = setTimeout(() => { void run(); }, 90_000);
  bb.onDispose(() => clearTimeout(timer));
  scheduleIsolated(bb, "service-projects", "37 5 * * *", run, { timeoutMs: 5 * 60_000 });
}
