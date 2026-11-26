import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { UNAPPLIED_REASON, WRITER_EFFORT_CHOICES_BY_PROVIDER, type CatalogRow } from "@lane-pilot/settings-catalog";
import { SETTINGS_REGISTRY } from "../src/rooms/settings-registry";
import { buildCliInvocation, isFlagOff, isFlagOn } from "../src/rooms/writer/models/argv-builder";
import { argvValidationMap } from "../src/rooms/settings/models/setting-validation";
import { installEnv } from "../src/rooms/native-install/install-runner";
import plugin from "../server";

function representativeValues(row: CatalogRow): unknown[] {
  if (row.channel === "OWN" && row.storageKey.endsWith(".agent")) return ["lane-test-agent"];
  if (row.storageKey === "plan_critique.min_score") return [0, 10];
  if (row.storageKey === "plan_critique.min_write_tasks") return [1, 3];
  if (row.storageKey === "ops.provider_pool") return ["codex=2, claude-code=3"];
  if (row.storageKey === "jev.thresholds") return ["employee.remark.remark_p=0.7"];
  if (row.storageKey === "jev.modes") return ["employee.remark=shadow"];
  if (row.storageKey === "jev.provider") return ["openlux", "typesafe"];
  if (row.bounds.kind === "boolean" || row.storageKey.startsWith("jev.")) return [true, false];
  if (row.storageKey === "install.LANE_INSTALL_LOCAL_MARKETPLACE" || row.storageKey === "install.LANE_INSTALL_CLAUDE_PLUGIN") {
    return [true, false];
  }
  if (row.control === "select") return row.options;
  if (/^workflow\..*\.reasoning_effort$/.test(row.storageKey)) return ["low", "max"];
  if (row.storageKey === "install.CODEX_HOME") return ["/tmp/codex"];
  if (row.storageKey === "lead.tick_cron") return ["30 6,10,14,18 * * *"]; // five cron fields: the lead's validator refuses anything else
  if (row.storageKey === "install.CLAUDE_CONFIG_DIR") return ["/tmp/claude"];
  if (row.min != null) return row.max != null ? [row.min, row.max] : [row.min];
  if (row.control === "path" || row.storageKey.includes("dir") || row.storageKey.includes("cwd") || row.storageKey.includes("file")) {
    return ["/tmp/lane-pilot"];
  }
  if (row.bounds.kind === "json") return ["{}"];
  if (row.bounds.kind === "time_range") return ["23:00-08:00"];
  if (row.bounds.kind === "time_zone") return ["Europe/Madrid"];
  if (row.options.length && row.options[0] && row.options[0] !== "bool") return row.options;
  return ["1"];
}

function assertChannelValue(spec: CatalogRow, value: unknown): void {
  const label = `${spec.storageKey}=${JSON.stringify(value)}`;
  if (spec.channel === "OWN") {
    if (spec.storageKey === "ui.language" || spec.storageKey.startsWith("jev.")) return;
    const cli = buildCliInvocation({
        validate: argvValidationMap, binary: "run-controller", subcommand: "run", settings: { [spec.storageKey]: value } });
    expect(cli.applied, label).not.toContain(spec.storageKey);
    const reason = cli.unapplied.find((row) => row.key === spec.storageKey)?.reason;
    if (spec.storageKey === "adoc.040") expect(reason, label).toBe(UNAPPLIED_REASON.noConsumer);
    else expect(reason, label).toMatch(/native Lane Pilot/i);
    return;
  }
  if (spec.storageKey === "install.LANE_INSTALL_CLAUDE_PLUGIN") {
    const result = installEnv({ homeDir: "/tmp/home", confirmExternalOps: true, settings: { [spec.storageKey]: value } });
    expect(result.applied, label).not.toContain(spec.storageKey);
    expect(result.env.LANE_INSTALL_CLAUDE_PLUGIN, label).toBe("0");
    return;
  }
  if (spec.channel === "INSTALL-ENV") {
    const result = installEnv({
      homeDir: "/tmp/home",
      confirmExternalOps: true,
      settings: { [spec.storageKey]: value },
    });
    expect(result.applied, label).toContain(spec.storageKey);
    const envName = spec.storageKey.slice("install.".length);
    if (isFlagOn(value)) expect(result.env[envName], label).toBe("1");
    else if (isFlagOff(value)) expect(result.env[envName], label).toBe("0");
    else expect(result.env[envName], label).toBe(String(value));
    const cli = buildCliInvocation({
        validate: argvValidationMap, binary: "run-controller", subcommand: "run", settings: { [spec.storageKey]: value } });
    expect(cli.unapplied.some((row) => row.key === spec.storageKey), `${label} CLI`).toBe(true);
    return;
  }
  const built = buildCliInvocation({
        validate: argvValidationMap,
    binary: "run-controller",
    subcommand: "run",
    settings: { [spec.storageKey]: value },
    required: {},
  });
  expect(built.applied, label).not.toContain(spec.storageKey);
}

