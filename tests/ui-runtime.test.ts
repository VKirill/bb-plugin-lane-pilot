import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { SETTING_CATALOG, CONSUMER_KEYS, specFor, UNAPPLIED_REASON, type SettingSpec } from "../src/channels";
import { UI_CATALOG, WRITER_EFFORT_CHOICES_BY_PROVIDER, type CatalogRow } from "../src/ui-catalog";
import { buildCliInvocation, isFlagOff, isFlagOn } from "../src/argv-builder";
import { requiredCliFlags } from "../src/cli-flags";
import { installEnv } from "../src/install-runner";
import plugin from "../server";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function representativeValues(row: CatalogRow, spec: SettingSpec): unknown[] {
  if (spec.channel === "OWN" && spec.key.endsWith(".agent")) return ["lane-test-agent"];
  if (spec.key === "plan_critique.min_score") return [0, 10];
  if (spec.key === "plan_critique.min_write_tasks") return [1, 3];
  if (spec.booleanFlag || spec.key.startsWith("jev.")) return [true, false];
  if (spec.key === "install.LANE_INSTALL_LOCAL_MARKETPLACE" || spec.key === "install.LANE_INSTALL_CLAUDE_PLUGIN") {
    return [true, false];
  }
  if (row.control === "select") return row.options;
  if (spec.key === "install.CODEX_HOME") return ["/tmp/codex"];
  if (spec.key === "install.CLAUDE_CONFIG_DIR") return ["/tmp/claude"];
  const catalogRow = UI_CATALOG.find((item) => item.storageKey === spec.key && item.uiStatus === "editable");
  if (catalogRow?.min != null && catalogRow.max != null) return [catalogRow.min, catalogRow.max];
  if (catalogRow?.control === "path" || spec.key.includes("dir") || spec.key.includes("cwd") || spec.key.includes("file")) {
    return ["/tmp/lane-pilot"];
  }
  if (row?.options.length && row.options[0] && row.options[0] !== "bool") return row.options;
  return ["1"];
}

function assertChannelValue(spec: SettingSpec, value: unknown): void {
  const label = `${spec.key}=${JSON.stringify(value)}`;
  if (spec.channel === "OWN") {
    const cli = buildCliInvocation({ binary: "run-controller", subcommand: "run", settings: { [spec.key]: value } });
    expect(cli.applied, label).not.toContain(spec.key);
    expect(cli.unapplied.find((row) => row.key === spec.key)?.reason, label).toMatch(/native Lane Pilot/i);
    return;
  }
  if (spec.channel === "INSTALL-ENV") {
    const result = installEnv({
      homeDir: "/tmp/home",
      confirmExternalOps: true,
      settings: { [spec.key]: value },
    });
    expect(result.applied, label).toContain(spec.key);
    const envName = spec.env ?? "";
    if (isFlagOn(value)) expect(result.env[envName], label).toBe("1");
    else if (isFlagOff(value)) expect(result.env[envName], label).toBe("0");
    else expect(result.env[envName], label).toBe(String(value));
    const cli = buildCliInvocation({ binary: "run-controller", subcommand: "run", settings: { [spec.key]: value } });
    expect(cli.unapplied.some((row) => row.key === spec.key), `${label} CLI`).toBe(true);
    return;
  }
  const target = requiredFor(spec);
  const built = buildCliInvocation({
    binary: target.binary,
    subcommand: target.subcommand,
    settings: { [spec.key]: value },
    required: target.required,
  });
  if (spec.booleanFlag && isFlagOff(value) && !spec.offFlag) {
    expect(built.applied, label).not.toContain(spec.key);
    expect(built.argv, label).not.toContain(spec.flag);
    const row = built.unapplied.find((item) => item.key === spec.key);
    expect(row?.reason, label).toBe(UNAPPLIED_REASON.booleanOffUnsupported);
    return;
  }
  if (spec.channel === "ENV-PASSTHROUGH" && spec.env) {
    expect(built.applied, label).toContain(spec.key);
    if (isFlagOn(value)) expect(built.env[spec.env], label).toBe("1");
    else if (isFlagOff(value)) expect(built.env[spec.env], label).toBe("0");
    else expect(built.env[spec.env], label).toBe(String(value));
    return;
  }
  expect(built.applied, label).toContain(spec.key);
  expect(built.argv, label).toContain(spec.flag);
  if (!spec.booleanFlag) expect(built.argv, label).toContain(String(value));
}

