import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { en, ru } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID, VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import plugin from "../../server";
import { BASELINE_DEFAULTS, REGRESS_DEFAULTS } from "../../src/rooms/baseline/logic";
import { DEFAULT_BUDGET_HOURS, DEFAULT_BUDGET_TOKENS } from "../../src/rooms/bench/runner";
import { createBench } from "../../src/rooms/bench/service";
import { createCore } from "../../src/rooms/core/server/core";
import { HARNESS_DEFAULTS, createHarness } from "../../src/rooms/harness/server/harness";
import { HUB_SPECS, PROJECT_DEFAULT_KEYS, hubFields, readHubRows, writeHubFields, writeHubSettings } from "../../src/rooms/improvement";
import { nextNightRun } from "../../src/rooms/improvement/server";
import { DEFAULT_PUSH_CONFIG, loadPushConfig, savePushConfig } from "../../src/rooms/owner-waiting/push";
import { casUpsertSetting, openDatabase } from "../../src/rooms/storage/database";
import { WALL_CONFIG_KEY, WALL_DEFAULTS } from "../../src/rooms/wall/config";
import { createWall } from "../../src/rooms/wall/service";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

function fresh() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  dispose = () => harness.lifecycle.dispose();
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } };
  return { bb, db, store, kv, wall: createWall({ db, kv: kv as never, ports: {} as never, log: () => undefined }) };
}

describe("the self-improvement settings: one catalog row for each control", () => {
  const rows = new Map(VISIBLE_CATALOG.map((row) => [row.storageKey, row]));
  const keys = [...HUB_SPECS.map((spec) => spec.key), ...PROJECT_DEFAULT_KEYS];

  it("every control is an editable row of the catalog with a label and a help in both languages", () => {
    for (const key of keys) {
      const row = rows.get(key);
      expect(row, key).toBeDefined();
      expect(row).toMatchObject({ uiStatus: "editable", channel: "OWN", section: "improvement" });
      for (const locale of [en, ru] as Array<Record<string, string>>) {
        expect(locale[`field_${row!.id}`], `${key} label`).toBeTruthy();
        expect(locale[`reason_${row!.id}`], `${key} help`).toBeTruthy();
      }
      expect(en[`field_${row!.id}` as keyof typeof en]).not.toBe(ru[`field_${row!.id}` as keyof typeof ru]);
      // The help says the default, and the default is the one the code uses (checked below).
      expect(ru[`reason_${row!.id}` as keyof typeof ru], `${key} says its default`).toMatch(/По умолчанию|по умолчанию/);
    }
  });

  it("the default of each row is the default the code uses", () => {
    const wall = Object.fromEntries(HUB_SPECS.filter((spec) => spec.area === "wall").map((spec) => [spec.field, spec.divisor ? Number(rows.get(spec.key)!.defaultValue) / spec.divisor : rows.get(spec.key)!.defaultValue]));
    for (const spec of HUB_SPECS.filter((item) => item.area === "wall")) {
      const stored = rows.get(spec.key)!.defaultValue;
      const expected = (WALL_DEFAULTS as Record<string, unknown>)[spec.field];
      expect(spec.kind === "int" ? Number(stored) / (spec.divisor ?? 1) : spec.kind === "bool" ? stored === "true" : stored, spec.key).toBe(expected);
    }
    expect(wall).toBeTruthy();
    expect(rows.get("bench.budget_tokens")!.defaultValue).toBe(String(DEFAULT_BUDGET_TOKENS));
    expect(rows.get("bench.budget_hours")!.defaultValue).toBe(String(DEFAULT_BUDGET_HOURS));
    expect(rows.get("harness.adopt_by")!.defaultValue).toBe(HARNESS_DEFAULTS.adoptBy);
    expect(rows.get("owner_push.enabled")!.defaultValue).toBe(String(DEFAULT_PUSH_CONFIG.enabled));
    expect(rows.get("owner_push.quiet")!.defaultValue).toBe(DEFAULT_PUSH_CONFIG.quiet);
    expect(rows.get("owner_push.timezone")!.defaultValue).toBe(DEFAULT_PUSH_CONFIG.timezone);
    expect(rows.get("baseline.already_built")!.defaultValue).toBe(BASELINE_DEFAULTS.mode);
    expect(rows.get("baseline.time_cap_sec")!.defaultValue).toBe(String(BASELINE_DEFAULTS.timeCapSec));
    expect(rows.get("regress.nightly")!.defaultValue).toBe(String(REGRESS_DEFAULTS.nightly));
    expect(rows.get("regress.last_n")!.defaultValue).toBe(String(REGRESS_DEFAULTS.lastN));
    expect(rows.get("regress.last_days")!.defaultValue).toBe(String(REGRESS_DEFAULTS.days));
    expect(rows.get("regress.check_cap_sec")!.defaultValue).toBe(String(REGRESS_DEFAULTS.checkCapSec));
    expect(rows.get("regress.budget_sec")!.defaultValue).toBe(String(REGRESS_DEFAULTS.budgetSec));
    expect(rows.get("regress.bisect_steps")!.defaultValue).toBe(String(REGRESS_DEFAULTS.bisectSteps));
  });

  it("the numeric limits of a row are the limits the setting is validated with", () => {
    for (const spec of HUB_SPECS.filter((item) => item.kind === "int")) {
      expect(rows.get(spec.key)!.min, spec.key).toBe(spec.min);
      expect(rows.get(spec.key)!.max, spec.key).toBe(spec.max);
    }
  });
});

