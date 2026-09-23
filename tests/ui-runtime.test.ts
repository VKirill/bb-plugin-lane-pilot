import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { SETTING_CATALOG, CONSUMER_KEYS, specFor, type SettingSpec } from "../src/channels";
import { UI_CATALOG } from "../src/ui-catalog";
import { buildCliInvocation } from "../src/argv-builder";
import { requiredCliFlags } from "../src/cli-flags";
import { installEnv } from "../src/install-runner";
import plugin from "../server";

function requiredFor(spec: SettingSpec): { binary: "run-controller" | "lane-ctl"; subcommand: string; required: Record<string, string> } {
  const binary = spec.binaries?.[0] ?? "run-controller";
  const subcommand = spec.subcommands?.[0] ?? "run";
  return {
    binary,
    subcommand,
    required: requiredCliFlags({
      binary,
      subcommand,
      runDir: "/tmp/run",
      projectCwd: "/tmp/proj",
      taskFile: "/tmp/run/tasks/001.yaml",
      taskId: "001",
    }),
  };
}

describe("UI storage keys feed runtime channels", () => {
  it("intersects SETTING_CATALOG with generated storageKey values", () => {
    const stored = new Set(UI_CATALOG.map((row) => row.storageKey));
    const catalog = SETTING_CATALOG.map((spec) => spec.key);
    expect(catalog.filter((key) => stored.has(key))).toEqual(catalog);
  });

  it("gives every editable row a consumer key", () => {
    const missing = UI_CATALOG.filter((row) => row.uiStatus === "editable" && !CONSUMER_KEYS.has(row.storageKey) && row.storageKey !== "ui.language");
    expect(missing.map((row) => `${row.id}:${row.storageKey}`)).toEqual([]);
  });

  it("applies every editable runtime key via argv-builder or installEnv", () => {
    const editable = UI_CATALOG.filter((row) => row.uiStatus === "editable");
    for (const row of editable) {
      if (row.storageKey === "ui.language") continue;
      const spec = specFor(row.storageKey);
      expect(spec, row.storageKey).toBeTruthy();
      if (!spec || spec.channel === "NONE") throw new Error(`${row.storageKey} is editable without a consumer`);
      if (spec.channel === "INSTALL-ENV") {
        const result = installEnv({
          homeDir: "/tmp/home",
          confirmExternalOps: true,
          settings: { [spec.key]: spec.env === "CODEX_HOME" ? "/tmp/codex" : "1" },
        });
        expect(result.applied).toContain(spec.key);
        expect(result.env[spec.env ?? ""]).toBeTruthy();
        continue;
      }
      const target = requiredFor(spec);
      const built = buildCliInvocation({
        binary: target.binary,
        subcommand: target.subcommand,
        settings: { [spec.key]: spec.booleanFlag ? true : "1" },
        required: target.required,
      });
      expect(built.applied, `${spec.key} on ${target.binary} ${target.subcommand}`).toContain(spec.key);
    }
  });

  it("reports stored adoc keys without a consumer as unapplied", () => {
    const built = buildCliInvocation({
      binary: "run-controller",
      subcommand: "run",
      settings: { "adoc.005": true, "writer.provider": "codex" },
    });
    expect(built.argv).toEqual(["run", "--provider", "codex"]);
    expect(built.applied).toEqual(["writer.provider"]);
    expect(built.unapplied.map((row) => row.key)).toEqual(["adoc.005"]);
    expect(built.unapplied[0]?.reason).toMatch(/no runtime consumer/);
  });

  it("saves writer.provider and jev keys that get_screen returns", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const provider = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_runtime",
      key: "writer.provider",
      value: "opencode",
      expectedVersion: 0,
    }) as { ok: boolean };
    expect(provider.ok).toBe(true);
    const jev = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_runtime",
      key: "jev.LANE_JEV_EFFORT",
      value: "0",
      expectedVersion: 0,
    }) as { ok: boolean };
    expect(jev.ok).toBe(true);
    const orphan = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_runtime",
      key: "adoc.005",
      value: true,
      expectedVersion: 0,
    }) as { ok: boolean };
    expect(orphan.ok).toBe(true);
    const screen = await harness.behavior.callRpc("get_screen", { projectId: "proj_runtime" }) as {
      values: Record<string, unknown>;
      unapplied: Array<{ key: string; reason: string }>;
      writerResultJson: string | null;
      lastReceiptJson: string | null;
      cliReceiptJson: string | null;
    };
    expect(screen.values["writer.provider"]).toBe("opencode");
    expect(screen.values["jev.LANE_JEV_EFFORT"]).toBe("0");
    expect(screen.unapplied.map((row) => row.key)).toContain("adoc.005");
    expect(screen.writerResultJson).toBeNull();
    expect(screen.lastReceiptJson).toBeNull();
    expect(screen.cliReceiptJson).toBeNull();
    await harness.lifecycle.dispose();
  });
});
