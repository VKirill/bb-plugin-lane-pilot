import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations, openDatabase } from "../../src/database";
import { routeWorkflow } from "../../src/jev/judgments/route-workflow";
import { listJudgments } from "@lane-pilot/jev";
import { jevMigrations } from "@lane-pilot/jev";
import { jevEnabled, jevSettingProblem, resolveMode, resolveThresholds } from "@lane-pilot/jev";
import { validateSettingValue } from "../../src/rooms/settings/setting-validation";

describe("jev settings", () => {
  it("starts from the registry defaults and clamps a project's values to the allowed range", () => {
    expect(resolveThresholds(routeWorkflow, undefined).min_p).toBe(0.6);
    const set = (text: string) => resolveThresholds(routeWorkflow, { "jev.thresholds": text });
    expect(set("route.workflow.min_p=0.8").min_p).toBe(0.8);
    expect(set("route.workflow.min_p=0.1").min_p).toBe(0.6);
    expect(set("route.workflow.min_p=7").min_p).toBe(0.95);
    expect(set("route.workflow.min_p=0.7\nroute.workflow.min_margin=0.4, other.thing=1").min_margin).toBe(0.4);
    expect(set("route.workflow.min_p=abc").min_p).toBe(0.6);
    expect(set("route.workflow.nothing=1")).toEqual(resolveThresholds(routeWorkflow, undefined));
  });

  it("reads the mode per judgment, with the default of the judgment, and an off switch for the project", () => {
    expect(resolveMode(routeWorkflow, undefined)).toBe("active");
    expect(resolveMode(routeWorkflow, { "jev.modes": "route.workflow=shadow" })).toBe("shadow");
    expect(resolveMode(routeWorkflow, { "jev.modes": "route.workflow=nope" })).toBe("active");
    expect(resolveMode(routeWorkflow, { "jev.modes": "route.workflow=active", "jev.enabled": false })).toBe("off");
    expect(jevEnabled({ "jev.enabled": "false" })).toBe(false);
    expect(jevEnabled({})).toBe(true);
  });

  it("rejects a saved value with an unknown judgment or an out-of-range number", () => {
    expect(jevSettingProblem("jev.thresholds", "route.workflow.min_p=0.7", listJudgments())).toBeNull();
    expect(jevSettingProblem("jev.thresholds", "route.workflow.min_p=0.2", listJudgments())).toContain("from 0.6 to 0.95");
    expect(jevSettingProblem("jev.thresholds", "nothing.here=1", listJudgments())).toContain("unknown threshold");
    expect(jevSettingProblem("jev.modes", "route.workflow=maybe", listJudgments())).toContain("off, shadow or active");
    expect(jevSettingProblem("jev.modes", "no.such=active", listJudgments())).toContain("unknown judgment");
    expect(validateSettingValue("jev.thresholds", "route.workflow.min_p=0.99")).toMatchObject({ code: "invalid_choice", key: "jev.thresholds" });
    expect(validateSettingValue("jev.modes", "route.workflow=active")).toBeNull();
    expect(validateSettingValue("jev.thresholds", "")).toBeNull();
    expect(validateSettingValue("jev.enabled", true)).toBeNull();
  });

  it("appends the receipts migration at the end and creates the table", () => {
    for (const statement of jevMigrations) expect(migrations).toContain(statement);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const columns = (db.prepare("PRAGMA table_info(lane_pilot_jev_receipt)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(["judgment", "version", "input_sha256", "answers_json", "decision", "decided_by", "escalated_to", "latency_ms", "tokens_in", "outcome"]));
    expect(columns).not.toContain("state");
  });
});