describe("the night loop: a row over the old key-value record", () => {
  it("a field with no row reads the old record; the CLI and the screen write rows and leave the record alone", async () => {
    const { db, store, wall } = fresh();
    store.set(WALL_CONFIG_KEY, { hunters: 4, nightTokenCap: 5_000_000 });
    expect(await wall.config()).toMatchObject({ hunters: 4, nightTokenCap: 5_000_000, walks: 2 });

    expect(await wall.setConfig({ walks: 3 })).toMatchObject({ hunters: 4, nightTokenCap: 5_000_000, walks: 3 });
    expect([...readHubRows(db).keys()]).toEqual(["wall.walks"]);
    expect(store.get(WALL_CONFIG_KEY)).toEqual({ hunters: 4, nightTokenCap: 5_000_000 });

    // The screen's save (save_setting on the global level) is read by the loop at once, and wins over the record.
    expect(casUpsertSetting(db, { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "wall.hunters", value: 2, expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await wall.config()).toMatchObject({ hunters: 2, nightTokenCap: 5_000_000, walks: 3 });
  });

  it("keeps the clamping of the CLI: a value over the limit is stored as the limit", async () => {
    const { wall } = fresh();
    expect(await wall.setConfig({ maxClassesPerNight: 9, huntShare: 0.4 })).toMatchObject({ maxClassesPerNight: 3, huntShare: 0.4 });
    expect(await wall.config()).toMatchObject({ maxClassesPerNight: 3, huntShare: 0.4 });
  });

  it("the percent row and the share are the same number", async () => {
    const { db, wall } = fresh();
    writeHubSettings(db, [["wall.hunt_share_percent", 30]]);
    expect((await wall.config()).huntShare).toBe(0.3);
  });
});

describe("the bench caps", () => {
  it("read the row, then the old record, then the default; configure writes the row", async () => {
    const { db, kv, store } = fresh();
    const bench = createBench({ db, kv: kv as never, host: {} as never, pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
    expect(await bench.settings()).toEqual({ budgetTokens: DEFAULT_BUDGET_TOKENS, budgetHours: DEFAULT_BUDGET_HOURS });
    store.set("bench:config", { budgetTokens: 9_000_000, budgetHours: 2 });
    expect(await bench.settings()).toEqual({ budgetTokens: 9_000_000, budgetHours: 2 });
    expect(await bench.configure({ budgetHours: 5 })).toEqual({ budgetTokens: 9_000_000, budgetHours: 5 });
    expect(hubFields(db, "bench")).toEqual({ budgetHours: 5 });
    await expect(bench.configure({ budgetHours: -1 })).rejects.toThrow(/positive/);
  });
});

describe("the owner push", () => {
  it("a row wins over the old table; the command writes rows and still refuses a wrong value", () => {
    const { db } = fresh();
    db.prepare("INSERT INTO lane_pilot_owner_config(key,value,updated_at) VALUES ('enabled','off',1),('quiet','22:00-07:00',1)").run();
    expect(loadPushConfig(db)).toEqual({ enabled: false, quiet: "22:00-07:00", timezone: "Europe/Madrid" });
    expect(savePushConfig(db, { enabled: "on" })).toEqual({ enabled: true, quiet: "22:00-07:00", timezone: "Europe/Madrid" });
    expect(hubFields(db, "owner_push")).toEqual({ enabled: true });
    expect(() => savePushConfig(db, { quiet: "25:00-08:00" })).toThrow(/HH:MM-HH:MM/);
    expect(() => savePushConfig(db, { timezone: "Mars/Base" })).toThrow(/unknown time zone/);
  });
});

describe("harness.adopt_by", () => {
  it("is the default of every project; a project's own record wins; setting another field does not freeze it", async () => {
    const { bb, db } = fresh();
    const harness = createHarness(createCore(bb, db), {} as never);
    expect((await harness.config("proj")).adoptBy).toBe("bench");
    writeHubSettings(db, [["harness.adopt_by", "live"]]);
    expect((await harness.config("proj")).adoptBy).toBe("live");
    await harness.setConfig("proj", { minAttempts: 7 });
    expect((await bb.storage.kv.get("harness:config:proj")) as Record<string, unknown>).not.toHaveProperty("adoptBy");
    writeHubSettings(db, [["harness.adopt_by", "bench"]]);
    expect((await harness.config("proj")).adoptBy).toBe("bench");
    await harness.setConfig("proj", { adoptBy: "live" });
    writeHubSettings(db, [["harness.adopt_by", "bench"]]);
    expect((await harness.config("proj")).adoptBy).toBe("live");
  });
});

describe("hub rows", () => {
  it("a write moves the setting's version, so the screen's next save sees the CLI's change as a conflict", () => {
    const { db } = fresh();
    writeHubFields(db, "wall", { hunters: 4 });
    expect(readHubRows(db).get("wall.hunters")).toEqual({ value: 4, version: 1 });
    writeHubFields(db, "wall", { hunters: 4 });
    expect(readHubRows(db).get("wall.hunters")!.version).toBe(1);
    writeHubFields(db, "wall", { hunters: 5 });
    expect(readHubRows(db).get("wall.hunters")!.version).toBe(2);
    expect(casUpsertSetting(db, { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "wall.hunters", value: 3, expectedVersion: 1 })).toMatchObject({ ok: false, conflict: true, version: 2 });
  });

  it("refuses what is not a self-improvement setting and what is out of range", () => {
    const { db } = fresh();
    expect(() => writeHubSettings(db, [["writer.model", "x"]])).toThrow(/not a self-improvement setting/);
    expect(() => writeHubSettings(db, [["wall.hunters", 9]])).toThrow(/allowed: 1-5/);
    expect(() => writeHubSettings(db, [["wall.hunters", ""]])).toThrow();
  });
});

describe("save_setting on the global level", () => {
  it("validates the new keys the way the readers read them", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const save = (key: string, value: unknown, expectedVersion = 0) =>
      harness.behavior.callRpc("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key, value, expectedVersion }) as Promise<{ ok: boolean; conflict: boolean; version: number; validation?: { code: string; key: string; params: string[] } }>;
    for (const [key, bad] of [["wall.hunters", 9], ["wall.hunters", "many"], ["wall.hunt_share_percent", 0], ["wall.hunter_reasoning_effort", "extreme"], ["owner_push.quiet", "25:00-08:00"],
      ["owner_push.timezone", "Mars/Base"], ["baseline.time_cap_sec", 5], ["baseline.already_built", "maybe"], ["regress.bisect_steps", 15], ["bench.budget_hours", 0], ["harness.adopt_by", "never"], ["memory.note_budget", 0]] as const) {
      const rejected = await save(key, bad);
      expect(rejected, `${key}=${String(bad)}`).toMatchObject({ ok: false, conflict: false, validation: { code: "invalid_choice", key } });
    }
    expect(await save("baseline.time_cap_sec", 0)).toMatchObject({ ok: true });
    expect(await save("owner_push.quiet", "00:00-00:00")).toMatchObject({ ok: true });
    expect(await save("wall.hunters", 4)).toMatchObject({ ok: true, version: 1 });
    expect(await save("wall.hunters", 5, 0)).toMatchObject({ ok: false, conflict: true, version: 1 });
  });

  it("improvement_view shows the effective values, the versions and the status strip", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    await bb.storage.kv.set(WALL_CONFIG_KEY, { hunters: 4 } as never);
    await harness.behavior.callRpc("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "baseline.already_built", value: "stop", expectedVersion: 0 });
    const view = await harness.behavior.callRpc("improvement_view", {}) as {
      values: Record<string, unknown>; versions: Record<string, number>;
      status: { night: { enabled: boolean; hour: number; nextRunAt: number | null }; bench: unknown; policy: { needed: number; unseen: number; version: number }; waiting: { total: number } };
      policy: { tiers: Array<{ tier: string; entries: Array<{ id: string }> }>; prohibitions: unknown[] }; deferrals: { open: number };
    };
    expect(view.values["wall.hunters"]).toBe(4);
    expect(view.values["wall.walks"]).toBe(2);
    expect(view.values["wall.hunt_share_percent"]).toBe(25);
    expect(view.values["harness.adopt_by"]).toBe("bench");
    expect(view.values["owner_push.quiet"]).toBe("23:00-08:00");
    expect(view.values["baseline.already_built"]).toBe("stop");
    expect(view.values["regress.last_n"]).toBeNull();
    expect(view.versions["baseline.already_built"]).toBe(1);
    expect(view.status.night).toMatchObject({ enabled: true, hour: 3 });
    expect(view.status.night.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    expect(view.status.bench).toBeNull();
    expect(view.status.policy.needed).toBe(20);
    expect(view.policy.tiers.map((tier) => tier.tier)).toEqual(["night_decides", "night_proposes", "owner_only"]);
    expect(view.policy.prohibitions.length).toBeGreaterThan(0);
  });
});

describe("the next night", () => {
  it("is the next 03:00 on the clock of the machine", () => {
    const at = (hour: number, day = 22) => new Date(2026, 9, day, hour, 30).getTime();
    expect(new Date(nextNightRun(at(1))).getHours()).toBe(3);
    expect(new Date(nextNightRun(at(1))).getDate()).toBe(22);
    expect(new Date(nextNightRun(at(5))).getDate()).toBe(23);
    expect(new Date(nextNightRun(new Date(2026, 9, 22, 3, 0).getTime())).getDate()).toBe(23);
  });
});
