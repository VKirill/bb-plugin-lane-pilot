import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createOwnerAsk } from "../../src/rooms/relay/server/owner-ask";
import { logIncidents } from "../../src/rooms/self-repair/server/episodes";

// Hub, 2026-11-14 05:58:52 UTC: this successful recovery started another self-repair.
const row = {
  ts: 1794635932053,
  level: "warn",
  message: "owner question «Самоисправление «Lane Pilot token usage listing failed: fet…» lost to a reload; thr_qiij47sh6z told",
};
const read = (message = row.message) => logIncidents(JSON.stringify({ ...row, message }), row.ts - 1);

describe("owner question recovery log classification", () => {
  it("does not open a repair for the successful hub notification quoting a failure", () => {
    expect(read()).toEqual([]);
  });

  it("also treats a multiline question quoting other fault words as data", () => {
    expect(read("owner question «unhandled\nuncaught: stale API handle is retired» lost to a reload; thr_pm told")).toEqual([]);
  });

  it("still reports a failed delivery and preserves its evidence", () => {
    const message = row.message.replace(" told", " not told: send failed");
    expect(read(message)).toMatchObject([{ reason: message, at: row.ts }]);
  });

  it("retains a separate failure after the successful notification", () => {
    const message = `${row.message}; checkpoint failed`;
    expect(read(message)).toMatchObject([{ reason: message }]);
  });

  it("still reports the original token usage failure", () => {
    expect(read("Lane Pilot token usage listing failed: fetch failed")).toHaveLength(1);
  });

  it("recovers the real question and notifies its thread without opening a repair", async () => {
    const send = async () => ({});
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { send } } as never });
    await bb.storage.kv.set("owner-ask:pending:thr_qiij47sh6z", {
      threadId: "thr_qiij47sh6z", source: "repair", at: row.ts - 1,
      question: "Самоисправление «Lane Pilot token usage listing failed: fetch failed» ждёт вашего решения. Откройте тред ремонта, чтобы прочитать отчёт.",
    });
    const logs: string[] = [];
    const next = createOwnerAsk(bb, (message) => logs.push(message));
    expect(await next.recoverLost()).toEqual(["thr_qiij47sh6z"]);
    expect(logs).toEqual([row.message]);
    expect(read(logs[0])).toEqual([]);
    expect(await next.pending("thr_qiij47sh6z")).toBe(false);
  });
});
