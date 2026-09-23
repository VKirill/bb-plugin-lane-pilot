import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assessEngineCapabilities, inspectEngineCapabilitiesDetailed } from "../../src/upstream-adapter/capabilities";

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

function supportingFiles(index: string, telemetry = `export function createTelemetry() {
  return { event: async () => { if ("session.compacted") return; }, after: async () => ({}) };
}\n`, sticky = `export function ensureStickyMessages(messages: unknown[], block: string) { if (block) messages.push(block); }
export function dumpedToolNote(text: string) { return text ? "note" : ""; }\n`): Record<string, string> {
  return {
    "profiles/opencode/opencode-lane.ts": `export { default } from "./opencode-lane/index.ts";\n`,
    "profiles/opencode/opencode-lane/index.ts": index,
    "profiles/opencode/opencode-lane/telemetry.ts": telemetry,
    "profiles/opencode/opencode-lane/sticky.ts": sticky,
    "bin/lane-session": `#!/bin/sh\nexport CURSOR_ACP_FORWARD_TOOL_CALLS="false"\n`,
    "bin/execution_packet.py": `import re\n_WINDOW_RE = re.compile(r"L?(\\d+)-L?(\\d+)")\n`,
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("bounded OpenCode executable contract inspection", () => {
  it("rejects marker text inside invalid TypeScript and reports the failed interface", async () => {
    const root = await makeEngine(supportingFiles(`export default async function {
  return { event: async () => {}, "chat.message": async () => {}, "tool.execute.after": async () => {} };
}\n`));

    const inspected = await inspectEngineCapabilitiesDetailed(root);
    const assessed = assessEngineCapabilities(inspected.capabilities);

    expect(inspected.capabilities).not.toContain("opencode.hook.tool_execute_after");
    expect(assessed.missingCapabilities).toContain("opencode.hook.tool_execute_after");
    expect(inspected.diagnostics).toContainEqual(expect.objectContaining({
      capability: "opencode.hook.tool_execute_after",
      path: "profiles/opencode/opencode-lane/index.ts",
      detail: expect.stringContaining("TypeScript parse failed"),
    }));
  });

  it("requires a valid default export and callable hook values, not property-name markers", async () => {
    const root = await makeEngine(supportingFiles(`export const OpenCodeLanePlugin = async () => ({
  event: {},
  "chat.message": async () => {},
  "chat.params": async () => {},
  "tool.execute.after": "async () => {}",
  "experimental.chat.messages.transform": async () => {},
});
export default OpenCodeLanePlugin;\n`));

    const inspected = await inspectEngineCapabilitiesDetailed(root);
    const assessed = assessEngineCapabilities(inspected.capabilities);

    expect(assessed.compatible).toBe(false);
    expect(assessed.missingCapabilities).toEqual(expect.arrayContaining([
      "opencode.hook.event",
      "opencode.hook.tool_execute_after",
    ]));
    expect(assessed.missingCapabilities).not.toContain("opencode.hook.chat_message");
    expect(inspected.diagnostics.map((item) => item.capability)).toEqual(expect.arrayContaining([
      "opencode.hook.event",
      "opencode.hook.tool_execute_after",
    ]));
  });

  it("accepts a syntactically valid exported function with callable required hooks", async () => {
    const root = await makeEngine(supportingFiles(`export const OpenCodeLanePlugin = async () => {
  return {
    event: async () => {},
    "chat.message": async () => {},
    "chat.params": async () => {},
    "tool.execute.after": async () => {},
    "experimental.chat.messages.transform": async () => {},
  };
};
export default OpenCodeLanePlugin;\n`));

    const inspected = await inspectEngineCapabilitiesDetailed(root);

    expect(assessEngineCapabilities(inspected.capabilities).compatible).toBe(true);
    expect(inspected.diagnostics).toEqual([]);
  });
});
