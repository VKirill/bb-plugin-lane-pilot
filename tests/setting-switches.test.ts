import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadProjectSettings, migrations, openDatabase } from "../src/rooms/plugin-db";
import { registerCli } from "../src/rooms/tools/server/cli";
import { createCore } from "../src/rooms/core/server/core";
import { UNLISTED_SWITCHES } from "../src/rooms/settings";
import type { Services } from "../server";

describe("bb lane-pilot setting: the switches with no row in the settings window", () => {
  it("every listed key is read by the code and has no row in the window's catalog", () => {
    // keys.ts also names keys that have no row (worker.strict_user): its `export const X = "key"` lines are not rows.
    const window = readFileSync("packages/settings-catalog/src/keys.ts", "utf8").split("\n").filter((line) => !line.startsWith("export const ")).join("\n") + readFileSync("src/rooms/ui-shell/ui/setting-copy.ts", "utf8");
    for (const key of Object.keys(UNLISTED_SWITCHES)) {
      const readers = execFileSync("git", ["grep", "-lF", `"${key}"`, "--", "src", "packages", ":!src/rooms/settings/switches.ts", ":!src/rooms/sma-map"], { encoding: "utf8" }).trim();
      expect(readers, `${key} is read nowhere`).not.toBe("");
      expect(window.includes(`"${key}"`), `${key} has a row in the window: drop it from the list`).toBe(false);
    }
  });

  it("lists every switch, sets one for a project and one hub-wide so the readers see them, clears one, and refuses a chat, an unknown key, a wrong value and a wrong scope", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    registerCli(createCore(bb, db), {} as Services, migrations);
    const run = (args: string[], invocation?: { threadId: string }) => harness.behavior.runCli(["setting", ...args], invocation);

    const list = await run([]);
    expect(list.exitCode).toBe(0);
    for (const key of Object.keys(UNLISTED_SWITCHES)) expect(String(list.stdout)).toContain(`${key} (`);

    const set = await run(["proj_1", "phase.diagnose=on", "writer.max_turns=120", 'writer.models_off=["haiku"]']);
    expect(set.exitCode).toBe(0);
    expect(loadProjectSettings(db, "proj_1")).toMatchObject({ "phase.diagnose": "on", "writer.max_turns": 120, "writer.models_off": ["haiku"] });
    expect(loadProjectSettings(db, "proj_2")["phase.diagnose"]).toBeUndefined();
    expect((await run(["global", "money.task_ceiling=on"])).exitCode).toBe(0);
    expect(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)["money.task_ceiling"]).toBe("on");
    expect(JSON.parse(String((await run(["proj_1"])).stdout))).toEqual({ scope: "proj_1", set: { "phase.diagnose": "on", "writer.max_turns": 120, "writer.models_off": ["haiku"] } });
    // A second write of the same key goes through on its new version; an empty value clears.
    expect((await run(["proj_1", "phase.diagnose=off"])).exitCode).toBe(0);
    expect(loadProjectSettings(db, "proj_1")["phase.diagnose"]).toBe("off");
    expect((await run(["proj_1", "phase.diagnose="])).exitCode).toBe(0);
    expect(loadProjectSettings(db, "proj_1")["phase.diagnose"]).toBeUndefined();

    const fromChat = await run(["proj_1", "phase.gray_areas=on"], { threadId: "thr-pm" });
    expect(fromChat.exitCode).toBe(1);
    expect(String(fromChat.stdout)).toContain("owner at a terminal");
    // A chat may still read.
    expect((await run(["proj_1"], { threadId: "thr-pm" })).exitCode).toBe(0);
    for (const bad of [["proj_1", "phase.diagnoze=on"], ["proj_1", "phase.diagnose=maybe"], ["proj_1", "writer.max_turns=many"], ["proj_1", "money.strict=on"], ["global", "ship.watch=on"], ["proj_1", "writer.model=x"]]) {
      expect((await run(bad)).exitCode, bad.join(" ")).not.toBe(0);
    }
    expect(loadProjectSettings(db, "proj_1")["phase.gray_areas"]).toBeUndefined();
    expect(loadProjectSettings(db, "proj_1")["money.strict"]).toBeUndefined();
    await harness.lifecycle.dispose();
  });
});
