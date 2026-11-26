import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase, saveProjectSetting } from "../src/rooms/plugin-db";
import { noteProtectionDisarm, rearmExpiredDisarms, renewDisarm, integrityReport } from "../src/rooms/protections";

function open() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, harness, db: openDatabase(bb) };
}

describe("rooms/protections", () => {
  it("a protection off past its term comes back as a warning", () => {
    const { db, harness } = open();
    const t0 = Date.now() - 9 * 86_400_000;
    saveProjectSetting(db as never, "p", "plan_critique.mode", "advisory");
    db.prepare(`UPDATE lane_pilot_project_settings SET value=? WHERE project_id='p' AND binding_id='' AND key='protection.disarm.plan_critique.mode'`)
      .run(JSON.stringify({ key: "plan_critique.mode", by: "owner", at: t0, until: t0 + 7 * 86_400_000 }));
    const rearmed = rearmExpiredDisarms(db as never, "p");
    expect(rearmed).toEqual(["plan_critique.mode"]);
    const value = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id='p' AND key='plan_critique.mode'`).get() as { value: string };
    expect(JSON.parse(value.value)).toBe("advisory");
    const items = db.prepare(`SELECT what FROM lane_pilot_owner_item WHERE key LIKE 'protection-rearm:%'`).all() as Array<{ what: string }>;
    expect(items.length).toBe(1);
    void harness;
  });

  it("a disarmed protection lists hazard, term and renew needs a reason", () => {
    const { db, harness } = open();
    noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner" });
    const report = integrityReport(db as never, { "code_critique.mode": "advisory" }, "p");
    const row = report.find((r) => r.key === "code_critique.mode")!;
    expect(row.disarmed).toBe(true);
    expect(row.hazard).toContain("unchecked diff");
    expect("error" in renewDisarm(db as never, "p", "code_critique.mode", 30, "")).toBe(true);
    const renewed = renewDisarm(db as never, "p", "code_critique.mode", 30, "still auditing the critic");
    expect("record" in renewed && renewed.record.renewals!.length).toBe(1);
    void harness;
  });
});
