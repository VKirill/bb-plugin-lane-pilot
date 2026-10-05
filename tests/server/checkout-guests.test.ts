import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createAttempt, createRun, openDatabase } from "../../src/database";
import { askGuestsToCommit, listGuests, noteCheckoutGuest } from "../../src/server/checkout-guests";

function setup(metadata: Record<string, unknown> = {}, archived: string[] = []) {
  const sent: Array<{ threadId: string; text: string }> = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
    getPluginMetadata:async ({ threadId }: { threadId:string }) => metadata[threadId] ?? null,
    get:async ({ threadId }: { threadId:string }) => ({ id:threadId, archivedAt:archived.includes(threadId) ? 1 : null }),
    send:vi.fn(async (args: { threadId:string; input:Array<{ text:string }> }) => { sent.push({ threadId:args.threadId, text:args.input[0]!.text }); return {}; }),
  } } as never });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo/plugin");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run'").run();
  createAttempt(db, { id:"a", runId:"run", taskId:"t" });
  return { bb, db, sent };
}

it("remembers an ordinary chat working in a run's folder and tells it once to commit as it goes", async () => {
  const { bb, db, sent } = setup({ thr_writer:{ role:"writer" } });
  await noteCheckoutGuest(bb, db, "thr_owner", "/repo/plugin");
  await noteCheckoutGuest(bb, db, "thr_owner", "/repo/plugin/");
  expect(sent.map((row) => row.threadId)).toEqual(["thr_owner"]);
  expect(sent[0]!.text).toContain("Коммить свои правки сразу");
  expect((await listGuests(bb.storage.kv, "/repo/plugin")).map((row) => row.threadId)).toEqual(["thr_owner"]);
  // Lane Pilot's own threads, the PM and folders without a run are not guests.
  await noteCheckoutGuest(bb, db, "thr_writer", "/repo/plugin");
  await noteCheckoutGuest(bb, db, "thr_pm", "/repo/plugin");
  await noteCheckoutGuest(bb, db, "thr_other", "/elsewhere");
  expect((await listGuests(bb.storage.kv, "/repo/plugin")).map((row) => row.threadId)).toEqual(["thr_owner"]);
});

it("asks the folder's chats by name to commit blocking edits, at most once an hour, skipping archived ones", async () => {
  const { bb, db, sent } = setup({}, ["thr_gone"]);
  await noteCheckoutGuest(bb, db, "thr_gone", "/repo/plugin");
  await noteCheckoutGuest(bb, db, "thr_owner", "/repo/plugin");
  sent.length = 0;
  expect(await askGuestsToCommit(bb, "/repo/plugin", ["host/rpc.ts"], "wp-publish")).toEqual(["thr_owner"]);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain("host/rpc.ts");
  expect(sent[0]!.text).toContain("Если правки не твои — не трогай их");
  // A guest that could not commit reverted its own edit in the live check; it must never discard work for a merge.
  expect(sent[0]!.text).toContain("Никогда не выбрасывай и не откатывай правки");
  expect(await askGuestsToCommit(bb, "/repo/plugin", ["host/rpc.ts"], "wp-publish")).toEqual(["thr_owner"]);
  expect(sent).toHaveLength(1);
});
