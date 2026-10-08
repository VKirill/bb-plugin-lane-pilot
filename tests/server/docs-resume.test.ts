import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { localDateKey } from "../../src/rooms/docs/docs";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const ev = (seq: number, type: string, data: Record<string, unknown> = {}, createdAt = 1_000) => ({ seq, type, createdAt, threadId:"thr_docs", data });

async function resume(localDate: string, sentAt: number) {
  const hostCalls: string[] = [];
  // The live thr_gisgv43unw: the repair went into the turn still running - accepted, then completed, no new turn/started.
  const events = [ev(1, "client/turn/requested", {}, sentAt - 9_000), ev(8, "turn/started", {}, sentAt - 8_900),
    ev(631, "turn/completed", { status:"completed" }, sentAt - 500), ev(634, "client/turn/requested", {}, sentAt + 2_000),
    ev(643, "turn/input/accepted", {}, sentAt + 2_100), ev(1011, "turn/completed", { status:"completed" }, sentAt + 480_000)].reverse();
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ threads:{ get:async () => ({ id:"thr_docs", status:"idle" }) as never, events:{ list:async () => events as never } } as never },
    experimental_callHostRpc:(call) => { hostCalls.push(call.method); throw new Error(`stop at ${call.method}`); },
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const key = `docs-unit:proj_docs:${createHash("sha256").update("/home/ubuntu/project\napps/worker/docs").digest("hex").slice(0, 12)}`;
  await bb.storage.kv.set(key, { version:1, projectId:"proj_docs", place:{ hostId:"ovh", path:"/home/ubuntu/project" }, label:"apps/worker/docs",
    unit:{ docsDir:"apps/worker/docs", workspace:{ path:"apps/worker", name:"worker" } }, threadId:"thr_docs", phase:"repairing", sentAt,
    beforeDirty:[], localDate, since:"7d", roots:["apps/worker/docs"], workspaces:[], hasDocs:true, changedCount:1, refresh:[],
    gaps:{ missingPages:[], uncoveredCore:[] }, anchors:null, core:[], kvKey:"docs-unit-report" });
  await bb.storage.kv.set("docs-units-open", { [key]:true });
  await harness.runSchedule("docs-nightly-catchup");
  for (let tick = 0; tick < 50 && !hostCalls.length && await bb.storage.kv.get(key); tick++) await new Promise((done) => setTimeout(done, 10));
  return { hostCalls, record:await bb.storage.kv.get(key), open:await bb.storage.kv.get("docs-units-open") };
}

describe("docs units resumed from saved progress", () => {
  it("a repair taken into the running turn ends the wait, and the unit goes on to check its pages", async () => {
    const { hostCalls } = await resume(localDateKey(new Date()), Date.now() - 600_000);
    expect(hostCalls[0]).toBe("gitDocsScope");
  });

  it("a unit of a night long gone is dropped, not finished against today's checkout", async () => {
    const { hostCalls, record, open } = await resume("2026-09-29", Date.parse("2026-09-29T13:24:58Z"));
    expect(hostCalls).toEqual([]);
    expect(record).toBeUndefined();
    expect(open).toEqual({});
  });
});
