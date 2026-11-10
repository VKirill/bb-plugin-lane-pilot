import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
const taskWords = { ask: async () => undefined, answer: () => undefined };
import { describe, expect, it } from "vitest";
import { registerQueueTool } from "../../src/rooms/tasks/server/queue-tool";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";

// [Gemini F-008.3] the PM records the owner's word with lane_pilot_queue {action:"word"} while the task's latest attempt is
// still running — that attempt is the one waiting for the word in finish.ts and lands by itself within a minute. Telling the
// PM to resend it made two attempts of one task; a task whose latest attempt is blocked does need the resend.
describe("lane_pilot_queue word", () => {
  async function world() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "P", "bb", "/repo");
    setRunThread(db, "run1", "pm-thread");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} as never });
    registerQueueTool({ db, bb, log: () => undefined, isDisposed: () => false } as never, { ask: async () => undefined, answer: () => undefined, decide: () => ({ ok: true as const }) });
    const word = async () => JSON.parse(String(await harness.behavior.callAgentTool(
      "lane_pilot_queue", { action: "word", taskId: "t1", decision: "yes", text: "да" }, { threadId: "pm-thread", projectId: "P" },
    ))) as { next: string };
    return { db, word };
  }

  it("says «do not resend» while the latest attempt is still running (it waits for the word and lands by itself)", async () => {
    const { db, word } = await world();
    createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "t1-a1", "spawn_requested");
    transitionAttempt(db, "t1-a1", "running", { threadId: "thr_w" });
    expect((await word()).next).toContain("do not resend");
  });

  it("says to send the task again when its latest attempt is blocked", async () => {
    const { db, word } = await world();
    createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "t1-a1", "spawn_requested");
    transitionAttempt(db, "t1-a1", "running", { threadId: "thr_w" });
    db.prepare("UPDATE lane_pilot_attempt SET state='blocked' WHERE id='t1-a1'").run();
    expect((await word()).next).toContain("send the task again");
  });
});
