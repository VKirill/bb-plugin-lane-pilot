import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { configuredSetting } from "../src/rooms/core/server";
import { failureIntervention } from "../src/rooms/runs";
import { loadProjectSettings, openDatabase, saveProjectSetting } from "../src/rooms/storage/database";

const PROJECT = "P";

/** A setting saved on the screen reaches the next read of the same loader the loops call — no restart, no snapshot. */
describe("wave17 catalog rows read live", () => {
  it("failure.interventions=off turns the same-class streak back into the uniform retry", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const interventionOf = () => {
      const settings = loadProjectSettings(db, PROJECT);
      return configuredSetting(settings, "failure.interventions") === "off" ? "same_retry_remark" : failureIntervention("task", 2);
    };
    expect(interventionOf()).toBe("narrow_brief");
    saveProjectSetting(db, PROJECT, "failure.interventions", "off");
    expect(interventionOf()).toBe("same_retry_remark");
    saveProjectSetting(db, PROJECT, "failure.interventions", "on");
    expect(interventionOf()).toBe("narrow_brief");
  });

  it("writer.retry_escalate flips the first red check's escalation live", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(loadProjectSettings(db, PROJECT)["writer.retry_escalate"] === true).toBe(false);
    saveProjectSetting(db, PROJECT, "writer.retry_escalate", true);
    expect(loadProjectSettings(db, PROJECT)["writer.retry_escalate"] === true).toBe(true);
  });

  it("memory.maintain_mode flips the maintainer cadence live", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const modeOf = () => (configuredSetting(loadProjectSettings(db, PROJECT), "memory.maintain_mode") === "task" ? "task" : "wave");
    expect(modeOf()).toBe("wave");
    saveProjectSetting(db, PROJECT, "memory.maintain_mode", "task");
    expect(modeOf()).toBe("task");
  });
});
