import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { closeOwnerItem, collectOwnerWaiting, postOwnerItem } from "../src/rooms/owner-waiting";
import { ownerWaitingRpc, savePushConfig } from "../src/rooms/owner-waiting/server";
import { ownerWaitingOutput } from "../src/rooms/contracts/ui-query-schemas";

// 2026-11-24 11:00 Europe/Madrid (UTC+1).
const DAY1 = Date.parse("2026-11-24T10:00:00.000Z");

function makeDb() {
  return openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
}

describe("owner_waiting attention counter", () => {
  it("returns { cap: 5, shown: 0, remaining: 5, day } when config rows or table are missing", () => {
    const db = makeDb();
    const fresh = collectOwnerWaiting(db, DAY1);
    expect(fresh.attention).toEqual({ cap: 5, shown: 0, remaining: 5, day: "2026-11-24" });
    expect(ownerWaitingOutput.safeParse(fresh).success).toBe(true);

    // Even when lane_pilot_owner_config does not exist, missing config rows resolve safely without failing.
    db.exec("DROP TABLE lane_pilot_owner_config");
    const noTable = collectOwnerWaiting(db, DAY1);
    expect(noTable.attention).toEqual({ cap: 5, shown: 0, remaining: 5, day: "2026-11-24" });
  });

  it("tracks shown and remaining across the day and resets on the next owner-local day", async () => {
    const db = makeDb();
    savePushConfig(db, { timezone: "Europe/Madrid" }, DAY1);
    for (let i = 1; i <= 3; i += 1) {
      postOwnerItem(
        db,
        {
          key: `dec:${i}`,
          source: "night",
          kind: "proposal",
          reason: "decision",
          what: `Decision ${i}`,
          why: "Requires owner judgment",
          wake: true,
        },
        DAY1 + i * 1_000,
      );
    }

    const waiting = collectOwnerWaiting(db, DAY1 + 10_000);
    expect(waiting.attention).toEqual({ cap: 5, shown: 3, remaining: 2, day: "2026-11-24" });
    expect(ownerWaitingOutput.safeParse(waiting).success).toBe(true);

    // Closing items does not free today's decision budget; remaining stays 2.
    closeOwnerItem(db, "dec:1", "screen", DAY1 + 20_000);
    closeOwnerItem(db, "dec:2", "screen", DAY1 + 21_000);
    closeOwnerItem(db, "dec:3", "screen", DAY1 + 22_000);
    const sameDayAfterClose = collectOwnerWaiting(db, DAY1 + 30_000);
    expect(sameDayAfterClose.attention).toEqual({ cap: 5, shown: 3, remaining: 2, day: "2026-11-24" });

    // Lowering decision_cap below already-shown count clamps remaining to 0.
    savePushConfig(db, { decision_cap: "2" }, DAY1 + 40_000);
    const loweredCap = collectOwnerWaiting(db, DAY1 + 50_000);
    expect(loweredCap.attention).toEqual({ cap: 2, shown: 3, remaining: 0, day: "2026-11-24" });

    // Restore default cap and advance to the next local day (23:30 UTC = 00:30 Europe/Madrid on 2026-11-25).
    savePushConfig(db, { decision_cap: "5" }, DAY1 + 60_000);
    const nextLocalDay = Date.parse("2026-11-24T23:30:00.000Z");
    const day2 = collectOwnerWaiting(db, nextLocalDay);
    expect(day2.attention).toEqual({ cap: 5, shown: 0, remaining: 5, day: "2026-11-25" });

    // Public RPC handler exposes the same attention counter and passes the UI output schema.
    const rpc = ownerWaitingRpc(db);
    const viaRpc = await rpc.owner_waiting();
    expect(viaRpc.attention).toBeDefined();
    expect(ownerWaitingOutput.safeParse(viaRpc).success).toBe(true);
  });

  it("keeps ownerWaitingOutput compatible with legacy payloads without attention", () => {
    const db = makeDb();
    const { attention: _omitted, ...legacy } = collectOwnerWaiting(db, DAY1);
    expect(ownerWaitingOutput.safeParse(legacy).success).toBe(true);
  });
});
