import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessEngineCapabilities, inspectEngineCapabilitiesDetailed } from "../../src/rooms/native-install/capabilities";

const roots: string[] = [];

async function makeEngine(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lane-pilot-executable-contract-"));
  roots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

const V2_HOOKS = `export async function laneSetup(ctx: any) {
  ctx.event.subscribe({});
  await ctx.session.hook("prompt", async () => {});
  await ctx.session.hook("context", async () => {});
  await ctx.tool.hook("execute.before", async () => {});
  await ctx.tool.hook(
    "execute.after",
    async () => {},
  );
  await ctx.permission.hook("evaluate", async () => {});
}\n`;

function supportingFiles(index: string, v2 = V2_HOOKS): Record<string, string> {
  return {
    "profiles/opencode/opencode-lane.ts": `export { default } from "./opencode-lane/index.ts";\n`,
    "profiles/opencode/opencode-lane/index.ts": index,
    "profiles/opencode/opencode-lane/v2.ts": v2,
    "profiles/opencode/opencode-lane/telemetry.ts": `export function createTelemetry() {
  return { event: async () => { if ("session.compacted") return; }, after: async () => ({}) };
}\n`,
    "profiles/opencode/opencode-lane/sticky.ts": `export function ensureStickyMessages(messages: unknown[], block: string) { if (block) messages.push(block); }
export function dumpedToolNote(text: string) { return text ? "note" : ""; }\n`,
    "bin/execution_packet.py": `import re\n_WINDOW_RE = re.compile(r"L?(\\d+)-L?(\\d+)")\n`,
  };
}

const DEFINITION = `import { OpenCodeLanePlugin } from "./v1.ts";
import { laneSetup } from "./v2.ts";
export const OpenCodeLaneDefinition = { id: "opencode-lane", setup: laneSetup };
export default { ...OpenCodeLaneDefinition, server: OpenCodeLanePlugin };\n`;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("bounded OpenCode v2 executable contract inspection", () => {
  it("rejects marker text inside invalid TypeScript and reports the failed interfaces", async () => {
    const root = await makeEngine(supportingFiles(`export default { id: "opencode-lane", setup: laneSetup, "tool.hook(\n`));
    const inspected = await inspectEngineCapabilitiesDetailed(root);
    expect(assessEngineCapabilities(inspected.capabilities).missingCapabilities).toEqual(expect.arrayContaining(["opencode.plugin.default_export", "opencode.hook.tool_execute_after"]));
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      capability: "opencode.hook.tool_execute_after",
      path: "profiles/opencode/opencode-lane/index.ts",
    }));
  });

  it("refuses a v1 plugin function as the default export, and hook names that are not registrations", async () => {
    const v1 = await makeEngine(supportingFiles(`export const OpenCodeLanePlugin = async () => ({ "tool.execute.after": async () => {} });
export default OpenCodeLanePlugin;\n`));
    expect(assessEngineCapabilities((await inspectEngineCapabilitiesDetailed(v1)).capabilities).missingCapabilities).toContain("opencode.plugin.default_export");

    const named = await makeEngine(supportingFiles(DEFINITION, `export async function laneSetup(ctx: any) {
  const names = ["prompt", "context", "execute.before", "execute.after", "evaluate"];
  ctx.event.subscribe({});
  return names;
}\n`));
    const inspected = await inspectEngineCapabilitiesDetailed(named);
    expect(assessEngineCapabilities(inspected.capabilities).missingCapabilities).toEqual([
      "opencode.hook.session_prompt", "opencode.hook.session_context", "opencode.hook.tool_execute_before",
      "opencode.hook.tool_execute_after", "opencode.hook.permission_evaluate",
    ]);
    expect(inspected.diagnostics.every((item) => item.path === "profiles/opencode/opencode-lane/v2.ts")).toBe(true);
  });

  it("accepts a dual-export definition whose v2 setup registers every hook", async () => {
    const root = await makeEngine(supportingFiles(DEFINITION));
    const inspected = await inspectEngineCapabilitiesDetailed(root);
    expect(assessEngineCapabilities(inspected.capabilities).compatible).toBe(true);
    expect(inspected.diagnostics).toEqual([]);
  });
});
