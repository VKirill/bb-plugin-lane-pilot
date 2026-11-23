import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { resolveRoleModel, roleFallbackModel } from "@lane-pilot/models";
import { REDUCERS, runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
import { effectiveGroup, effectiveSwitch } from "../src/rooms/contracts/helper-context";
import { roleSpec } from "../src/rooms/workflow/server/workflow-agent";
import { builtinWorkflow, isCoreLockedBuiltinId } from "../src/rooms/workflow/builtin";
import { DEFAULT_SCOUT_ANGLES, normalizeScoutAngles, runPlanCritique, runPmRead } from "../src/rooms/critique/server";
import { stageHelperSettings } from "../src/rooms/settings/server/stage-settings";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, setRunThread } from "../src/rooms/plugin-db";

describe("scout role, parallel scout workflow, and scout-first pre-writer policy", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  it("defines the read-only scout role on Antigravity Gemini 4 Argon with Claude Sonnet fallback and gitnexus access", () => {
    expect(resolveRoleModel("scout", {})).toMatchObject({
      providerId: "acp-antigravity",
      model: "gemini-4-argon",
      effort: "medium",
      source: "default",
    });
    expect(roleFallbackModel("scout")).toMatchObject({
      providerId: "claude-code",
      model: "claude-sonnet-5-5",
      effort: "medium",
    });
    expect(effectiveGroup("scout", "mcpServers").names).toEqual(expect.arrayContaining(["bb-bridge", "gitnexus"]));
    expect(effectiveSwitch("projectInstructions", {}, "scout").include).toBe(true);
    const spec = roleSpec("scout");
    expect(spec.readOnly).toBe(true);
    expect(spec.editable("src/server.ts")).toBe(false);
  });

  it("normalizes default 3-angle reconnaissance and custom 1-6 multi-angle audit slices", () => {
    const recon = normalizeScoutAngles(undefined);
    expect(recon.mode).toBe("recon");
    expect(recon.angles.map((a) => a.id)).toEqual(["architecture", "patterns", "dependencies"]);
    expect(DEFAULT_SCOUT_ANGLES).toHaveLength(3);

    const audit = normalizeScoutAngles([
      "CLI commands: check every bb cf command against src/cli.ts",
      { id: "step_kinds", title: "Step kinds & graph fields", focus: "Verify step types and schemas" },
      { title: "Disk layout", focus: "Verify tasks/{id}/ paths" },
      "Settings & UI menus: verify autopilot and publication toggles",
    ]);
    expect(audit.mode).toBe("audit");
    expect(audit.angles).toHaveLength(4);
    expect(audit.angles[0]).toMatchObject({ id: "cli-commands", title: "CLI commands" });
    expect(audit.angles[1]).toMatchObject({ id: "step-kinds", title: "Step kinds & graph fields" });
  });

  it("reduces parallel scout branches deterministically with deduplicated anchors, severity-ranked findings, and partial resilience", () => {
    const reduce = REDUCERS["reduce.scout.angles"]!;
    const out = reduce({
      items: [
        { id: "cli", title: "CLI commands" },
        { id: "steps", title: "Step kinds" },
        { id: "disk", title: "Disk layout" },
      ],
      results: [
        {
          angle: "cli",
          summary: "Found 2 stale flags.",
          anchors: [{ file: "src/cli.ts", line: 10, note: "entry" }, { file: "src/cli.ts", line: 10, note: "entry" }],
          findings: [{ severity: "medium", file: "SKILL.md", line: 42, evidence: "--old-flag", finding: "Flag renamed" }],
          conventions: ["Use z.object().strict() in src/cli.ts:24"],
          verification: ["npx vitest run tests/cli.test.ts"],
          open_questions: [],
        },
        {
          angle: "steps",
          summary: "WordPress postStatus field missing from skill.",
          anchors: [{ file: "src/steps/wp.ts", line: 55, note: "postStatus" }],
          findings: [{ severity: "high", file: "SKILL.md", line: 88, evidence: "wp.publish", finding: "Missing postStatus enum" }],
          conventions: ["Use z.object().strict() in src/cli.ts:24"],
          verification: ["npx vitest run tests/wp.test.ts"],
          open_questions: ["Should draft be default?"],
        },
      ],
      failed: [{ branch: 2, item: { id: "disk", title: "Disk layout" }, error: "provider_timeout", blocked: false }],
      rows: [
        { branch: 0, item: { id: "cli", title: "CLI commands" }, ok: true, data: { summary: "Found 2 stale flags." } },
        { branch: 1, item: { id: "steps", title: "Step kinds" }, ok: true, data: { summary: "WordPress postStatus field missing from skill." } },
        { branch: 2, item: { id: "disk", title: "Disk layout" }, ok: false, error: "provider_timeout" },
      ],
    });
    expect(out.status).toBe("partial");
    expect(out.failed_angles).toEqual(["Disk layout"]);
    expect((out.anchors as unknown[]).length).toBe(2);
    expect((out.findings as Array<{ severity: string }>).map((f) => f.severity)).toEqual(["high", "medium"]);
    expect(out.conventions).toEqual(["Use z.object().strict() in src/cli.ts:24"]);
    expect(out.verification).toEqual(["npx vitest run tests/cli.test.ts", "npx vitest run tests/wp.test.ts"]);
    expect(out.open_questions).toEqual(["Should draft be default?"]);
    expect(String(out.summary)).toContain("[CLI commands]");
    expect(String(out.summary)).toContain("[Step kinds]");
  });

  it("ships scout as a core-locked published workflow passing its simulation test and exposed via lane_pilot_helpers", async () => {
    const wf = builtinWorkflow("scout");
    expect(wf).toBeTruthy();
    expect(wf!.status).toBe("published");
    expect(isCoreLockedBuiltinId("scout")).toBe(true);

    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const db = openDatabase(bb);
    const cases = testCasesOf(wf!);
    expect(cases.length).toBeGreaterThanOrEqual(1);
    const sim = await runDraftTest({ db, harnessVersion: "0.1.607" }, wf!, cases[0]!);
    expect(sim.green, JSON.stringify(sim)).toBe(true);

    const helpers = harness.registrations.agentTools.find((t) => t.name === "lane_pilot_helpers")!;
    expect(helpers.description).toContain("scout");
    expect(helpers.description).toContain("wait_scout");
  });

  it("skips post-plan pm-read and LLM plan-critique on low/medium tasks when scout succeeded in the run, while preserving structural blocks and high-risk critique", async () => {
    let criticSpawns = 0;
    let pmReadSpawns = 0;
    const packetFiles = new Map<string, string>();
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        files: {
          write: async ({ path, content }: { path: string; content: string }) => { packetFiles.set(path, content); return { outcome: "written" }; },
          read: async ({ path }: { path?: string }) => {
            const stored = path ? packetFiles.get(path) : undefined;
            return { content: stored ?? `${Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n")}\n`, contentEncoding: "utf8" };
          },
        },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }],
          models: async () => ({ models: [{ id: "critic-m", model: "critic-m", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] }] }),
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "P", status: "idle" }),
          events: {
            list: async ({ threadId }: { threadId: string }) => [
              { type: "turn/started", threadId, seq: 1 },
              { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
            ],
          },
          spawn: async (args: Record<string, unknown>) => {
            const meta = (args.pluginMetadata ?? {}) as { stageId?: string };
            if (meta.stageId === "pm-read") pmReadSpawns += 1;
            else criticSpawns += 1;
            return { id: `thr-${criticSpawns + pmReadSpawns}` };
          },
          output: async () => ({ output: JSON.stringify({ status: "pass", summary: "Approved", findings: [], evidence: "checked src/a.ts:1" }) }),
          send: async () => ({}),
        },
      } as never,
    });
    dispose = () => harness.lifecycle.dispose();
    bb.hosts.experimental_client = (() => ({
      call: async (method: string) => (method === "inspectCritiqueCoverage" ? { status: "complete", pathCount: 12, findings: [] } : {}),
    })) as never;

    const db = openDatabase(bb);
    createRun(db, "run-s", "P", "cli", "/repo");
    setRunThread(db, "run-s", "pm-thr");
    saveProjectSetting(db, "P", "pm_read.enabled", true);
    saveProjectSetting(db, "P", "pm_read.min_lines", 50);
    saveProjectSetting(db, "P", "plan_critique.provider", "codex");
    saveProjectSetting(db, "P", "plan_critique.model", "critic-m");
    saveProjectSetting(db, "P", "role_model.plan-critic", { provider: "codex", model: "critic-m", reasoning_effort: "medium" });

    // Record a succeeded native `scout` workflow run linked to `run-s`.
    db.prepare(
      "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("wf_scout_1", "scout", 1, "sha", "{}", "P", "run-s", "succeeded", "{}", "{}", 1, 2);

    const config = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "critic-m", writerProviderId: "codex", writerModel: "critic-m" } as never;
    const ownsNine = Array.from({ length: 9 }, (_, i) => `src/f${i + 1}.ts`);
    const mediumTask = {
      schema_version: 2, id: "t-med", title: "Medium task", objective: "Update 9 files", kind: "feature", area: "core",
      risk: "medium", lane: "writer", project_cwd: "/repo", repo_scope: true,
      owns_paths: ownsNine, expected_outputs: ["src/f1.ts"], never_touch: [], read_first: ["src/f1.ts"],
      acceptance: ["works"], invariants: [], out_of_scope: [], interfaces: [], depends_on: [],
      verify: "commands", verification: [{ command: "npx vitest run tests/f1.test.ts" }],
    } as never;
    createTask(db, { id: "t-med", runId: "run-s", kind: "bb", contract: mediumTask });
    createAttempt(db, { id: "a-med", runId: "run-s", taskId: "t-med" });

    const pmReadRes = await runPmRead({ stageHelperSettings, bb, db, projectId: "P", runId: "run-s", taskId: "t-med", pmThreadId: "pm-thr", config, task: mediumTask, plan: "edit files" });
    expect(pmReadRes).toEqual({ state: "skipped", summary: "" });
    expect(pmReadSpawns).toBe(0);
    expect(listStageReceipts(db, "run-s", "t-med").find((r) => r.stageId === "pm-read")?.reason).toBe("scouted_before_plan");

    const planRes = await runPlanCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "run-s", taskId: "t-med", config, task: mediumTask, plan: "edit files" });
    expect(planRes).toEqual({ allowed: true, reason: "scouted_before_plan" });
    expect(criticSpawns).toBe(0);
    expect(listStageReceipts(db, "run-s", "t-med").find((r) => r.stageId === "plan-critique")?.reason).toBe("scouted_before_plan");

    // Deterministic structural errors (expected_outputs outside owns_paths) still block even when scouted!
    const brokenTask = { ...(mediumTask as object), id: "t-bad", expected_outputs: ["outside/file.ts"] } as never;
    createTask(db, { id: "t-bad", runId: "run-s", kind: "bb", contract: brokenTask });
    createAttempt(db, { id: "a-bad", runId: "run-s", taskId: "t-bad" });
    const badRes = await runPlanCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "run-s", taskId: "t-bad", config, task: brokenTask, plan: "edit files" });
    expect(badRes).toMatchObject({ allowed: false, reason: "structural_plan_critique_blocked" });
    expect(criticSpawns).toBe(0);

    // High-risk tasks in standard mode also skip post-plan critique when scout already mapped the repo,
    // while quality_mode: "full" still runs the independent LLM plan critic!
    const highTask = { ...(mediumTask as object), id: "t-high", risk: "high" } as never;
    createTask(db, { id: "t-high", runId: "run-s", kind: "bb", contract: highTask });
    createAttempt(db, { id: "a-high", runId: "run-s", taskId: "t-high" });
    const highRes = await runPlanCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "run-s", taskId: "t-high", config, task: highTask, plan: "edit files" });
    expect(highRes).toEqual({ allowed: true, reason: "scouted_before_plan" });
    expect(criticSpawns).toBe(0);

    const fullTask = { ...(mediumTask as object), id: "t-full", risk: "high", quality_mode: "full" } as never;
    createTask(db, { id: "t-full", runId: "run-s", kind: "bb", contract: fullTask });
    createAttempt(db, { id: "a-full", runId: "run-s", taskId: "t-full" });
    const fullRes = await runPlanCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "run-s", taskId: "t-full", config, task: fullTask, plan: "edit files" });
    expect(fullRes.allowed, JSON.stringify(fullRes)).toBe(true);
    expect(criticSpawns).toBe(1);
    expect(listStageReceipts(db, "run-s", "t-full").find((r) => r.stageId === "plan-critique")?.state).toBe("passed");
  });
});