describe("UI storage keys feed runtime channels", () => {
  it("registers every visible and editable row in the composed settings registry", () => {
    // A floor against a registry that silently loses its rooms, not an exact count: the prune plan deleted rooms and their settings (177 left).
    expect(SETTINGS_REGISTRY.editable.length).toBeGreaterThan(170);
    expect(SETTINGS_REGISTRY.visible.every((row) => row.uiStatus === "editable" || row.uiStatus === "readonly")).toBe(true);
    for (const row of SETTINGS_REGISTRY.editable) {
      expect(SETTINGS_REGISTRY.isRegistered(row.storageKey), row.storageKey).toBe(true);
      expect(["OWN", "INSTALL-ENV", "ENV-PASSTHROUGH"].includes(row.channel), row.storageKey).toBe(true);
    }
  });

  it("rejects an invalid choice on save for every editable enum row", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const editable = SETTINGS_REGISTRY.editable;
    expect(editable.length).toBeGreaterThan(170);
    const atomicPickerKeys = new Set([
      "memory.provider", "memory.model", "memory.reasoning_effort", "memory.service_tier",
      "night_review.provider", "night_review.model", "night_review.reasoning_effort", "night_review.service_tier",
      "docs.provider", "docs.model", "docs.reasoning_effort", "docs.service_tier",
      "project_life.provider", "project_life.model", "project_life.reasoning_effort", "project_life.service_tier",
      "onboarding.provider", "onboarding.model", "onboarding.reasoning_effort", "onboarding.service_tier",
      "pm_read.provider", "pm_read.model", "pm_read.reasoning_effort", "pm_read.service_tier",
      "plan_critique.provider", "plan_critique.model", "plan_critique.reasoning_effort", "plan_critique.service_tier",
      "code_critique.provider", "code_critique.model", "code_critique.reasoning_effort", "code_critique.service_tier",
    ]);
    for (const row of editable) {
      const choices = SETTINGS_REGISTRY.visible.filter((candidate) => candidate.storageKey === row.storageKey && candidate.control === "select")
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

  it("keeps select control semantics for writer.provider", () => {
    const provider = SETTINGS_REGISTRY.get("writer.provider");
    expect(provider).toBeDefined();
    expect(provider!.uiStatus).toBe("editable");
    expect(provider!.control).toBe("select");
    expect(provider!.options.length).toBeGreaterThan(0);
  });

  it("table-drives every editable row and every representative value to argv/env or unapplied", () => {
    const editable = SETTINGS_REGISTRY.editable;
    expect(editable.length).toBeGreaterThan(170);
    for (const row of editable) {
      if (row.storageKey === "ui.language") {
        expect(row.options).toEqual(["en", "ru"]);
        continue;
      }
      if (row.channel === "NONE") throw new Error(`${row.storageKey} is editable without a consumer`);
      for (const value of representativeValues(row)) {
        assertChannelValue(row, value);
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
        validate: argvValidationMap,
          binary: "run-controller", subcommand: "run",
          settings: { "writer.provider": provider, "writer.reasoning_effort": effort },
        });
        if (allowed) {
          expect(built.applied).not.toContain("writer.reasoning_effort");
          expect(built.unapplied.find((item) => item.key === "writer.reasoning_effort")?.reason).toMatch(/native Lane Pilot/i);
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
        validate: argvValidationMap,
      binary: "run-controller",
      subcommand: "run",
      settings: { "writer.fast_mode": false },
    });
    expect(built.argv).toEqual(["run"]);
    expect(built.applied).toEqual([]);
    expect(built.unapplied).toContainEqual({
      key: "writer.fast_mode",
      value: false,
      channel: "NONE",
      reason: UNAPPLIED_REASON.legacyFastModeMigrated,
    });
    expect(built.unapplied).toContainEqual(expect.objectContaining({ key: "writer.service_tier" }));
  });

  it("AG-215: an invalid provider is unapplied and never enters argv", () => {
    const built = buildCliInvocation({
        validate: argvValidationMap,
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
        validate: argvValidationMap,
      binary: "run-controller",
      subcommand: "run",
      settings: { "adoc.005": true, "writer.provider": "codex" },
    });
    expect(built.argv).toEqual(["run"]);
    expect(built.applied).toEqual([]);
    expect(built.unapplied.map((row) => row.key).sort()).toEqual(["adoc.005", "writer.provider"]);
    expect(built.unapplied.find((row) => row.key === "adoc.005")?.reason).toMatch(/no runtime consumer/);
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
      key: "plan_critique.enabled",
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
    expect(screen.values["plan_critique.enabled"]).toBe("0");
    expect(screen.unapplied.map((row) => row.key)).toContain("adoc.005");
    expect(screen.writerResultJson).toBeNull();
    expect(screen.lastReceiptJson).toBeNull();
    expect(screen.cliReceiptJson).toBeNull();
    await harness.lifecycle.dispose();
  });
});
