import { createHash } from "node:crypto";
import { createFakeWorktreeHost } from "../own-worktree-host";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import type { TaskV2 } from "../../src/rooms/contracts";
import { createRun, getAttempt, getRun, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";

/**
 * The dispatch pipeline run twice per scenario, by the workflow engine and by the direct path (LANE_PILOT_WORKFLOW_ENGINE=0):
 * the same dispatch reply, the same stage receipts, the same attempt and run states, up to ids and clocks.
 */

const projectId = "eq-project";
const pmThreadId = "eq-pm";
const runId = "eq-run";
const config = { projectId, hostId: "eq-host", pmWorkspacePath: "/tmp/eq-pm", writerWorkspacePath: "/tmp/eq-writer", pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" };
const task: TaskV2 = {
  schema_version: 2, id: "eq-task", title: "Write a fixture", risk: "low", lane: "writer", project_cwd: config.writerWorkspacePath, read_first: ["README.md L1-L2"],
  interfaces: ["note.txt exists"], invariants: ["Only write note.txt"], out_of_scope: ["Plugin source"], expected_outputs: ["note.txt"], owns_paths: ["note.txt"],
  never_touch: [".git/**"], depends_on: [], objective: "Write note.txt", acceptance: ["note.txt is present"], verify: "tests",
  verification: [{ command: "test -f note.txt", cwd: config.writerWorkspacePath, timeout_sec: 30 }],
};
const readme = `stage fixture heading\nread-first fixture excerpt\n${Array.from({ length: 60 }, (_, index) => `bounded PM context line ${index + 1}`).join("\n")}`;
const noteSha = createHash("sha256").update("reviewed output\n", "utf8").digest("hex");
const approve = '{"decision":"approve","summary":"Checked","findings":[]}';

type Scenario = {
  name: string;
  settings?: Record<string, unknown>;
  task?: Partial<TaskV2>;
  critique?: string; specialist?: string; pmRead?: string;
  baseRef?: string; gitBase?: "ready" | "not-git" | "error";
  runGate?: "pre-merge";
  /** Wait for the writer's end and read the acceptance receipts too. */
  finish?: boolean;
  /** What the scenario must really do, so that it is not equal merely because both paths failed the same way. */
  expect?: { state: string; reason?: RegExp };
};

async function runScenario(engine: "on" | "off", scenario: Scenario) {
  const spawned: Array<Record<string, unknown>> = [];
  const meta = new Map<string, Record<string, unknown>>();
  let nextWriter = 0, porcelain = 0;
  // Every writer attempt of a git project works in its own worktree: the fake host makes, checks and merges them.
  const { bb, harness } = createFakeWorktreeHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : meta.get(threadId) ?? { role: "writer" },
        spawn: async (args) => {
          const request = args as unknown as Record<string, unknown>;
          if (request.prompt === undefined && Array.isArray(request.input)) request.prompt = (request.input as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n\n");
          spawned.push(request);
          const metadata = request.pluginMetadata as Record<string, unknown>;
          const id = metadata.role === "writer" ? `writer-thread-${++nextWriter}` : metadata.stageId === "pm-read" ? "pm-read-thread" : metadata.stageId === "plan-critique" ? "critic-thread"
            : metadata.stageId === "specialist-review" ? "specialist-thread" : `${String(metadata.stageId ?? metadata.role)}-thread`;
          meta.set(id, metadata);
          return { id };
        },
        wait: async () => ({ matched: true, thread: { status: "idle" } }),
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId }) as never,
        events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        send: async () => ({}) as never,
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => threadId === "pm-read-thread" ? { output: scenario.pmRead ?? "{}" } : threadId === "critic-thread" ? { output: scenario.critique ?? approve }
          : threadId === "code-critique-thread" ? { output: approve } : threadId === "specialist-thread" ? { output: scenario.specialist ?? '{"decision":"approve","summary":"No risk","risks":[]}' } : { output: "writer created note.txt" },
        list: async () => [...meta.keys()].map((id) => ({ id })) as never,
        queue: { list: async () => [] },
        queuedMessages: { delete: async () => ({ ok: true }) },
      },
      plugins: {
        experimental_discoverRpc: async ({ method }: { method: string }) => { throw new Error(`no plugin publishes ${method}`); },
        callRpc: async ({ pluginId }: { pluginId: string }) => { throw new Error(`plugin ${pluginId} is not enabled`); },
      } as never,
      providers: {
        list: async () => ["codex", "critic"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] })) as never,
        models: async (args) => {
          const providerId = (args as { providerId: string }).providerId;
          return { models: [{ id: providerId === "critic" ? "critic-model" : "gpt-6-luna", model: providerId === "critic" ? "critic-model" : "gpt-6-luna", defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never };
        },
      },
      environments: {
        listProviders: async () => [{ id: "git-worktree", pluginId: "environment-git-worktree", displayName: "Worktree", acceptsEmptyInputs: true, availability: null, description: null, icon: null, logoUrl: null, machineProviderId: null,
          requires: { gitCheckout: true, gitRemote: false, projectCheckout: true, projectless: false } }] as never,
        get: async ({ environmentId }) => ({ id: environmentId, hostId: config.hostId, path: config.writerWorkspacePath, status: "ready", managed: true, workspaceProvisionType: "managed-worktree" }) as never,
        status: async () => ({ outcome: "available", workspace: { branch: { currentBranch: "eq", defaultBranch: "main" } } }) as never,
        diff: async () => ({ outcome: "available", diff: { diff: "diff --git a/note.txt b/note.txt", files: "note.txt", shortstat: "1 file changed", truncated: false } }) as never,
      },
      files: {
        listPaths: async () => ({ truncated: false, paths: [{ kind: "file", name: "README.md", path: "README.md", positions: [], score: 1 }] }) as never,
        read: async ({ path }) => path.endsWith("README.md") ? { content: readme } : path.endsWith(".txt") ? { content: "reviewed output\n", sha256: noteSha } : { content: null },
        write: async () => ({ ok: true }) as never,
      },
    },
    experimental_callHostRpc: async (call) => {
      const input = call.input as Record<string, unknown>;
      if (call.method === "inspectCritiqueCoverage") return { hostId: config.hostId, status: "complete", pathCount: 1, findings: [] };
      if (call.method === "snapshotDryRun") return { hostId: config.hostId, entries: ((input.paths as string[]) ?? []).map((path) => ({ path, kind: "file", sha256: null, symlinkTarget: null })) };
      if (call.method === "gitOwnershipBase") {
        if (scenario.gitBase === "error") return { hostId: config.hostId, status: "invalid-ref", branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "dirty base" };
        if (scenario.gitBase === "ready") return { hostId: config.hostId, status: "ready", branch: "main", headSha: "a".repeat(40), baseRef: (input.baseRef as string | undefined) ?? "main", baseSha: "b".repeat(40), compareCommitted: true, reason: null };
        return { hostId: config.hostId, status: "not-git", branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "synthetic workspace has no git repository" };
      }
      if (call.method === "gitOwnershipChanges") return { hostId: config.hostId, status: "ready", headSha: "a".repeat(40), paths: [], reason: null };
      if (call.method === "gitIntegrate") return { hostId: config.hostId, status: "merged", commit: "d".repeat(40), conflicts: [], reason: null };
      if (call.method === "runSandboxedCommand") return { hostId: config.hostId, backend: "macos-seatbelt", workspacePath: config.writerWorkspacePath, cwd: config.writerWorkspacePath, exitCode: 0, policySha256: "c".repeat(64), stdout: "", stderr: "" };
      if (call.method !== "runCommand") throw new Error(`unexpected host method ${call.method}`);
      const command = String(input.command ?? "");
      if (command.includes("porcelain")) { porcelain += 1; return { hostId: config.hostId, exitCode: 0, stdout: JSON.stringify(porcelain === 1 ? [] : [{ path: "note.txt", sha256: noteSha }]), stderr: "" }; }
      return { hostId: config.hostId, exitCode: 0, stdout: "", stderr: "" };
    },
  }, config.hostId);
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  const settings = { "plan_critique.min_score": 0, "plan_critique.min_write_tasks": 1, "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "project_life.enabled": false, "docs.enabled": false, ...scenario.settings };
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath, scenario.runGate ?? "none");
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const previous = process.env.LANE_PILOT_WORKFLOW_ENGINE;
  if (engine === "off") process.env.LANE_PILOT_WORKFLOW_ENGINE = "0"; else delete process.env.LANE_PILOT_WORKFLOW_ENGINE;
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm: true, plan: "Write the fixture", task: { ...task, ...scenario.task }, ...(scenario.baseRef ? { baseRef: scenario.baseRef } : {}) }, { threadId: pmThreadId, projectId })));
  } finally { if (previous === undefined) delete process.env.LANE_PILOT_WORKFLOW_ENGINE; else process.env.LANE_PILOT_WORKFLOW_ENGINE = previous; }
  let waited: Record<string, unknown> | null = null;
  if (scenario.finish) waited = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId, timeoutSec: 10 }, { threadId: pmThreadId, projectId })));
  const attemptId = String(reply.attemptId ?? "");
  const taskId = String(reply.taskId ?? task.id);
  const out = {
    reply, waited,
    attempt: attemptId ? (({ state, reason }) => ({ state, reason }))(getAttempt(db, attemptId)!) : null,
    run: getRun(db, runId)!.state,
    stages: listStageReceipts(db, runId, taskId),
    spawned: spawned.map((row) => `${String((row.pluginMetadata as Record<string, unknown>).role)}:${String((row.pluginMetadata as Record<string, unknown>).stageId ?? "")}`),
    engineRuns: (db.prepare("SELECT id, workflow_id, status FROM lane_pilot_wf_run").all() as Array<{ id: string; workflow_id: string; status: string }>),
    engineSteps: (db.prepare("SELECT node_id, state FROM lane_pilot_wf_step ORDER BY rowid").all() as Array<{ node_id: string; state: string }>),
  };
  await harness.lifecycle.dispose();
  return out;
}

