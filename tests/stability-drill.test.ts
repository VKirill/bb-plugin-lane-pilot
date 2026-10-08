import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { runStabilityDrill } from "../src/rooms/verification/stability-drill";

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;

it.skipIf(!hasLsof)("passes every check of the fire drill on a scratch repository", async () => {
  const checks = await runStabilityDrill();
  expect(checks.map((check) => check.name)).toHaveLength(3);
  expect(checks.filter((check) => !check.ok)).toEqual([]);
});
