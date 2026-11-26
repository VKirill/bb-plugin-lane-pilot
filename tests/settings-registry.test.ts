/** @vitest-environment jsdom */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";
import {
  GLOBAL_SETTINGS_PROJECT_ID,
  LEGACY_STORED_KEYS,
  isLegacyStoredKey,
  type SettingDefinition,
} from "@lane-pilot/settings-catalog";
import {
  ROLE_TABLE,
  SERVICE_JOBS,
  roleFallbackModel,
  roleModelKey,
  roleRow,
  roleRowOf,
  tableRowAt,
} from "@lane-pilot/models";
import plugin from "../server";
import { rooms } from "../src/rooms/registry";
import { openDatabase, saveProjectSetting, getSettingVersions } from "../src/rooms/plugin-db";
import { ROOM_SETTINGS_PARTS, SETTINGS_REGISTRY } from "../src/rooms/settings-registry";
import { readProjectSetting } from "../src/rooms/settings/server/services/read-setting";
import { warnUnknownStoredSettings } from "../src/rooms/settings/server/room";
import { validateSettingValue } from "../src/rooms/settings/models/setting-validation";

function invalidSampleFor(def: SettingDefinition): unknown | undefined {
  if (def.storageKey === "ui.language") return "fr";
  if (def.bounds.strictOptions === false && def.bounds.kind !== "int" && def.bounds.kind !== "number" && def.bounds.kind !== "boolean") {
    return undefined;
  }
  if (def.control === "number" || def.invType.includes("int") || def.invType.includes("float") || def.min !== null || def.max !== null) {
    if (def.min !== null) return def.min - 1;
    if (def.max !== null) return def.max + 1;
    return "not-a-number";
  }
  if (def.control === "switch" || def.options.join("|") === "true|false" || def.options.join("|") === "false|true") {
    return "not-a-boolean";
  }
  if (def.control === "select" && def.options.length > 0 && !def.options.includes("_probe_opencode_agents")) {
    return "__invalid_option_value__";
  }
  if (def.storageKey.endsWith(".json") || def.storageKey === "writer.models_off") return "{not-valid-json";
  if (def.storageKey === "lead.tick_cron") return "bad cron";
  if (def.control === "path") return "/tmp/../escape";
  return undefined;
}

const REGISTRY_FILE_ALLOWED = (rel: string): boolean =>
  /^src\/rooms\/[^/]+\/settings\.ts$/.test(rel) ||
  rel === "src/rooms/settings-registry.ts" ||
  rel.startsWith("packages/settings-catalog/") ||
  rel.startsWith("packages/i18n/") ||
  rel.startsWith("src/rooms/sma-map/");

