import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { en, ru } from "../i18n";
import { VISIBLE_CATALOG } from "../src/ui-catalog";
import { DEFAULT_SILENCE_NUDGE_MIN } from "../src/server/writer-silence";
import { parseIntegrationGateSettings } from "../src/server/integration-gate";
import { bookkeepingSetting } from "../src/bookkeeping-paths";

const row = (key: string) => VISIBLE_CATALOG.find((item) => item.storageKey === key);

describe("settings that code reads and the catalog now lists", () => {
  it("has a row for each, with the default the code uses", () => {
    expect(row("writer.silence_nudge_min")).toMatchObject({ uiStatus: "editable", control: "number", min: 1, defaultValue: String(DEFAULT_SILENCE_NUDGE_MIN), section: "writer" });
    expect(row("bookkeeping.paths")).toMatchObject({ uiStatus: "editable", control: "input", defaultValue: "" });
    expect(row("integration.gate_command")).toMatchObject({ uiStatus: "editable", control: "input", defaultValue: "" });
    const gate = parseIntegrationGateSettings({});
    expect(row("integration.gate_when")).toMatchObject({ uiStatus: "editable", control: "select", options: ["queue_drained", "every_n"], defaultValue: gate.gateWhen });
    expect(row("integration.gate_every")).toMatchObject({ uiStatus: "editable", control: "number", min: 1, defaultValue: String(gate.gateEvery) });
    expect(bookkeepingSetting({ "bookkeeping.paths": row("bookkeeping.paths")!.defaultValue })).toEqual([]);
  });

  it("have a label and a reason in English and in Russian", () => {
    for (const key of ["writer.silence_nudge_min", "bookkeeping.paths", "integration.gate_command", "integration.gate_when", "integration.gate_every"]) {
      const id = row(key)!.id;
      for (const locale of [en, ru] as Array<Record<string, string>>) {
        expect(locale[`field_${id}`], `${key} field`).toBeTruthy();
        expect(locale[`reason_${id}`], `${key} reason`).toBeTruthy();
      }
      expect(en[`field_${id}` as keyof typeof en]).not.toBe(ru[`field_${id}` as keyof typeof ru]);
    }
  });

  it("are validated on save and reset to the inherited value", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const projectId = "proj_catalog_extra";
    const save = (key: string, value: unknown, expectedVersion = 0) =>
      harness.behavior.callRpc("save_setting", { projectId, key, value, expectedVersion }) as Promise<{ ok: boolean; version?: number; validation?: { code: string; key: string } }>;

    for (const [key, bad] of [["writer.silence_nudge_min", "0"], ["writer.silence_nudge_min", "soon"], ["integration.gate_every", 0], ["integration.gate_when", "never"]] as const) {
      const rejected = await save(key, bad);
      expect(rejected.ok, `${key}=${bad}`).toBe(false);
      expect(rejected.validation, `${key}=${bad}`).toMatchObject({ code: "invalid_choice", key });
    }

    const versions: Record<string, number> = {};
    for (const [key, good] of [["writer.silence_nudge_min", 30], ["bookkeeping.paths", "docs/generated/**, notes/*.tmp"], ["integration.gate_command", "npm test"], ["integration.gate_when", "every_n"], ["integration.gate_every", 3]] as const) {
      const saved = await save(key, good);
      expect(saved.ok, key).toBe(true);
      versions[key] = saved.version!;
    }

    const reset = await harness.behavior.callRpc("reset_project_settings", { projectId, keys: Object.keys(versions), expectedVersions: versions }) as { ok: boolean };
    expect(reset.ok).toBe(true);
    await harness.lifecycle.dispose();
  });
});
