import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { closeOwnerItem, collectOwnerWaiting, loadPushConfig, postOwnerItem } from "../../src/rooms/owner-waiting";
import { ownerWaitingRpc, runWaitingCli, savePushConfig } from "../../src/rooms/owner-waiting/server";

// 2026-11-24 11:00 Europe/Madrid (UTC+1).
const DAY1 = Date.parse("2026-11-24T10:00:00.000Z");
const HOUR = 3_600_000;

function makeDb() {
  return openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
}

describe("attention budget (daily decision_cap)", () => {
  it("defaults decision_cap to 5, validates 0-50, and updates via CLI and RPC", async () => {
    const db = makeDb();
    expect(loadPushConfig(db).decisionCap).toBe(5);

    const cliSet = runWaitingCli(db, ["config", "decision_cap", "3"], DAY1);
    expect(cliSet.exitCode).toBe(0);
    expect(JSON.parse(cliSet.stdout!).decisionCap).toBe(3);
    expect(loadPushConfig(db).decisionCap).toBe(3);

    const cliEq = runWaitingCli(db, ["config", "decision_cap=12"], DAY1);
    expect(cliEq.exitCode).toBe(0);
    expect(JSON.parse(cliEq.stdout!).decisionCap).toBe(12);

    expect(runWaitingCli(db, ["config", "decision_cap", "51"], DAY1).exitCode).toBe(1);
    expect(runWaitingCli(db, ["config", "decision_cap", "-1"], DAY1).exitCode).toBe(1);
    expect(runWaitingCli(db, ["config", "decision_cap", "nope"], DAY1).exitCode).toBe(1);

    const rpc = ownerWaitingRpc(db);
    const updated = (await rpc.owner_waiting_config({ patch: { decision_cap: 7 } })) as { decisionCap: number };
    expect(updated.decisionCap).toBe(7);
    expect(loadPushConfig(db).decisionCap).toBe(7);
  });

  it("defers the 6th decision of a day with desk: true while keeping decision_day in config", () => {
    const db = makeDb();
    for (let i = 1; i <= 6; i += 1) {
      postOwnerItem(
        db,
        {
          key: `dec:${i}`,
          source: "night",
          kind: "proposal",
          reason: "decision",
          what: `Предложение ${i}`,
          why: "Требует решения владельца",
          wake: true,
        },
        DAY1 + i * 1_000,
      );
    }

    const logs: string[] = [];
    const first = collectOwnerWaiting(db, DAY1 + 10_000, [], { log: (m) => logs.push(m) });
    const nowKeys = first.items.filter((i) => i.tier === "now").map((i) => i.key);
    expect(nowKeys).toEqual(["dec:1", "dec:2", "dec:3", "dec:4", "dec:5"]);
    expect(first.now).toBe(5);

    const sixth = first.items.find((i) => i.key === "dec:6")!;
    expect(sixth).toMatchObject({ tier: "later", wake: false, desk: true });
    expect(logs).toEqual(["attention budget decisions_today=5 cap=5 deferred=1"]);

    const persisted = db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key='decision_day'").get() as { value: string };
    expect(persisted.value).toBe("2026-11-24:5");

    // Closing one of today's 5 decisions does not allow a 6th decision to wake on the same day.
    closeOwnerItem(db, "dec:1", "screen", DAY1 + 20_000);
    const second = collectOwnerWaiting(db, DAY1 + 30_000);
    expect(second.items.filter((i) => i.tier === "now").map((i) => i.key)).toEqual(["dec:2", "dec:3", "dec:4", "dec:5"]);
    expect(second.now).toBe(4);
    expect(second.items.find((i) => i.key === "dec:6")).toMatchObject({ tier: "later", wake: false, desk: true });
  });

  it("never defers red, blocked, or term items and lets red wake even past the decision cap", () => {
    const db = makeDb();
    for (let i = 1; i <= 6; i += 1) {
      postOwnerItem(
        db,
        { key: `dec:${i}`, source: "night", kind: "proposal", reason: "decision", what: `Решение ${i}`, why: "почему", wake: true },
        DAY1 + i * 1_000,
      );
    }
    // Red item posted without explicit wake defaults to wake: true; decision/blocked/term without wake default to false.
    postOwnerItem(db, { key: "red:1", source: "night", kind: "canary_red", reason: "red", what: "Красная канарейка", why: "сломалось" }, DAY1 + 10_000);
    postOwnerItem(db, { key: "blk:1", source: "wall", kind: "wall", reason: "blocked", what: "Стена", why: "стоит", wake: true }, DAY1 + 11_000);
    postOwnerItem(db, { key: "trm:1", source: "deferral_term", kind: "deferral_term", reason: "term", what: "Истекает срок", why: "срок", wake: true }, DAY1 + 12_000);
    postOwnerItem(db, { key: "dec:default", source: "night", kind: "proposal", reason: "decision", what: "Тихое предложение", why: "по умолчанию на стол" }, DAY1 + 13_000);

    const waiting = collectOwnerWaiting(db, DAY1 + 20_000);
    const red = waiting.items.find((i) => i.key === "red:1")!;
    const blk = waiting.items.find((i) => i.key === "blk:1")!;
    const trm = waiting.items.find((i) => i.key === "trm:1")!;
    const decDefault = waiting.items.find((i) => i.key === "dec:default")!;
    expect(red).toMatchObject({ tier: "now", wake: true });
    expect(red.desk).toBeUndefined();
    expect(blk).toMatchObject({ tier: "now", wake: true });
    expect(blk.desk).toBeUndefined();
    expect(trm).toMatchObject({ tier: "now", wake: true });
    expect(trm.desk).toBeUndefined();
    expect(decDefault.wake).toBe(false);

    // Triggering collectOwnerWaiting first to fill decision_day=5, then adding a red item: red still wakes.
    const db2 = makeDb();
    for (let i = 1; i <= 5; i += 1) {
      postOwnerItem(db2, { key: `d:${i}`, source: "night", kind: "proposal", reason: "decision", what: `D ${i}`, why: "why", wake: true }, DAY1 + i * 1_000);
    }
    collectOwnerWaiting(db2, DAY1 + 10_000);
    postOwnerItem(db2, { key: "red:after", source: "night", kind: "canary_red", reason: "red", what: "Новый сбой", why: "срочно" }, DAY1 + 20_000);
    const after = collectOwnerWaiting(db2, DAY1 + 30_000);
    expect(after.items.find((i) => i.key === "red:after")).toMatchObject({ tier: "now", wake: true });
  });

  it("resets the counter on the next owner-local day", () => {
    const db = makeDb();
    savePushConfig(db, { timezone: "Europe/Madrid" }, DAY1);
    for (let i = 1; i <= 6; i += 1) {
      postOwnerItem(db, { key: `dec:${i}`, source: "night", kind: "proposal", reason: "decision", what: `D ${i}`, why: "why", wake: true }, DAY1 + i * 1_000);
    }
    const day1 = collectOwnerWaiting(db, DAY1 + 10_000);
    expect(day1.items.find((i) => i.key === "dec:6")).toMatchObject({ tier: "later", wake: false, desk: true });

    // Close the first 5 so dec:6 is the remaining open item.
    for (let i = 1; i <= 5; i += 1) closeOwnerItem(db, `dec:${i}`, "screen", DAY1 + 20_000);

    // 23:30 UTC on 2026-11-24 is 00:30 on 2026-11-25 in Europe/Madrid (UTC+1) -> counter resets!
    const nextLocalDay = Date.parse("2026-11-24T23:30:00.000Z");
    const day2 = collectOwnerWaiting(db, nextLocalDay);
    const dec6 = day2.items.find((i) => i.key === "dec:6")!;
    expect(dec6).toMatchObject({ tier: "now", wake: true });
    expect(dec6.desk).toBeUndefined();
    const persisted = db.prepare("SELECT value FROM lane_pilot_owner_config WHERE key='decision_day'").get() as { value: string };
    expect(persisted.value).toBe("2026-11-25:1");
  });

  it("defers all decisions when decisionCap is 0 while still waking red items", () => {
    const db = makeDb();
    postOwnerItem(db, { key: "dec:1", source: "night", kind: "proposal", reason: "decision", what: "Решение 1", why: "почему", wake: true }, DAY1);
    postOwnerItem(db, { key: "dec:2", source: "night", kind: "proposal", reason: "decision", what: "Решение 2", why: "почему", wake: true }, DAY1 + HOUR);
    postOwnerItem(db, { key: "red:1", source: "night", kind: "canary_red", reason: "red", what: "Красное", why: "горит" }, DAY1 + HOUR);

    const logs: string[] = [];
    const waiting = collectOwnerWaiting(db, DAY1 + 2 * HOUR, [], { decisionCap: 0, log: (m) => logs.push(m) });
    expect(waiting.items.find((i) => i.key === "red:1")).toMatchObject({ tier: "now", wake: true });
    expect(waiting.items.find((i) => i.key === "dec:1")).toMatchObject({ tier: "later", wake: false, desk: true });
    expect(waiting.items.find((i) => i.key === "dec:2")).toMatchObject({ tier: "later", wake: false, desk: true });
    expect(waiting.now).toBe(1);
    expect(logs).toEqual(["attention budget decisions_today=0 cap=0 deferred=2"]);
  });
});
