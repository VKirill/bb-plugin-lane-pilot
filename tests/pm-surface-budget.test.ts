import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { LANE_PILOT_PM_SESSION } from "../src/rooms/native-agent/native-agent-overlay";

/**
 * What the PM pays for every turn: the session prompt plus the description and instructions of every tool on its folded
 * list (src/rooms/tools/pm-tool-families.ts — a family's published instructions already carry its actions' texts, so the
 * registered surface is what the PM reads). The ceiling is the measured total on 2026-11-02 rounded up to 1 000; over it,
 * cut first or raise it on purpose, saying why in the commit. Per tool, BB refuses registration above 4096 instructions.
 */
const SURFACE_CEILING = 62_500; // +500 on 2026-11-02: the decide-yourself rule, the owner's top complaint in the replayed chats
const TOOL_INSTRUCTIONS_MAX = 4_096;

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

it("sums the PM prompt and every tool text the PM sees, under a ceiling", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const published = new Map((harness.registrations.agentTools as Array<{ name: string; description?: string; instructions?: string }>).map((tool) => [tool.name, tool]));
  const rows: Array<[string, number]> = [["<prompt>", LANE_PILOT_PM_SESSION.length]];
  let total = LANE_PILOT_PM_SESSION.length;
  for (const name of NATIVE_LP_BRIDGE_PM_TOOLS) {
    const tool = published.get(name);
    if (!tool) { rows.push([name, -1]); continue; }
    const size = (tool.description?.length ?? 0) + (tool.instructions?.length ?? 0);
    expect(tool.instructions?.length ?? 0, `${name} instructions`).toBeLessThanOrEqual(TOOL_INSTRUCTIONS_MAX);
    rows.push([name, size]);
    total += size;
  }
  const table = rows.sort((a, b) => b[1] - a[1]).map(([name, size]) => `${name}: ${size}`).join("\n");
  expect(total, `PM surface is ${total} (ceiling ${SURFACE_CEILING}):\n${table}`).toBeLessThanOrEqual(SURFACE_CEILING);
});
