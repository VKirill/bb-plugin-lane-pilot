import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { mountLifecycleEvents } from "../../src/rooms/core/server/lifecycle-events";
import { closeBacklogItem } from "../../src/rooms/host-worker/host-handlers";
import { readThreadLive } from "../../src/rooms/runs/server/thread-live";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createWriterDispatch } from "../../src/rooms/writer/server/dispatch";

describe("thread live and the granted reader", () => {
  it("[sma:m_cd_board] [sma:m_cd_live_dot] a running task is read from the board, and a thread with no run is empty", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run_live", "proj", "bb");
    setRunThread(db, "run_live", "thr_pm");
    createTask(db, { id: "task_live", runId: "run_live", kind: "bb", contract: { title: "Fix the door", display_title: "Fix the door" } });
    createAttempt(db, { id: "attempt_live", runId: "run_live", taskId: "task_live" });
    transitionAttempt(db, "attempt_live", "spawn_requested");
    transitionAttempt(db, "attempt_live", "running", { threadId: "thr_writer" });
    const pm = readThreadLive(db, "thr_pm");
    expect(pm?.items.map((item) => item.title)).toEqual(["Fix the door"]);
    expect(pm?.items[0]).toMatchObject({ column: "running", state: "running" });
    expect(JSON.stringify(pm)).not.toContain("hello from the chat");
    expect(readThreadLive(db, "thr_unknown")).toBeNull();
  });

  it("[sma:m_cf_tools] an absolute path or a .. path is refused before any host read", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run_read" }));
    const db = openDatabase(bb);
    createRun(db, "run_read", "proj", "bb", "/work/proj", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host_read");
    setRunThread(db, "run_read", "thr_pm");
    const core = createCore(bb, db);
    const calls: unknown[] = [];
    (core as unknown as { host: { call: (method: string, input: unknown) => Promise<unknown> } }).host = {
      call: async (_method, input) => { calls.push(input); return { hostId: "host_read", content: "file" }; },
    };
    const { readWriterWorkspaceFile } = createWriterDispatch(core, {} as never);
    const read = (path: string) => readWriterWorkspaceFile({ threadId: "thr_pm", projectId: "proj", path, offset: 0, maxLines: 40 });
    await expect(read("/etc/passwd")).rejects.toThrow(/lane_pilot_read_path_escaped_workspace/);
    await expect(read("../outside")).rejects.toThrow(/lane_pilot_read_path_escaped_workspace/);
    expect(calls).toEqual([]);
    await expect(read("src/door.ts")).resolves.toMatchObject({ hostId: "host_read", content: "file" });
    expect(calls[0]).toMatchObject({ relativePath: "src/door.ts", projectCwd: "/work/proj" });
  });

  it("[sma:m_cd_accepted] a dispatched message is handed on before any answer is sent", async () => {
    const previous = process.env.LANE_PILOT_THREAD_SIGNALS;
    process.env.LANE_PILOT_THREAD_SIGNALS = "1";
    try {
      const sent: string[] = [];
      const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
        get: async () => makeThreadResponse({ id: "thr_pm" }),
        send: async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return { delivery: "sent", ok: true }; },
      } } } as never);
      const db = openDatabase(host);
      const handlers = new Map<string, (payload: unknown) => unknown>();
      const bb = Object.assign(Object.create(host), { pluginId: "lane-pilot", events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } } });
      const queued: string[] = [];
      mountLifecycleEvents({ bb, db, isDisposed: () => false, nativeInstaller: { forget: async () => {} } } as never, {
        onQueued: (name) => { queued.push(name); },
      });
      await handlers.get("message.dispatched")?.({ entry: makeQueueEntry({ threadId: "thr_pm" }) });
      expect(queued).toEqual(["message.dispatched"]);
      expect(sent).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.LANE_PILOT_THREAD_SIGNALS;
      else process.env.LANE_PILOT_THREAD_SIGNALS = previous;
    }
  });
});

describe("closing one backlog line", () => {
  it("[sma:m_in_close_line] one status line becomes done and the other lines stay", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-close-"));
    const dir = join(root, ".agents", "todos", "items", "t-door");
    const file = join(dir, "meta.yaml");
    try {
      const close = (id: string) => closeBacklogItem({ requestedHostId: "h", projectCwd: root, id }, {} as never);
      writeMeta(dir, file, "id: t-door\nstatus: open\nestimate: 2\n");
      await expect(close("t-door")).resolves.toMatchObject({ status: "closed" });
      expect(readFileSync(file, "utf8")).toBe("id: t-door\nstatus: done\nestimate: 2\n");
      await expect(close("t-door")).resolves.toMatchObject({ status: "already" });
      writeMeta(dir, file, "status: open\nstatus: blocked\n");
      await expect(close("t-door")).resolves.toMatchObject({ status: "refused" });
      expect(readFileSync(file, "utf8")).toBe("status: open\nstatus: blocked\n");
      await expect(close("missing")).resolves.toMatchObject({ status: "refused" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.todo("[sma:m_in_close_line] closing a line does not require the piece to be an accepted batch piece"); // deferral:dfr_seed_skip_sma_gaps
});

describe("conversation book the proofs name but the code does not keep", () => {
  it.todo("[sma:m_cb_list] releaseActivation does not list up to 50 conversations or mark which are live"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cb_rename] no name of at most 60 characters is stored apart from a transcript"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cd_reply] thread-live returns a task board, not a frame of turn id and status without the conversation words"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_settings] no default of 12 turns, and no window change applied from the next turn"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_ce_boundary] the line under the input (queues on your word, acceptance is yours) is not in Lane Pilot"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_context] past turns are not packed into the model budget; the cited fast path is lane-stack lane-mods"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_spawn] a free branch does not launch the process itself; the cited allow-list is lane-stack guard_shell"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:m_cf_timeout] a turn is not cut at four minutes with the empty answer, the turn limit and a vendor refusal named"); // deferral:dfr_seed_skip_sma_gaps
});

function writeMeta(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
}
