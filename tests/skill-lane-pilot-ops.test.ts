import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../src/rooms/plugin-db";
import { createCore } from "../src/rooms/core/server/core";
import { registerCli } from "../src/rooms/tools/server/cli";
import { LANE_PILOT_TOOL_SEARCH_NAME, PM_CORE_TOOLS, PM_FAMILY_TOOLS } from "../src/rooms/platform/server/pm-tool-families";
import type { Services } from "../server";

// The runbook a stuck PM loads (skills/lane-pilot-ops): every command and tool it names must exist, or it sends a PM nowhere.
const SKILL = readFileSync("skills/lane-pilot-ops/SKILL.md", "utf8");

// The tools the PM can actually call: the registered lists, not a text scan of the sources.
const KNOWN_TOOLS = new Set([...PM_CORE_TOOLS, ...PM_FAMILY_TOOLS, LANE_PILOT_TOOL_SEARCH_NAME]);

it("names only lane_pilot tools that are registered", () => {
  const named = [...new Set([...SKILL.matchAll(/\blane_pilot_[a-z_]+/g)].map((m) => m[0]))];
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((name) => !KNOWN_TOOLS.has(name))).toEqual([]);
});

it("names only bb lane-pilot commands the CLI has", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
  const help = (await harness.behavior.runCli(["--help"])).stderr ?? "";
  const named = [...new Set([...SKILL.matchAll(/bb lane-pilot ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((name) => !new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m").test(help))).toEqual([]);
});
