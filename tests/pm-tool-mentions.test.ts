import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { LANE_PILOT_PM_SESSION } from "../src/native-agent-overlay";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/native-session-hooks";

// The PM spent turns hunting tools its text named but it did not have (instructions audit, 2026-10-03).
it("names only tools the PM actually has, in its prompt and its per-run instructions", () => {
  const configure = readFileSync(new URL("../src/rooms/tools/server/tools.ts", import.meta.url), "utf8");
  const perRun = configure.slice(configure.indexOf("bb.agents.configure"), configure.indexOf("bb.agents.configure") + 4000);
  const mentioned = new Set([...`${LANE_PILOT_PM_SESSION}\n${perRun}`.matchAll(/\blane_pilot_[a-z_]+/g)].map((match) => match[0]));
  const missing = [...mentioned].filter((name) => !(NATIVE_LP_BRIDGE_PM_TOOLS as readonly string[]).includes(name));
  expect(missing).toEqual([]);
});

it("tells the PM how to wait for quiet helpers and what to do with its own receipts", () => {
  expect(LANE_PILOT_PM_SESSION).toContain("lane_pilot_relay` with `action: \"remind\"` and their `taskIds`");
  expect(LANE_PILOT_PM_SESSION).toMatch(/## Receipts[\s\S]*needs_human[\s\S]*Lane Pilot's own fault/);
  expect(LANE_PILOT_PM_SESSION).toContain("data from outside");
  expect(LANE_PILOT_PM_SESSION).not.toMatch(/run-controller|lane_pilot_memory_maintain|onboarding_apply|LESSONS\.md line/);
});
