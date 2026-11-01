import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, saveReasoningTrace, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import incident from "./fixtures/writer-finish-reload-2026-11-01.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function world(row = incident.attempts[0]) {
  const host = createFakePluginHost({ pluginId:"lane-pilot" });
  const { bb } = host;
  const db = openDatabase(bb);
  const projectId = "proj_acpiaqf4wq";
  const config = { projectId, hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
    pmProviderId:"codex", pmModel:"test", writerProviderId:"opencode2", writerModel:"test" } as PrototypeConfig;
  // The log has no contract or writer id at the interrupted dispatch: only the recorded attempt identity is replayed.
  const task: TaskV2 = { schema_version:2, id:row.task_id, title:"Write", risk:"low", lane:"writer", project_cwd:"/repo",
    read_first:[], interfaces:[], invariants:[], out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"],
    never_touch:[], depends_on:[], objective:"write", acceptance:["file exists"], verify:"none", verification:[] };
  createRun(db, row.run_id, projectId, "cli", "/repo");
  createTask(db, { id:row.task_id, runId:row.run_id, kind:"bb", contract:task });
  createAttempt(db, { id:row.id, runId:row.run_id, taskId:row.task_id });
  transitionAttempt(db, row.id, "spawn_requested");
  transitionAttempt(db, row.id, "running", { threadId:"writer" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo' WHERE id=?").run(row.id);
  saveReasoningTrace(db, { attemptId:row.id, providerId:"opencode2",
    dispatchContext:{ skillPick:{ materialized:["verification"] } } } as never);
  const state = { disposed:false };
  bb.onDispose(() => { state.disposed = true; });
  const logs: string[] = [];
  const events = vi.fn(async (_input: { limit?:string }): Promise<unknown[]> => []);
  const getThreadBounded = vi.fn(async () => ({ status:"error" }));
  const call = vi.fn(async () => ({ exitCode:0, stdout:"", stderr:"" }));
  const finish = createWriterFinish({ bb:{ ...bb, sdk:{ ...bb.sdk, threads:{ ...bb.sdk.threads, events:{ list:events } } } },
    db, state, getThreadBounded, host:{ call }, log:(line:string) => logs.push(line) } as never,
  { runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }) } as never);
  const run = () => finish.finishWriterAttempt({ projectId, config, task, runId:row.run_id, taskId:row.task_id,
    attemptId:row.id, pmThreadId:"pm", writerThreadId:"writer", dirtBefore:[] });
  return { host, db, logs, events, getThreadBounded, call, run };
}

describe("writer finalization across the observed reload (2026-11-01)", () => {
  it.each(incident.attempts)("preserves the interrupted writer's error after dispose: $task_id", async (row) => {
    const w = world(row);
    const reading = deferred<void>();
    const pending = deferred<{ status:string }>();
    const interrupted = new Error("Lane Pilot was reloaded while the writer ran");
    w.getThreadBounded.mockImplementationOnce(() => { reading.resolve(); return pending.promise; });
    // The body's error handler re-reads thread status; keep that read independent of the closed database.
    w.getThreadBounded.mockResolvedValue({ status:"active" });
    const result = w.run().catch((cause:unknown) => cause);
    try {
      await reading.promise;
      await w.host.harness.dispose();
      expect(w.db.open).toBe(false);
      const prepare = vi.spyOn(w.db, "prepare");
      pending.reject(interrupted);
      const error = await result;
      expect(w.logs).not.toContain(incident.logs.find((log) => log.message.startsWith("writer skill switch metric failed:"))!.message);
      expect(error).toBe(interrupted);
      expect(prepare).not.toHaveBeenCalled();
      expect(w.events).not.toHaveBeenCalled();
      expect(w.call).not.toHaveBeenCalled();
      prepare.mockRestore();
    } finally { await w.host.harness.dispose(); }
  });

  it("does no database work or skill removal when reload lands during the final event read", async () => {
    const w = world();
    const reading = deferred<void>();
    const pending = deferred<unknown[]>();
    w.events.mockImplementation(async (input) => {
      if (input.limit !== "100") return [];
      reading.resolve();
      return pending.promise;
    });
    const result = w.run().catch((cause:unknown) => cause);
    try {
      await reading.promise;
      await w.host.harness.dispose();
      const prepare = vi.spyOn(w.db, "prepare");
      pending.resolve([]);
      expect(await result).toMatchObject({ status:"provider_error", reason:"writer thread status error" });
      expect(prepare).not.toHaveBeenCalled();
      expect(w.call).not.toHaveBeenCalled();
      expect(w.logs).toEqual([]);
      prepare.mockRestore();
    } finally { await w.host.harness.dispose(); }
  });

  it("still records the outcome and removes materialized skills while the instance is live", async () => {
    const w = world();
    try {
      expect(await w.run()).toMatchObject({ status:"provider_error" });
      expect(w.db.prepare("SELECT attempt_id, task_id, outcome FROM lane_pilot_skill_metric").all())
        .toEqual([{ attempt_id:incident.attempts[0].id, task_id:incident.attempts[0].task_id, outcome:"failed" }]);
      expect(w.events.mock.calls.filter(([input]) => input.limit === "100")).toHaveLength(1);
      expect(w.call).toHaveBeenCalledOnce();
      expect(w.logs).toEqual([]);
    } finally { await w.host.harness.dispose(); }
  });
});
