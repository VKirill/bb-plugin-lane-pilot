import { it, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../src/rooms/plugin-db";
import { createCore } from "../src/rooms/core/server/core";
import { registerCli } from "../src/rooms/tools/server/cli";
import type { Services } from "../server";

// 2026-11-02: regress-close was missing from the help, and a PM told the owner a quarantine could not be lifted.
it("the help of an unknown command names every registered command", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
  const help = (await harness.behavior.runCli(["--help"])).stderr ?? "";
  for (const name of ["regress", "regressions", "regress-close", "baseline", "timeline", "return", "bench", "wall", "schedule"]) {
    expect(help, name).toMatch(new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m"));
  }
});

it("dispatch-bb names its --plan flag in the help, and refuses the flag without a text", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
  const help = (await harness.behavior.runCli(["--help"])).stderr ?? "";
  expect(help).toMatch(/^bb lane-pilot dispatch-bb <project-id> <pm-thread-id> .*\[--plan "<plan text>"\]$/m);
  const refused = await harness.behavior.runCli(["dispatch-bb", "p", "t", "--plan"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain("--plan");
});