/** The same value with the ids and clocks that differ between two runs replaced. */
function normal(value: unknown): unknown {
  // Receipts of the stages that follow an acceptance hash its result, which carries the clock; their results are compared whole.
  const hashOfClock = new Set(["docs-maintenance", "memory-maintenance", "project-life", "acceptance-receipt", "writer-agent"]);
  const text = JSON.stringify(value, function (this: Record<string, unknown>, key, item) {
    if (key === "updatedAt" || key === "engineRuns" || key === "engineSteps" || key === "outputSha256") return undefined;
    if (key === "inputSha256" && hashOfClock.has(String(this.stageId))) return undefined;
    return item;
  });
  return JSON.parse(text.replace(/lpattempt_[a-f0-9]{32}/g, "ATTEMPT").replace(/lptask_[a-f0-9]{32}/g, "TASK")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "ISO").replace(/"(startedAt|finishedAt|durationMs|elapsedMs)":\d+/g, '"$1":0'));
}

const scenarios: Scenario[] = [
  { name: "no review stages: queued, then accepted", settings: { "plan_critique.enabled": false }, finish: true, expect: { state: "queued" } },
  { name: "plan critique approves, then accepted", finish: true, expect: { state: "queued" } },
  { name: "plan critique and PM read configured, then accepted", settings: { "pm_read.enabled": true, "pm_read.min_lines": 50, "pm_read.reasoning_effort": "medium" }, task: { read_first: ["README.md"] },
    pmRead: '{"summary":"README names the contract","keyFacts":["Managed workspaces isolate task edits."],"openQuestions":["which file?"]}', finish: true, expect: { state: "queued" } },
  { name: "quality_mode quick: the critique receipt is skipped by its own rule", settings: { quality_mode: "quick" }, finish: true, expect: { state: "queued" } },
  { name: "quality_mode full on a task of its own", task: { quality_mode: "full" }, finish: true, expect: { state: "queued" } },
  { name: "plan critique asks for changes: blocked before any writer", critique: '{"decision":"changes_requested","summary":"Needs work","findings":[{"severity":"blocking","finding":"vague criterion","path":"plan"}]}', expect: { state: "blocked", reason: /critique/ } },
  { name: "PM read returns malformed output: blocked", settings: { "pm_read.enabled": true, "pm_read.min_lines": 50, "pm_read.reasoning_effort": "medium" }, task: { read_first: ["README.md"] }, pmRead: "not json at all", expect: { state: "blocked", reason: /pm_read_failed/ } },
  { name: "specialist blocks a high-risk task", task: { risk: "high" }, settings: { "specialist.enabled": true, "specialist.when": "always" },
    specialist: '{"decision":"block","summary":"Unsafe","risks":[{"severity":"high","path":"note.txt","concern":"c","mitigation":"m"}]}', expect: { state: "blocked", reason: /specialist/ } },
  { name: "ownership base unavailable for an explicit base ref", baseRef: "feature", gitBase: "error", settings: { "plan_critique.enabled": false }, expect: { state: "blocked", reason: /ownership base unavailable: dirty base/ } },
  { name: "explicit base ref is frozen, then accepted", baseRef: "feature", gitBase: "ready", settings: { "plan_critique.enabled": false }, finish: true, expect: { state: "queued" } },
  { name: "explicit review gate stops before the stages", runGate: "pre-merge", expect: { state: "blocked", reason: /review_gate/ } },
  { name: "unresolved placeholder in the task blocks the plan critique", task: { objective: "Write REPLACE_ME" } },
];

