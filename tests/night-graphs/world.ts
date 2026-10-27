import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { chainRuntimeFor } from "../../src/rooms/workflow/server/workflow-executors";

/**
 * A plugin instance for the night graphs: the real database, core and engine, with BB's threads as a double. A thread "ends" when its text is set;
 * `answers` gives the reply of the n-th spawned thread (a string) or makes its spawn fail (an Error).
 */
export type NightWorld = ReturnType<typeof nightWorld>;

export function nightWorld(options: { hostPath?: string; answers?: Array<string | Error>; answerFor?: (args: Record<string, any>) => string | Error | undefined; hostReply?: (command: string, input: Record<string, any>) => string | undefined } = {}) {
  const state = {
    spawned: [] as Array<Record<string, any>>, stopped: [] as string[], archived: [] as string[], outputs: new Map<string, string>(),
    answers: [...(options.answers ?? [])], failedThreads: new Set<string>(), commands: [] as string[], kv: new Map<string, unknown>(),
  };
  const sdk = {
    providers: { list: async () => [], models: async () => ({ models: [] }) },
    projects: { get: async () => ({ name: "Real project", sources: [{ hostId: "host-1", path: options.hostPath ?? "/proj" }] }), list: async () => [] },
    environments: { get: async () => ({ id: "env-1", path: options.hostPath ?? "/proj", hostId: "host-1" }) },
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: state.failedThreads.has(threadId) ? "error" : "idle", projectId: "proj-1" }),
      getPluginMetadata: async () => ({}),
      spawn: async (args: Record<string, any>) => {
        const next = options.answerFor?.(args) ?? state.answers.shift() ?? "";
        if (next instanceof Error) throw next;
        state.spawned.push(args);
        const id = `night-thr-${state.spawned.length}`;
        state.outputs.set(id, next);
        return { id };
      },
      stop: async ({ threadId }: { threadId: string }) => { state.stopped.push(threadId); },
      archive: async ({ threadId }: { threadId: string }) => { state.archived.push(threadId); },
      output: async ({ threadId }: { threadId: string }) => ({ output: state.outputs.get(threadId) ?? "" }),
      events: { list: async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
    },
  } as never;
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const host = { call: async (method: string, input: Record<string, any>) => { state.commands.push(`${method}:${String(input.command ?? "")}`); return { hostId: "host-1", exitCode: 0, stdout: options.hostReply?.(String(input.command ?? ""), input) ?? "", stderr: "" }; } };
  Object.assign(ctx, { host });
  const engine = new WorkflowEngine({
    db, harnessVersion: "test", resolveWorkflow: (id) => builtinWorkflow(id),
    runtimeFor: (run) => chainRuntimeFor(ctx, services)(run),
  });
  registerPureActions(engine);
  const services = { workflowEngine: engine, resolveProjectWriterHost: async () => ({ status: "resolved", hostId: "host-1", path: options.hostPath ?? "/proj" }) } as any;
  const runs = (workflow?: string) => db.prepare(`SELECT id, workflow_id, status, idem_key, tokens_used FROM lane_pilot_wf_run${workflow ? " WHERE workflow_id=?" : ""} ORDER BY created_at`).all(...(workflow ? [workflow] : [])) as Array<{ id: string; workflow_id: string; status: string; idem_key: string; tokens_used: number | null }>;
  return { bb, harness, db, ctx, engine, services, state, runs };
}
