// Probe of scenes/sma_core_last.py (n1499, the per-workflow entries an agent sees): loads the REAL plugin of THIS checkout (the commit under drill) on a fake host,
// reads the instructions the PM's lane_pilot_route tool is registered with, and prints the graph ids they name next to the shipped graphs read from the catalog,
// as one JSON line. It judges nothing: the scene compares the two lists. No model, no hub write, nothing outside the machine.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../../server";
import { builtinWorkflows } from "../../../src/rooms/workflow/builtin";

async function main() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  try {
    const route = harness.registrations.agentTools.find((tool) => tool.name === "lane_pilot_route") as unknown as { instructions?: string } | undefined;
    const listed = /Ready graphs shipped with Lane Pilot: ([^;]*);/.exec(route?.instructions ?? "")?.[1]?.split(", ") ?? [];
    const all = builtinWorkflows();
    const ready = all.filter((w) => (w.status === "published" || w.status === "tested") && !w.internal && !w.startedBy).map((w) => w.id);
    const hidden = all.filter((w) => w.internal || w.startedBy).map((w) => w.id);
    process.stdout.write(`${JSON.stringify({ n1499: { registered: route !== undefined, listed, ready, hidden } })}\n`);
  } finally {
    await harness.lifecycle.dispose();
  }
}
void main().catch((cause: unknown) => { process.stdout.write(`${JSON.stringify({ n1499: { threw: cause instanceof Error ? cause.message : String(cause) } })}\n`); });