afterEach(() => { delete process.env.LANE_PILOT_WORKFLOW_ENGINE; });

describe("dispatch through the workflow engine equals the direct path", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const direct = await runScenario("off", scenario);
      const engine = await runScenario("on", scenario);
      expect(normal(engine)).toEqual(normal(direct));
      if (scenario.expect) {
        expect(engine.reply.state, JSON.stringify(engine.reply).slice(0, 600)).toBe(scenario.expect.state);
        if (scenario.expect.reason) expect(String(engine.reply.reason)).toMatch(scenario.expect.reason);
      }
      if (scenario.finish) expect((engine.waited as { state: string }).state).toBe("accepted");
      // The kill switch really switches: the engine leaves a journal, the direct path none.
      expect(direct.engineRuns).toEqual([]);
      expect(engine.engineRuns.map((row) => row.workflow_id)).toEqual(scenario.runGate === "pre-merge" ? [] : ["lp-task-pipeline"]);
    }, 30_000);
  }

  it("records the journal of a finished dispatch: one step per stage, the writer step settled when the task ends", async () => {
    const { engineRuns, engineSteps } = await runScenario("on", { name: "journal", settings: { "plan_critique.enabled": false }, finish: true });
    expect(engineSteps.map((step) => step.node_id)).toEqual(["pm-read", "quality-mode", "plan-critique", "specialist-review", "ownership-base", "task-folder", "writer"]);
    expect(engineSteps.slice(0, -1).every((step) => step.state === "succeeded")).toBe(true);
    expect(["waiting", "succeeded"]).toContain(engineRuns[0]!.status);
  }, 30_000);
});
