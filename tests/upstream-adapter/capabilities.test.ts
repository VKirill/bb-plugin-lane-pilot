import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assessEngineCapabilities,
  decideEngine,
  parseExecutionLineWindows,
} from "../../src/rooms/native-install/capabilities";
import { createOpenCodePluginShim } from "../../src/rooms/native-install/opencode-plugin";

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
  it("refuses the v1 plugin of Lane Stack 1.65 and takes 1.66, adapting only line windows", () => {
    const old = assessEngineCapabilities(byLabel("v1.65").capabilities);
    const release = assessEngineCapabilities(byLabel("v1.66.0-no-windows").capabilities);
    const baseline = assessEngineCapabilities(fixtures.baseline.capabilities);
    expect(old.compatible).toBe(false);
    expect(old.missingCapabilities).toEqual(expect.arrayContaining(["opencode.plugin.default_export", "opencode.hook.session_prompt", "opencode.hook.permission_evaluate"]));
    expect(old.diagnostics[0]?.impactedFunction).toContain("OpenCode v2 plugin module loading");
    expect(release.compatible).toBe(true);
    expect(release.adaptedCapabilities).toEqual(["execution_packet.line_windows"]);
    expect(baseline.compatible).toBe(true);
    expect(baseline.adaptedCapabilities).toEqual([]);
  });

  it("reuses a newer compatible engine with an empty write plan", () => {
    const fixture = byLabel("v1.66.0-no-windows");
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

  it("adapts packet line windows through a local interface", () => {
    expect(parseExecutionLineWindows("src/app.ts L12-L25 and L30-L31")).toEqual({
      path: "src/app.ts",
      windows: [{ startLine: 12, endLine: 25 }, { startLine: 30, endLine: 31 }],
    });
  });

  it("generates an OpenCode v2 shim that re-exports the engine's definition", () => {
    const source = createOpenCodePluginShim("/tmp/managed-engine");
    expect(source).toContain('export { default } from "file:///tmp/managed-engine/profiles/opencode/opencode-lane/index.ts";');
    expect(source).toContain('process.env.LANE_STACK_ROOT = "/tmp/managed-engine"');
    expect(source).not.toContain("export default async function");
  });
});

it("keeps dates in file names as part of the path, and reads windows only after a separator", async () => {
  const { parseExecutionLineWindows: parse } = await import("../../src/rooms/native-install/capabilities");
  expect(parse(".agents/plans/2026-10-02-greeting-cards.md")).toEqual({ path: ".agents/plans/2026-10-02-greeting-cards.md", windows: [] });
  expect(parse(".agents/plans/2026-10-02-cards.md:10-20")).toEqual({ path: ".agents/plans/2026-10-02-cards.md", windows: [{ startLine: 10, endLine: 20 }] });
  expect(parse("src/a.ts#L5-L9")).toEqual({ path: "src/a.ts", windows: [{ startLine: 5, endLine: 9 }] });
  expect(parse("src/a.ts 3-4, 8-9")).toEqual({ path: "src/a.ts", windows: [{ startLine: 3, endLine: 4 }, { startLine: 8, endLine: 9 }] });
});
