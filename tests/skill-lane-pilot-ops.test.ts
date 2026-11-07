import { it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { createCore } from "../src/rooms/core/server/core";
import { registerCli } from "../src/rooms/tools/server/cli";
import type { Services } from "../src/rooms/platform/server";

// The runbook a stuck PM loads (skills/lane-pilot-ops): every command and tool it names must exist, or it sends a PM nowhere.
const SKILL = readFileSync("skills/lane-pilot-ops/SKILL.md", "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

it("names only lane_pilot tools that are registered", () => {
  const code = sources("src").map((path) => readFileSync(path, "utf8")).join("\n");
  const known = new Set([...code.matchAll(/["'`](lane_pilot_[a-z_]+)["'`]/g)].map((m) => m[1]!));
  const named = [...new Set([...SKILL.matchAll(/\blane_pilot_[a-z_]+/g)].map((m) => m[0]))];
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((name) => !known.has(name))).toEqual([]);
});

it("names only bb lane-pilot commands the CLI has", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as Services);
  const help = (await harness.behavior.runCli(["--help"])).stderr ?? "";
  const named = [...new Set([...SKILL.matchAll(/bb lane-pilot ([a-z][a-z-]*)/g)].map((m) => m[1]!))];
  expect(named.length).toBeGreaterThan(5);
  expect(named.filter((name) => !new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m").test(help))).toEqual([]);
});
