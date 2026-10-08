import { describe, expect, it } from "vitest";
import { createRelay, type RelayItem } from "../src/server/relay";
import { createAttempt, createRun, openDatabase } from "../src/database";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { relayFor } from "../src/server/relay";

describe("relay retargeting and canceled task dropping", () => {
  it("Redispatching <id>.2 retargets open reminders on <id> or <id>.1 to <id>.2", async () => {
    let items: RelayItem[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const familyMembers = new Map<string, { taskId: string; state: string | null }>();
    const taskStates = new Map<string, string | null>();

    const relay = createRelay({
      load: async () => structuredClone(items),
      save: async (next) => { items = structuredClone(next); },
      send: async (threadId, text) => { sent.push({ threadId, text }); },
      settled: async () => false,
      output: async () => "",
      taskStates: async (_proj, ids) => Object.fromEntries(ids.map((id) => [id, taskStates.get(id) ?? null])),
      latestFamilyMember: async (_proj, id) => familyMembers.get(id) ?? null,
      now: () => 1000,
      log: () => undefined,
    });

    // Create reminder watching P1 and other-task.1
    await relay.remind({
      projectId: "proj",
      threadId: "pm",
      note: "watch tasks",
      inMinutes: 30,
      taskIds: ["P1", "other-task.1"],
    });

    expect(items[0]?.kind).toBe("remind");
    if (items[0]?.kind === "remind") {
      expect(items[0].taskIds).toEqual(["P1", "other-task.1"]);
    }

    // Now redispatched: P1 -> P1.2, other-task.1 -> other-task.2
    familyMembers.set("P1", { taskId: "P1.2", state: "running" });
    familyMembers.set("other-task.1", { taskId: "other-task.2", state: "running" });
    taskStates.set("P1.2", "running");
    taskStates.set("other-task.2", "running");

    const result = await relay.sweep();
    expect(result.fired).toBe(0);

    // Verify reminder taskIds were retargeted
    if (items[0]?.kind === "remind") {
      expect(items[0].taskIds).toEqual(["P1.2", "other-task.2"]);
      expect(items[0].firedAt).toBeNull();
    }
  });

  it("A canceled task is removed from reminders; an empty reminder closes without waking", async () => {
    let items: RelayItem[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const taskStates = new Map<string, string | null>();

    const relay = createRelay({
      load: async () => structuredClone(items),
      save: async (next) => { items = structuredClone(next); },
      send: async (threadId, text) => { sent.push({ threadId, text }); },
      settled: async () => false,
      output: async () => "",
      taskStates: async (_proj, ids) => Object.fromEntries(ids.map((id) => [id, taskStates.get(id) ?? null])),
      now: () => 1000,
      log: () => undefined,
    });

    // 1. Reminder with two tasks: one is canceled, one still running
    await relay.remind({
      projectId: "proj",
      threadId: "pm",
      note: "watch both",
      inMinutes: 30,
      taskIds: ["task-a", "task-b"],
    });

    taskStates.set("task-a", "canceled");
    taskStates.set("task-b", "running");

    await relay.sweep();

    expect(sent).toHaveLength(0);
    if (items[0]?.kind === "remind") {
      expect(items[0].taskIds).toEqual(["task-b"]);
      expect(items[0].firedAt).toBeNull();
    }

    // 2. Reminder with only one task, which gets canceled -> closes silently without waking
    await relay.remind({
      projectId: "proj",
      threadId: "pm",
      note: "watch only c",
      inMinutes: 30,
      taskIds: ["task-c"],
    });

    taskStates.set("task-c", "canceled");

    await relay.sweep();

    expect(sent).toHaveLength(0);
    const itemC = items.find((it) => it.kind === "remind" && it.note === "watch only c");
    expect(itemC?.kind).toBe("remind");
    if (itemC?.kind === "remind") {
      expect(itemC.firedAt).toBe(1000);
      expect(itemC.taskIds).toEqual([]);
    }
  });

  it("A watched task that ends while a newer family member is open does not fire the reminder", async () => {
    let items: RelayItem[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const familyMembers = new Map<string, { taskId: string; state: string | null }>();
    const taskStates = new Map<string, string | null>();

    const relay = createRelay({
      load: async () => structuredClone(items),
      save: async (next) => { items = structuredClone(next); },
      send: async (threadId, text) => { sent.push({ threadId, text }); },
      settled: async () => false,
      output: async () => "",
      taskStates: async (_proj, ids) => Object.fromEntries(ids.map((id) => [id, taskStates.get(id) ?? null])),
      latestFamilyMember: async (_proj, id) => familyMembers.get(id) ?? null,
      now: () => 1000,
      log: () => undefined,
    });

    // PM reminder watching unisender-cards-and-paid-lists.2
    await relay.remind({
      projectId: "proj",
      threadId: "pm",
      note: "unisender cards",
      inMinutes: 60,
      taskIds: ["unisender-cards-and-paid-lists.2"],
    });

    // .2 ended (e.g. blocked), but .3 was already redispatched and is running
    familyMembers.set("unisender-cards-and-paid-lists.2", {
      taskId: "unisender-cards-and-paid-lists.3",
      state: "running",
    });
    taskStates.set("unisender-cards-and-paid-lists.2", "blocked");
    taskStates.set("unisender-cards-and-paid-lists.3", "running");

    const result = await relay.sweep();
    expect(result.fired).toBe(0);
    expect(sent).toHaveLength(0);

    // Retargeted to .3
    if (items[0]?.kind === "remind") {
      expect(items[0].taskIds).toEqual(["unisender-cards-and-paid-lists.3"]);
      expect(items[0].firedAt).toBeNull();
    }

    // Now .3 also completes (accepted) -> reminder should fire!
    taskStates.set("unisender-cards-and-paid-lists.3", "accepted");
    const result2 = await relay.sweep();
    expect(result2.fired).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("unisender-cards-and-paid-lists.3 — accepted");
  });

  it("Works end-to-end with relayFor and SQLite database", async () => {
    const sent: Array<{ threadId: string; text: string }> = [];
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          send: (async (opts: any) => {
            // A message with `sendAt` is held in BB's queue until then (the reminder's time); only the others arrive now.
            if (opts.sendAt !== undefined) return { delivery: "queued" as const, ok: true as const, queuedMessage: { id: "row-1" } };
            sent.push({ threadId: opts.threadId, text: opts.input[0]?.text ?? "" });
            return { delivery: "sent" as const, ok: true as const };
          }) as any,
          queuedMessages: { delete: async () => ({ ok: true }), list: async () => [{ id: "row-1" }] } as any,
        } as any,
      } as any,
    });
    const db = openDatabase(bb);
    createRun(db, "run-1", "proj-1", "cli", "/repo");

    const ctx = {
      bb,
      db,
      isDisposed: () => false,
      log: () => undefined,
    } as any;

    const relay = relayFor(ctx);

    // Attempt 1: task P1.2 fails/blocks
    createAttempt(db, { id: "att-1", runId: "run-1", taskId: "unisender.2" });
    db.prepare("UPDATE lane_pilot_attempt SET state='blocked', created_at=10 WHERE id='att-1'").run();

    // PM sets a reminder on unisender.2
    await relay.remind({
      projectId: "proj-1",
      threadId: "pm-thread",
      note: "check unisender",
      inMinutes: 30,
      taskIds: ["unisender.2"],
    });

    // Task is redispatched as unisender.3 and is running
    createAttempt(db, { id: "att-2", runId: "run-1", taskId: "unisender.3" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running', created_at=20 WHERE id='att-2'").run();

    // Sweep: should retarget to unisender.3 and NOT fire
    const res1 = await relay.sweep();
    expect(res1.fired).toBe(0);
    expect(sent).toHaveLength(0);

    const list = await relay.list("pm-thread");
    expect(list[0]?.kind).toBe("remind");
    if (list[0]?.kind === "remind") {
      expect(list[0].taskIds).toEqual(["unisender.3"]);
    }

    // Now attempt 2 finishes as accepted
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=30 WHERE id='att-2'").run();

    // Sweep: should now fire!
    const res2 = await relay.sweep();
    expect(res2.fired).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("unisender.3 — accepted");
  });
});