function scanRawSettingLiteralsInSource(filePath: string, sourceText: string, registeredKeys: ReadonlySet<string>): string[] {
  const sf = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && registeredKeys.has(node.text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      hits.push(`${filePath}:${line} (${node.text})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function* walkTsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* walkTsFiles(abs);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield abs;
  }
}

describe("typed settings registry (Task 33)", () => {
  it("composes settings from surviving rooms without placeholder adoc.* or excluded rows", () => {
    expect(ROOM_SETTINGS_PARTS.length).toBeGreaterThanOrEqual(25);
    expect(SETTINGS_REGISTRY.all.length).toBeGreaterThanOrEqual(236);
    expect(SETTINGS_REGISTRY.all.every((def) => def.uiStatus === "editable" || def.uiStatus === "readonly" || def.uiStatus === "hidden")).toBe(true);
    expect(SETTINGS_REGISTRY.all.filter((def) => def.storageKey.startsWith("adoc.")).map((d) => d.storageKey)).toEqual(["adoc.040"]);

    // Every registered Room object that carries `settings` is reflected 1:1 in SETTINGS_REGISTRY.
    for (const room of rooms) {
      if (!room.settings) continue;
      for (const def of room.settings) {
        const got = SETTINGS_REGISTRY.get(def.storageKey);
        expect(got, `${room.name}:${def.storageKey}`).toBeDefined();
        expect(got!.room).toBe(def.room);
      }
    }
  });

  it("reads default for every live key on empty DB, logs DEBUG settings.read once per key per run, and refuses out-of-range writes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const logsRun1: string[] = [];
    const projectId = "proj_empty_reads";

    for (const def of SETTINGS_REGISTRY.all) {
      const first = readProjectSetting(db, projectId, def.storageKey, {
        runId: "run_read_once",
        debug: (m) => logsRun1.push(m),
      });
      const second = readProjectSetting(db, projectId, def.storageKey, {
        runId: "run_read_once",
        debug: (m) => logsRun1.push(m),
      });
      expect(first.source, def.storageKey).toBe("default");
      expect(first.value, def.storageKey).toEqual(def.default);
      expect(second.value, def.storageKey).toEqual(def.default);

      const bad = invalidSampleFor(def);
      if (bad !== undefined && def.uiStatus === "editable") {
        const problem = validateSettingValue(def.storageKey, bad);
        expect(problem, `${def.storageKey} refused ${JSON.stringify(bad)}`).not.toBeNull();
      }
    }

    // Logged exactly once per key per run
    expect(logsRun1).toHaveLength(SETTINGS_REGISTRY.all.length);
    expect(logsRun1.every((line) => line.startsWith("settings.read key=") && line.endsWith(" source=default"))).toBe(true);

    // Global vs project precedence + logging per source
    const targetKey = "writer.silence_nudge_min";
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, targetKey, 15);
    const logsRun2: string[] = [];
    const globalRead = readProjectSetting(db, projectId, targetKey, {
      runId: "run_source_global",
      debug: (m) => logsRun2.push(m),
    });
    expect(globalRead).toEqual({ value: 15, source: "global" });
    expect(logsRun2).toEqual([`settings.read key=${targetKey} source=global`]);

    saveProjectSetting(db, projectId, targetKey, 20);
    const logsRun3: string[] = [];
    const projectRead = readProjectSetting(db, projectId, targetKey, {
      runId: "run_source_project",
      debug: (m) => logsRun3.push(m),
    });
    expect(projectRead).toEqual({ value: 20, source: "project" });
    expect(logsRun3).toEqual([`settings.read key=${targetKey} source=project`]);

    await harness.lifecycle.dispose();
  });

  it("refuses out-of-range RPC writes and accepts in-range writes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await plugin(bb);
    const projectId = "proj_rpc_bounds";

    const outOfRange = await harness.behavior.callRpc("save_setting", {
      projectId,
      key: "writer.silence_nudge_min",
      value: 0,
      expectedVersion: 0,
    }) as { ok: boolean; validation?: { code: string; key: string } };
    expect(outOfRange.ok).toBe(false);
    expect(outOfRange.validation?.key).toBe("writer.silence_nudge_min");

    const okSave = await harness.behavior.callRpc("save_setting", {
      projectId,
      key: "writer.silence_nudge_min",
      value: 12,
      expectedVersion: getSettingVersions(db, projectId, ["writer.silence_nudge_min"])["writer.silence_nudge_min"],
    }) as { ok: boolean; version: number };
    expect(okSave.ok).toBe(true);
    expect(readProjectSetting(db, projectId, "writer.silence_nudge_min").value).toBe(12);

    await harness.lifecycle.dispose();
  });

  it("ensures every fixture DB stored key is registered or legacy, and logs WARN settings.unknown-key once at startup for deleted rooms", async () => {
    const fixtureKeys = [
      "writer.provider",
      "writer.model",
      "writer.fast_mode",
      "role_model.analyst",
      "service_model.classify",
      "writer.fallback1.model",
      "council.gpt.model",
      ...LEGACY_STORED_KEYS,
    ];
    for (const key of fixtureKeys) {
      expect(SETTINGS_REGISTRY.isRegistered(key) || isLegacyStoredKey(key), key).toBe(true);
    }

    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    saveProjectSetting(db, "proj_fixture", "writer.provider", "codex");
    saveProjectSetting(db, "proj_fixture", "writer.fast_mode", true);
    saveProjectSetting(db, "proj_fixture", "deleted_room.legacy_toggle", "on");
    saveProjectSetting(db, "proj_other", "deleted_room.legacy_toggle", "off");
    saveProjectSetting(db, "proj_other", "obsolete_subsystem.max_hops", 4);

    // Boot startup warns once per distinct unknown key across the stored rows
    const warnsAtBoot: string[] = [];
    const origWarn = bb.log.warn.bind(bb.log);
    bb.log.warn = (msg: string) => {
      warnsAtBoot.push(msg);
      origWarn(msg);
    };
    await plugin(bb);
    expect(warnsAtBoot.filter((m) => m.startsWith("settings.unknown-key"))).toEqual([
      "settings.unknown-key key=deleted_room.legacy_toggle",
      "settings.unknown-key key=obsolete_subsystem.max_hops",
    ]);

    // Subsequent runs deduplicate already-warned keys while still warning on a newly discovered key
    saveProjectSetting(db, "proj_other", "another_removed_room.enabled", "on");
    const warnedAgain: string[] = [];
    const second = warnUnknownStoredSettings(db, (message) => warnedAgain.push(message));
    expect(second).toEqual([
      "another_removed_room.enabled",
      "deleted_room.legacy_toggle",
      "obsolete_subsystem.max_hops",
    ]);
    expect(warnedAgain).toEqual(["settings.unknown-key key=another_removed_room.enabled"]);

    await harness.lifecycle.dispose();
  });

  it("covers every shipped workflow agent role and service job on the model-per-function screen and applies updates to the next step", async () => {
    // 1. tab-team renders RoleModelsPanel before PmRow
    const slot = await mountPage({
      get_role_models: () => ({ roles: [], options: [] }),
      workflow_model_catalog: () => ({ hosts: [], providers: [], runHostId: null }),
    });
    openTab(slot, "team");
    const roleModels = await slot.findByTestId("role-models");
    const pmRow = await waitFor(() => slot.getByTestId("main-agent"));
    expect(Boolean(roleModels.compareDocumentPosition(pmRow) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    slot.lifecycle.unmount();
    cleanup();

    // 2. Every concrete role referenced in workflows/*.json maps into ROLE_TABLE + roleFallbackModel
    const tableIds = new Set(ROLE_TABLE.map((row) => row.id));
    const workflowDir = join(process.cwd(), "workflows");
    const usedRoles = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (value && typeof value === "object") {
        const rec = value as Record<string, unknown>;
        if (rec.type === "agent" && typeof rec.role === "string") usedRoles.add(rec.role);
        for (const v of Object.values(rec)) walk(v);
      }
    };
    for (const file of readdirSync(workflowDir).filter((f) => f.endsWith(".json"))) {
      walk(JSON.parse(readFileSync(join(workflowDir, file), "utf8")));
    }
    expect(usedRoles.size).toBeGreaterThan(10);
    for (const wfRole of usedRoles) {
      const mapped = roleRowOf(wfRole);
      expect(tableIds.has(mapped), `${wfRole} -> ${mapped}`).toBe(true);
      const spec = roleRow(mapped);
      expect(spec.default.model).toBeTruthy();
      expect(spec.default.effort).toBeTruthy();
      const fb = roleFallbackModel(mapped);
      if (fb) {
        expect(fb.providerId).toBeTruthy();
        expect(fb.model).toBeTruthy();
      }
    }

    // 3. get_role_models lists every role + saving role_model.<role> updates next resolution immediately
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await plugin(bb);
    const projectId = "proj_model_next_step";
    const key = roleModelKey("planner");
    const before = await harness.behavior.callRpc("get_role_models", { projectId }) as {
      roles: Array<{ role: string; providerId: string; model: string; source: string }>;
    };
    expect(before.roles.map((r) => r.role)).toEqual(ROLE_TABLE.map((r) => r.id));

    const save = await harness.behavior.callRpc("save_setting", {
      projectId,
      key,
      value: { model: "gpt-6.1-terra", reasoning_effort: "high" },
      expectedVersion: getSettingVersions(db, projectId, [key])[key],
    }) as { ok: boolean };
    expect(save.ok).toBe(true);

    const after = await harness.behavior.callRpc("get_role_models", { projectId }) as {
      roles: Array<{ role: string; providerId: string; model: string; effort: string; source: string }>;
    };
    expect(after.roles.find((r) => r.role === "planner")).toMatchObject({
      providerId: "codex",
      model: "gpt-6.1-terra",
      effort: "high",
      source: "table",
    });
    expect(tableRowAt({ [key]: { model: "gpt-6.1-terra", reasoning_effort: "high" } }, "planner")).toMatchObject({
      option: { id: "gpt-6.1-terra", providerId: "codex" },
      effort: "high",
    });
    expect(SERVICE_JOBS.some((job) => job.id === "classify" && job.role === "triager")).toBe(true);

    await harness.lifecycle.dispose();
  });

  it("fails on a string literal equal to a registered key outside the registry", () => {
    const regKeys = new Set(SETTINGS_REGISTRY.all.map((def) => def.storageKey));

    // Guard unit check: catches an arbitrary non-registry file using a registered key string literal
    const violation = scanRawSettingLiteralsInSource(
      "src/rooms/example/server/bad.ts",
      `export function readBad(s: Record<string, unknown>) { return s["writer.silence_nudge_min"]; }\n`,
      regKeys,
    );
    expect(violation).toEqual([`src/rooms/example/server/bad.ts:1 (writer.silence_nudge_min)`]);

    // Guard against new raw literals introduced in src/ or packages/ outside registry & frozen baseline
    const baseline = JSON.parse(
      readFileSync(join(process.cwd(), "tests/settings-literals-baseline.json"), "utf8"),
    ) as Record<string, number>;

    const regressions: string[] = [];
    for (const root of ["src", "packages"]) {
      for (const abs of walkTsFiles(join(process.cwd(), root))) {
        const rel = relative(process.cwd(), abs).replaceAll("\\", "/");
        if (REGISTRY_FILE_ALLOWED(rel)) continue;
        const hits = scanRawSettingLiteralsInSource(rel, readFileSync(abs, "utf8"), regKeys);
        const allowed = baseline[rel] ?? 0;
        if (hits.length > allowed) {
          regressions.push(`${rel}: ${hits.length} > baseline ${allowed} (${hits[0]})`);
        }
      }
    }
    expect(regressions).toEqual([]);
  });
});