function requiredFor(spec: SettingSpec): { binary: "run-controller" | "lane-ctl"; subcommand: string; required: Record<string, string> } {
  const binary = spec.binaries?.[0] ?? "run-controller";
  const subcommand = spec.subcommands?.[0] ?? "run";
  const required = requiredCliFlags({
    binary,
    subcommand,
    runDir: "/tmp/run",
    projectCwd: "/tmp/proj",
    taskFile: "/tmp/run/tasks/001.yaml",
    taskId: "001",
  });
  if (spec.flag) delete required[spec.flag];
  return { binary, subcommand, required };
}

describe("UI storage keys feed runtime channels", () => {
  it("derives every editable enum from pinned upstream argparse choices", () => {
    const script = resolve(process.cwd(), "scripts/generate-ui-catalog.py");
    const result = execFileSync("python3", [script, "--check-upstream-enums"], { encoding: "utf8" });
    expect(result).toMatch(/editable_enum_rows=\d+; provider_choices=7; effort_choices=5; provider_effort_pairs=7/);
  });
  it("intersects SETTING_CATALOG with generated storageKey values", () => {
    const stored = new Set(UI_CATALOG.map((row) => row.storageKey));
    const catalog = SETTING_CATALOG.map((spec) => spec.key);
    expect(catalog.filter((key) => stored.has(key))).toEqual(catalog);
  });

  it("gives every editable row a consumer key", () => {
    const missing = UI_CATALOG.filter((row) => row.uiStatus === "editable" && !CONSUMER_KEYS.has(row.storageKey)
      && !SETTING_CATALOG.some((spec) => spec.key === row.storageKey && spec.channel === "OWN") && row.storageKey !== "ui.language");
    expect(missing.map((row) => `${row.id}:${row.storageKey}`)).toEqual([]);
  });

  it("rejects an invalid choice on save for every editable enum row", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const editable = UI_CATALOG.filter((row) => row.uiStatus === "editable");
    expect(editable).toHaveLength(160);
    const atomicPickerKeys = new Set([
      "memory.provider", "memory.model", "memory.reasoning_effort", "memory.service_tier",
      "night_review.provider", "night_review.model", "night_review.reasoning_effort", "night_review.service_tier",
      "docs.provider", "docs.model", "docs.reasoning_effort", "docs.service_tier",
      "onboarding.provider", "onboarding.model", "onboarding.reasoning_effort", "onboarding.service_tier",
      "pm_read.provider", "pm_read.model", "pm_read.reasoning_effort", "pm_read.service_tier",
      "plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier",
      "code_critique.provider", "code_critique.model", "code_critique.reasoning_effort", "code_critique.service_tier",
    ]);
    for (const row of editable) {
      const choices = UI_CATALOG.filter((candidate) => candidate.storageKey === row.storageKey && candidate.control === "select")
        .flatMap((candidate) => candidate.options);
      if (choices.includes("_probe_opencode_agents")) continue;
      if (!choices.length) continue;
      const result = await harness.behavior.callRpc("save_setting", {
        projectId: `invalid_${row.id}`,
        key: row.storageKey,
        value: "not-an-upstream-choice",
        expectedVersion: 0,
      }) as { ok: boolean; conflict: boolean; validation?: { code: string; params: string[] } };
      expect(result.ok, row.id).toBe(false);
      expect(result.conflict, row.id).toBe(false);
      if (atomicPickerKeys.has(row.storageKey)) {
        expect(result.validation?.code, row.id).toBe("incompatible_setting");
        expect(result.validation?.params[1], row.id).toContain("atomic");
      } else {
        expect(result.validation?.code, row.id).toBe("invalid_choice");
      }
      expect(result.validation?.params[0], row.id).toBeTruthy();
    }
    await harness.lifecycle.dispose();
  });

  it("keeps one control semantic for rows sharing a storage key", () => {
    const providerRows = UI_CATALOG.filter((row) => row.storageKey === "writer.provider" && row.uiStatus === "editable");
    expect(providerRows.length).toBeGreaterThan(1);
    expect(new Set(providerRows.map((row) => row.control))).toEqual(new Set(["select"]));
    expect(providerRows.every((row) => row.options.length > 0)).toBe(true);
  });

  it("table-drives every editable row and every representative value to argv/env or unapplied", () => {
    const booleanFlags = SETTING_CATALOG.filter((spec) => spec.booleanFlag);
    expect(booleanFlags.map((spec) => spec.key)).toEqual([]);
    const editable = UI_CATALOG.filter((row) => row.uiStatus === "editable");
    expect(editable).toHaveLength(160);
    expect(new Set(editable.map((row) => row.storageKey)).size).toBeLessThan(editable.length);
    for (const row of editable) {
      if (row.storageKey === "ui.language") {
        expect(row.options).toEqual(["en", "ru"]);
        continue;
      }
      const spec = specFor(row.storageKey);
      expect(spec, row.storageKey).toBeTruthy();
      if (!spec || spec.channel === "NONE") throw new Error(`${row.storageKey} is editable without a consumer`);
      for (const value of representativeValues(row, spec)) {
        assertChannelValue(spec, value);
      }
    }
  });

  it("validates every upstream provider-effort pair at save and dispatch boundaries", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const providers = Object.keys(WRITER_EFFORT_CHOICES_BY_PROVIDER);
    const efforts = [...new Set(Object.values(WRITER_EFFORT_CHOICES_BY_PROVIDER).flat())];
    let checked = 0;
    for (const provider of providers) {
      for (const effort of efforts) {
        const projectId = `pair_${provider}_${effort}`;
        const providerSave = await harness.behavior.callRpc("save_setting", {
          projectId, key: "writer.provider", value: provider, expectedVersion: 0,
        }) as { ok: boolean };
        expect(providerSave.ok, `${provider}/${effort} provider`).toBe(true);
        const save = await harness.behavior.callRpc("save_setting", {
          projectId, key: "writer.reasoning_effort", value: effort, expectedVersion: 0,
        }) as { ok: boolean; conflict: boolean; validation?: { code: string; key: string; params: string[] } };
        const allowed = WRITER_EFFORT_CHOICES_BY_PROVIDER[provider]!.includes(effort);
        expect(save.ok, `${provider}/${effort} save`).toBe(allowed);
        if (!allowed) {
          expect(save.conflict, `${provider}/${effort} is validation, not CAS`).toBe(false);
          expect(save.validation).toEqual({
            code: "incompatible_setting",
            key: "writer.reasoning_effort",
            params: ["writer.reasoning_effort", "writer.provider", provider, WRITER_EFFORT_CHOICES_BY_PROVIDER[provider]!.join(", ")],
          });
        }
        const built = buildCliInvocation({
          binary: "run-controller", subcommand: "run",
          settings: { "writer.provider": provider, "writer.reasoning_effort": effort },
        });
        if (allowed) {
          expect(built.applied).toContain("writer.reasoning_effort");
          expect(built.unapplied.some((item) => item.key === "writer.reasoning_effort")).toBe(false);
        } else {
          expect(built.applied).not.toContain("writer.reasoning_effort");
          expect(built.argv).not.toContain(effort);
          expect(built.unapplied).toContainEqual(expect.objectContaining({
            key: "writer.reasoning_effort",
            reason: expect.stringContaining(`writer.provider=${provider}`),
          }));
        }
        checked += 1;
      }
    }
    expect(checked).toBe(providers.length * efforts.length);
    await harness.lifecycle.dispose();
  });

  it("migrates writer.fast_mode=false to standard service tier and keeps the legacy key diagnostic", () => {
    const built = buildCliInvocation({
      binary: "run-controller",
      subcommand: "run",
      settings: { "writer.fast_mode": false },
    });
    expect(built.argv).toEqual(["run", "--service-tier", "standard"]);
    expect(built.applied).toEqual(["writer.service_tier"]);
    expect(built.unapplied).toEqual([{
      key: "writer.fast_mode",
      value: false,
      channel: "NONE",
      reason: UNAPPLIED_REASON.legacyFastModeMigrated,
    }]);
  });

  it("AG-215: an invalid provider is unapplied and never enters argv", () => {
    const built = buildCliInvocation({
      binary: "run-controller",
      subcommand: "run",
      settings: { "writer.provider": "not-a-provider" },
    });
    expect(built.argv).toEqual(["run"]);
    expect(built.applied).not.toContain("writer.provider");
    expect(built.unapplied).toEqual([{
      key: "writer.provider",
      value: "not-a-provider",
      channel: "NONE",
      reason: expect.stringMatching(/invalid value; allowed: agy, grok, qwen, kimi, codex, cursor, opencode/),
    }]);
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
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk:{ projects:{ get:async ({ projectId }) => ({ id:projectId, name:projectId, sources:[] }), list:async () => [] } },
    });
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
