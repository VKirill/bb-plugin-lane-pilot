import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessEngineCapabilities,
  adaptOpenCodePluginHooks,
  decideEngine,
  dumpedOpenCodeToolRecovery,
  opencodeNativeToolEnvironment,
  parseExecutionLineWindows,
} from "../../src/upstream-adapter/capabilities";
import { createOpenCodePluginShim } from "../../src/upstream-adapter/opencode-plugin";

type Fixture = {
  schemaVersion: number;
  baseline: { version: string; sourceSha: string; capabilities: string[] };
  sources: Array<{ label: string; version: string; sourceSha: string; capabilities: string[]; modified?: boolean }>;
};

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/capabilities.json", import.meta.url), "utf8")) as Fixture;
const byLabel = (label: string) => {
  const value = fixtures.sources.find((item) => item.label === label);
  if (!value) throw new Error(`missing fixture ${label}`);
  return value;
};

describe("upstream capability compatibility", () => {
  it("uses the same required-interface fixture for 1.38, 1.39 and dd77", () => {
    const old = assessEngineCapabilities(byLabel("v1.38.0").capabilities);
    const release = assessEngineCapabilities(byLabel("v1.39.0").capabilities);
    const baseline = assessEngineCapabilities(fixtures.baseline.capabilities);
    expect(old.missingCapabilities).toContain("opencode.hook.event");
    expect(old.diagnostics[0]?.impactedFunction).toContain("session lifecycle");
    expect(release.compatible).toBe(true);
    expect(release.adaptedCapabilities).toEqual(expect.arrayContaining([
      "opencode.sticky.dumped_tool_recovery",
      "opencode.native_tool_route",
      "execution_packet.line_windows",
    ]));
    expect(baseline.compatible).toBe(true);
    expect(fixtures.baseline.sourceSha).toBe("dd77b26792eca15e8bde03fd26754922ea7ab4f0");
  });

  it("reuses a newer compatible engine with an empty write plan", () => {
    const fixture = byLabel("v1.39.0");
    const decision = decideEngine(assessEngineCapabilities(fixture.capabilities), {
      installed: true,
      owner: "upstream",
      modified: false,
    });
    expect(decision).toEqual({ decision: "reuse", compatible: true, writes: [], reason: null });
  });

  it("preserves a compatible custom engine, regardless of modified state or SHA", () => {
    const fixture = byLabel("custom-compatible");
    const decision = decideEngine(assessEngineCapabilities(fixture.capabilities), {
      installed: true,
      owner: "user",
      modified: true,
    });
    expect(decision).toEqual({ decision: "reuse", compatible: true, writes: [], reason: null });
  });

  it("pinpoints the missing required hook and its affected function", () => {
    const fixture = byLabel("incompatible-tool-hook");
    const assessment = assessEngineCapabilities(fixture.capabilities);
    expect(assessment.compatible).toBe(false);
    expect(assessment.diagnostics).toContainEqual({
      capability: "opencode.hook.tool_execute_after",
      impactedFunction: "OpenCode tool evidence, budget, and winnow result handling",
      message: "Missing required interface opencode.hook.tool_execute_after; impacted function: OpenCode tool evidence, budget, and winnow result handling.",
    });
    expect(decideEngine(assessment, { installed: true, owner: "user", modified: true }).writes).toEqual([]);
  });

  it("adapts packet line windows and native OpenCode routing through local interfaces", () => {
    expect(parseExecutionLineWindows("src/app.ts L12-L25 and L30-L31")).toEqual({
      path: "src/app.ts",
      windows: [{ startLine: 12, endLine: 25 }, { startLine: 30, endLine: 31 }],
    });
    expect(Object.values(opencodeNativeToolEnvironment())).toEqual(["false", "opencode", "false"]);
    expect(dumpedOpenCodeToolRecovery('{"name":"bash","arguments":{"cmd":"pwd"}}')).toContain("OpenCode read/edit/write/bash/grep");
    expect(dumpedOpenCodeToolRecovery("plain result")).toBe("");
  });

  it("applies native route and dumped-tool adapters in the generated OpenCode shim", async () => {
    const adapterIds = ["opencode.native_tool_route", "opencode.sticky.dumped_tool_recovery"];
    const source = createOpenCodePluginShim("/tmp/managed-engine", adapterIds);
    expect(source).toContain('"CURSOR_ACP_FORWARD_TOOL_CALLS":"false"');
    expect(source).toContain("adaptOpenCodePluginHooks(hooks, lanePilotAdapters)");
    expect(() => new Function(source
      .replace("export default async function lanePilotOpenCodePlugin", "async function lanePilotOpenCodePlugin")
      .concat("\nreturn lanePilotOpenCodePlugin;"))).not.toThrow();
    const hooks = adaptOpenCodePluginHooks({
      "experimental.chat.messages.transform": async () => undefined,
    }, adapterIds) as Record<string, (input: unknown, output: { messages: Array<Record<string, unknown>> }) => Promise<unknown>>;
    const messages: Array<Record<string, unknown>> = [{
      info: { role: "assistant" },
      parts: [{ type: "text", text: '{"name":"bash","arguments":{"cmd":"pwd"}}' }],
    }];
    await hooks["experimental.chat.messages.transform"]({}, { messages });
    expect(messages.at(-1)).toMatchObject({
      info: { role: "user" },
      parts: [{ synthetic: true, text: expect.stringContaining("OpenCode read/edit/write/bash/grep") }],
    });
  });
});
