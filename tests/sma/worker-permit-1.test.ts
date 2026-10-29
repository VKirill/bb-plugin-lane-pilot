import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { mountPermits } from "../../src/rooms/permits";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/storage/database";

describe("permit decision", () => {
  it("[sma:wb_decision] allow and deny are written for that ticket, and the writer is told in the same session", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const sends: Array<{ threadId: string; mode?: string; text?: string }> = [];
    const answers: Array<Record<string, unknown>> = [];
    let answerTool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    const tickets = [{ session: "sess-b", ticket: "a1b2c3d4e5f60718", category: "delete_for_good", command: "rm data.csv", cwd: "/fixture/b", at: 1 }];
    const facade = {
      ...bb,
      agents: { registerTool: (tool: { execute: NonNullable<typeof answerTool>["execute"] }) => { answerTool = tool; } },
      background: { schedule: () => undefined },
      hosts: { experimental_client: () => ({ call: async (method: string, payload: Record<string, unknown>) => {
        if (method === "answerPermit") answers.push(payload);
        return method === "listPermitTickets" ? { tickets } : { written: true };
      } }) },
      sdk: { ...bb.sdk, threads: { send: async (payload: { threadId: string; mode?: string; input?: Array<{ text?: string }> }) => {
        sends.push({ threadId: payload.threadId, mode: payload.mode, text: payload.input?.[0]?.text });
      } } },
    };
    createRun(db, "run-b", "project");
    createTask(db, { id: "task-b", runId: "run-b", kind: "bb", contract: {} });
    createAttempt(db, { id: "b", runId: "run-b", taskId: "task-b" });
    transitionAttempt(db, "b", "spawn_requested");
    transitionAttempt(db, "b", "running", { threadId: "writer-b" });
    db.prepare("UPDATE lane_pilot_run SET writer_host_id=?, pm_thread_id=? WHERE id=?").run("host", "pm-b", "run-b");
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run("/fixture/b", "b");
    mountPermits({ bb: facade, db, isDisposed: () => false } as never);
    try {
      for (const decision of ["allow", "deny"] as const) {
        sends.length = 0;
        await answerTool!.execute({ hostId: "host", session: "sess-b", ticket: "a1b2c3d4e5f60718", decision, why: "the task owns this file" }, {});
        expect(sends).toEqual([expect.objectContaining({ threadId: "writer-b", mode: "queue-if-active" })]);
        expect(sends[0]!.text).toContain(decision === "allow" ? "granted" : "refused");
      }
      expect(answers.map((row) => row.decision)).toEqual(["allow", "deny"]);
      expect(answers.every((row) => row.ticket === "a1b2c3d4e5f60718" && row.session === "sess-b")).toBe(true);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.todo("[sma:wb_decision] the decision is applied on an after-turn wheel");
});
