import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { expect, it } from "vitest";
import { mountPermits } from "../src/rooms/writer/server/index";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";

async function fixture() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const sends: Array<{ threadId: string }> = [];
  const listeners = new Map<string, (payload: unknown) => unknown>();
  let answerTool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
  let tickets: Array<Record<string, unknown>> = [];
  let failSend = false;
  const facade = {
    ...bb,
    agents: { registerTool: (tool: { execute: typeof answerTool.execute }) => { answerTool = tool; } },
    events: { on: (name: string, fn: (payload: unknown) => unknown) => { listeners.set(name, fn); } },
    hosts: { experimental_client: () => ({ call: async (method: string) => method === "listPermitTickets" ? { tickets } : { written: true } }) },
    sdk: { ...bb.sdk, threads: { send: async (payload: { threadId: string }) => { if (failSend) throw new Error("down"); sends.push(payload); } } },
  };
  for (const id of ["a", "b"]) {
    createRun(db, "run-" + id, "project");
    createTask(db, { id: "task-" + id, runId: "run-" + id, kind: "bb", contract: {} });
    createAttempt(db, { id, runId: "run-" + id, taskId: "task-" + id });
    transitionAttempt(db, id, "spawn_requested");
    transitionAttempt(db, id, "running", { threadId: "writer-" + id });
    db.prepare("UPDATE lane_pilot_run SET writer_host_id=?,pm_thread_id=? WHERE id=?").run("host", "pm-" + id, "run-" + id);
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run("/fixture/" + id, id);
  }
  mountPermits({ bb: facade, db, isDisposed: () => false } as never);
  const both = ["a", "b"].map((id) => ({ session: "sess-" + id, ticket: "a1b2c3d4e5f60718", category: "delete_for_good", command: "rm data.csv", cwd: "/fixture/" + id, at: 1 }));
  const emitPermit = async () => {
    listeners.get(LP_EVENTS.PERMIT_REQUESTED)?.({ hostId: "host", tickets });
    await new Promise((r) => setTimeout(r, 15));
  };
  return {
    harness, db, sends, sweep: emitPermit, answerTool: answerTool!, setTickets: (next: typeof tickets) => { tickets = next; }, both,
    setFailSend: (next: boolean) => { failSend = next; },
  };
}

it("A-025 two writers with identical command hashes both need a permit request", async () => {
  const f = await fixture();
  try {
    f.setTickets(f.both);
    await f.sweep();
    expect(f.sends.map((payload) => payload.threadId), JSON.stringify(f.sends)).toEqual(expect.arrayContaining(["pm-a", "pm-b"]));
  } finally { await f.harness.lifecycle.dispose(); }
});

it("A-025 permit answer wakes its writer rather than the first running writer on a host", async () => {
  const f = await fixture();
  try {
    // The session is not a column. The host ticket's cwd is the binding. (2026-10-29 audit A-025)
    f.setTickets(f.both);
    await f.answerTool.execute({ hostId: "host", session: "sess-b", ticket: "a1b2c3d4e5f60718", decision: "allow", why: "fixture approval" }, {});
    expect(f.sends.map((payload) => payload.threadId), JSON.stringify(f.sends)).toEqual(["writer-b"]);
  } finally { await f.harness.lifecycle.dispose(); }
});

it("A-025 a failed PM send stays unmarked and is retried", async () => {
  const f = await fixture();
  try {
    f.setFailSend(true);
    f.setTickets([f.both[0]!]);
    await f.sweep();
    expect(f.sends).toEqual([]);
    f.setFailSend(false);
    await f.sweep();
    expect(f.sends.map((payload) => payload.threadId)).toEqual(["pm-a"]);
  } finally { await f.harness.lifecycle.dispose(); }
});
