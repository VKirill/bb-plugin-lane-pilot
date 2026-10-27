import { createHash } from "node:crypto";
import { createFakeWorktreeHost } from "../own-worktree-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import plugin from "../../server";
import { QA_HOST_KEY } from "../../src/rooms/qa/qa-host";
import type { TaskV2 } from "../../src/rooms/contracts";
import { createRun, getAttempt, getRun, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/storage/database";

/**
 * The dispatch pipeline runs on the workflow engine and nowhere else. Each scenario states what the dispatch must answer, which
 * stage receipts it leaves and how the attempt and the run end; when the engine cannot start the pipeline the dispatch refuses.
 */

const projectId = "eq-project";
const pmThreadId = "eq-pm";
const runId = "eq-run";
const config = { projectId, hostId: "eq-host", pmWorkspacePath: "/tmp/eq-pm", writerWorkspacePath: "/tmp/eq-writer", pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" };
const task: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:eq-task", id: "eq-task", title: "Write a fixture", risk: "low", lane: "writer", project_cwd: config.writerWorkspacePath, read_first: ["README.md L1-L2"],
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
  /** What the browser-check thread answers (its fenced verdict). */
  qa?: string;
  baseRef?: string; gitBase?: "ready" | "not-git" | "error";
  runGate?: "pre-merge";
  /** Wait for the writer's end and read the acceptance receipts too. */
  finish?: boolean;
  /** What the scenario must really do, so that it is not equal merely because both paths failed the same way. */
  expect?: { state: string; reason?: RegExp };
  /** The PM cancels the task while its PM read runs (live 2026-10-09, fallback-continues-session). */
  cancelDuringPmRead?: boolean;
  /** Every helper thread reports 1,000 tokens (its events carry a `thread/tokenUsage/updated`). */
  usage?: boolean;
  /** Collects the plugin log's warnings. */
  warn?: string[];
};

async function runScenario(scenario: Scenario) {
  const spawned: Array<Record<string, unknown>> = [];
  const meta = new Map<string, Record<string, unknown>>();
  let nextWriter = 0, porcelain = 0;
  let runAfterCancel: string | null = null;
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
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId, ...(threadId === pmThreadId ? { environmentId: "eq-pm-env" } : {}) }) as never,
        events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
          ...(scenario.usage ? [{ type: "thread/tokenUsage/updated", threadId, seq: 3, createdAt: 2, data: { turnId: "t1", tokenUsage: { last: { inputTokens: 600, outputTokens: 400, totalTokens: 1000 }, total: { inputTokens: 600, outputTokens: 400, totalTokens: 1000 } } } }] : [])] },
        send: async () => ({}) as never,
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          if (threadId === "pm-read-thread" && scenario.cancelDuringPmRead) {
            await harness.behavior.callAgentTool("lane_pilot_cancel_task", { taskIds: [task.id] }, { threadId: pmThreadId, projectId });
            runAfterCancel = getRun(db, runId)!.state;
          }
          return threadId === "pm-read-thread" ? { output: scenario.pmRead ?? "{}" } : threadId === "critic-thread" ? { output: scenario.critique ?? approve }
          : threadId === "browser-qa-thread" ? { output: scenario.qa ?? "" } : threadId === "code-critique-thread" ? { output: approve } : threadId === "specialist-thread" ? { output: scenario.specialist ?? '{"decision":"approve","summary":"No risk","risks":[]}' } : { output: "writer created note.txt" };
        },
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
      if (call.method === "snapshotDryRun") return { hostId: config.hostId, entries: ((input.paths as string[]) ?? []).map((path) => ({ path, kind: path.endsWith("/note.txt") ? "missing" : "file", sha256: null, symlinkTarget: null })) };
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
  if (scenario.warn) vi.spyOn(bb.log, "warn").mockImplementation((message: string) => { scenario.warn!.push(String(message)); });
  savePrototypeConfig(db, config);
  const settings = { "plan_critique.min_score": 0, "plan_critique.min_write_tasks": 1, "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "project_life.enabled": false, "docs.enabled": false, ...scenario.settings };
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath, scenario.runGate ?? "none");
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const reply = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
    { confirm: true, objective: "Проверка диспетча", plan: "Write the fixture", task: { ...task, ...scenario.task }, ...(scenario.baseRef ? { baseRef: scenario.baseRef } : {}) }, { threadId: pmThreadId, projectId }))) as Record<string, unknown>;
  let waited: Record<string, unknown> | null = null;
  if (scenario.finish) waited = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId, timeoutSec: 10 }, { threadId: pmThreadId, projectId })));
  // The after-acceptance run of an accepted task goes on after the writer's end: wait for it before reading the receipts.
  if (scenario.finish) for (let i = 0; i < 100; i++) {
    const open = db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id='lp.after-accept' AND status IN ('running','waiting')").get();
    if (!open && db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id='lp.after-accept'").get()) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // A task with a browser check ends its pipeline after the check: wait for that too.
  if (scenario.finish && scenario.qa !== undefined) for (let i = 0; i < 100; i++) {
    if (!db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id IN ('lp-task-pipeline','lp.browser-qa') AND status IN ('running','waiting')").get()) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const attemptId = String(reply.attemptId ?? "");
  const taskId = String(reply.taskId ?? task.id);
  const out = {
    reply, waited,
    attempt: attemptId ? (({ state, reason }) => ({ state, reason }))(getAttempt(db, attemptId)!) : null,
    run: getRun(db, runId)!.state, runAfterCancel,
    stages: listStageReceipts(db, runId, taskId),
    spawned: spawned.map((row) => `${String((row.pluginMetadata as Record<string, unknown>).role)}:${String((row.pluginMetadata as Record<string, unknown>).stageId ?? "")}`),
    engineRuns: (db.prepare("SELECT id, workflow_id, status FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline'").all() as Array<{ id: string; workflow_id: string; status: string }>),
    engineSteps: (db.prepare("SELECT node_id, state FROM lane_pilot_wf_step WHERE run_id IN (SELECT id FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline') ORDER BY rowid").all() as Array<{ node_id: string; state: string }>),
    engineTokens: (db.prepare("SELECT tokens_used FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline'").all() as Array<{ tokens_used: number }>).map((row) => row.tokens_used),
    afterAccept: (db.prepare("SELECT idem_key, status, output_json FROM lane_pilot_wf_run WHERE workflow_id='lp.after-accept'").all() as Array<{ idem_key: string; status: string; output_json: string | null }>),
    qaRuns: (db.prepare("SELECT status, output_json FROM lane_pilot_wf_run WHERE workflow_id='lp.browser-qa'").all() as Array<{ status: string; output_json: string | null }>),
    pipelineOutput: JSON.parse((db.prepare("SELECT output_json FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline'").get() as { output_json: string | null } | undefined)?.output_json ?? "null") as Record<string, unknown> | null,
    spawnedMeta: spawned.map((row) => row.pluginMetadata as Record<string, unknown>),
  };
  await harness.lifecycle.dispose();
  return out;
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
  { name: "a cancel during a failing PM read keeps the task canceled and the run open", settings: { "pm_read.enabled": true, "pm_read.min_lines": 50, "pm_read.reasoning_effort": "medium" }, task: { read_first: ["README.md"] },
    pmRead: "not json at all", cancelDuringPmRead: true, expect: { state: "canceled" } },
  { name: "a cancel during a passing PM read starts no plan critique", settings: { "pm_read.enabled": true, "pm_read.min_lines": 50, "pm_read.reasoning_effort": "medium" }, task: { read_first: ["README.md"] },
    pmRead: '{"summary":"README names the contract","keyFacts":["Managed workspaces isolate task edits."],"openQuestions":[]}', cancelDuringPmRead: true, expect: { state: "canceled" } },
  { name: "specialist blocks a high-risk task", task: { risk: "high" }, settings: { "specialist.enabled": true, "specialist.when": "always" },
    specialist: '{"decision":"block","summary":"Unsafe","risks":[{"severity":"high","path":"note.txt","concern":"c","mitigation":"m"}]}', expect: { state: "blocked", reason: /specialist/ } },
  { name: "ownership base unavailable for an explicit base ref", baseRef: "feature", gitBase: "error", settings: { "plan_critique.enabled": false }, expect: { state: "blocked", reason: /ownership base unavailable: dirty base/ } },
  { name: "explicit base ref is frozen, then accepted", baseRef: "feature", gitBase: "ready", settings: { "plan_critique.enabled": false }, finish: true, expect: { state: "queued" } },
  { name: "explicit review gate stops before the stages", runGate: "pre-merge", expect: { state: "blocked", reason: /review_gate/ } },
  { name: "unresolved placeholder in the task blocks the plan critique", task: { objective: "Write REPLACE_ME" } },
];

afterEach(() => { vi.restoreAllMocks(); });

/** The stage receipts each scenario leaves (`stageId:state`, sorted by stage id). The after-acceptance stages are skipped here because memory and project life are off in the fixture. */
const STAGES: Record<string, string[]> = {
  "no review stages: queued, then accepted": ["acceptance-receipt:passed", "memory-maintenance:skipped", "plan-critique:skipped", "plan-fact:skipped", "pm-read:skipped", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "plan critique approves, then accepted": ["acceptance-receipt:passed", "memory-maintenance:skipped", "plan-critique:passed", "plan-fact:skipped", "pm-read:skipped", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "plan critique and PM read configured, then accepted": ["acceptance-receipt:passed", "memory-maintenance:skipped", "plan-critique:passed", "plan-fact:skipped", "pm-read:passed", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "quality_mode quick: the critique receipt is skipped by its own rule": ["acceptance-receipt:passed", "memory-maintenance:skipped", "plan-critique:skipped", "plan-fact:skipped", "pm-read:skipped", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "quality_mode full on a task of its own": ["acceptance-receipt:passed", "code-critique:passed", "memory-maintenance:skipped", "plan-critique:passed", "plan-fact:skipped", "pm-read:skipped", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "plan critique asks for changes: blocked before any writer": ["acceptance-receipt:skipped", "plan-critique:failed", "pm-read:skipped", "specialist-review:skipped", "verification:skipped", "writer-agent:skipped"],
  "PM read returns malformed output: blocked": ["acceptance-receipt:skipped", "plan-critique:skipped", "pm-read:failed", "specialist-review:skipped", "verification:skipped", "writer-agent:skipped"],
  "a cancel during a failing PM read keeps the task canceled and the run open": ["acceptance-receipt:canceled", "pm-read:canceled", "verification:canceled", "writer-agent:canceled"],
  "a cancel during a passing PM read starts no plan critique": ["acceptance-receipt:canceled", "pm-read:canceled", "verification:canceled", "writer-agent:canceled"],
  "specialist blocks a high-risk task": ["acceptance-receipt:skipped", "plan-critique:passed", "pm-read:skipped", "specialist-review:blocked", "verification:skipped", "writer-agent:skipped"],
  "ownership base unavailable for an explicit base ref": ["acceptance-receipt:skipped", "plan-critique:skipped", "pm-read:skipped", "run-gate:blocked", "specialist-review:skipped", "verification:skipped", "writer-agent:skipped"],
  "explicit base ref is frozen, then accepted": ["acceptance-receipt:passed", "memory-maintenance:skipped", "plan-critique:skipped", "plan-fact:skipped", "pm-read:skipped", "project-life:skipped", "specialist-review:skipped", "verification:passed", "writer-agent:passed"],
  "explicit review gate stops before the stages": ["acceptance-receipt:skipped", "plan-critique:skipped", "pm-read:skipped", "run-gate:blocked", "specialist-review:skipped", "verification:skipped", "writer-agent:skipped"],
  "unresolved placeholder in the task blocks the plan critique": ["acceptance-receipt:skipped", "plan-critique:blocked", "pm-read:skipped", "specialist-review:skipped", "verification:skipped", "writer-agent:skipped"],
};

/** The state of each stage receipt, in order, as a dispatch of the scenario leaves it. */
const stageStates = (run: Awaited<ReturnType<typeof runScenario>>) => run.stages.map((row) => `${row.stageId}:${row.state}`);

describe("the dispatch runs on the workflow engine", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      const run = await runScenario(scenario);
      if (scenario.expect) {
        expect(run.reply.state, JSON.stringify(run.reply).slice(0, 600)).toBe(scenario.expect.state);
        if (scenario.expect.reason) expect(String(run.reply.reason)).toMatch(scenario.expect.reason);
      }
      if (scenario.finish) expect((run.waited as { state: string }).state).toBe("accepted");
      expect(stageStates(run)).toEqual(STAGES[scenario.name]);
      if (scenario.cancelDuringPmRead) {
        // The stage verdict that came after the cancel neither blocks the run nor rewrites the writer stages the cancel closed.
        expect(run.attempt?.state).toBe("canceled");
        expect(run.runAfterCancel).not.toBeNull();
        expect(run.run).toBe(run.runAfterCancel);
        expect(run.spawned.filter((row) => !row.endsWith(":pm-read"))).toEqual([]);
        expect(run.stages.filter((row) => ["writer-agent", "verification", "acceptance-receipt"].includes(row.stageId)).map((row) => row.state)).toEqual(["canceled", "canceled", "canceled"]);
      }
      // An accepted task starts its after-acceptance run, keyed by the task; one that is not accepted starts none.
      if (scenario.finish) expect(run.afterAccept.map((row) => row.idem_key)).toEqual([`after-accept:${runId}:${task.id}`]);
      else expect(run.afterAccept).toEqual([]);
      // Every dispatch that gets past the review gate leaves one pipeline run in the journal.
      expect(run.engineRuns.map((row) => row.workflow_id)).toEqual(scenario.runGate === "pre-merge" ? [] : ["lp-task-pipeline"]);
    }, 30_000);
  }

  describe("the browser check of a task is a step of its own graph", () => {
    const qaTask = { qa_cases: ["the note page opens at 375"], qa_url: "http://127.0.0.1:5173/note" };
    const pass = '```json\n{"status":"pass","summary":"all cases pass","findings":[],"evidence":"shots in .agents/qa","cases":[{"case":"the note page opens at 375","result":"passed"}]}\n```';
    const rework = '```json\n{"status":"rework","summary":"the note page is blank","findings":[{"file":"/note","severity":"high","evidence":"the page body is empty at 375"}],"evidence":"shot","cases":[{"case":"the note page opens at 375","result":"failed"}]}\n```';
    const base = { finish: true, settings: { "plan_critique.enabled": false, quality_mode: "full", [QA_HOST_KEY]: config.hostId }, task: qaTask } as const;

    it("runs lp.browser-qa after acceptance, records its receipt, and the PM has nothing left to do by hand", async () => {
      const run = await runScenario({ name: "qa passes", ...base, qa: pass });
      const states = Object.fromEntries(run.stages.map((row) => [row.stageId, row.state]));
      expect(states["acceptance-receipt"]).toBe("passed");
      expect(states["browser-qa"]).toBe("passed");
      const waited = run.waited as Record<string, unknown>;
      expect(waited.state).toBe("accepted");
      expect(waited.next).toBeUndefined();
      expect(run.spawned).toContain("browser-qa:");
      // The pipeline went writer -> qa-gate -> browser-qa and ended well; the check is a child graph run of the pipeline.
      expect(run.engineSteps.map((step) => step.node_id).slice(-3)).toEqual(["writer", "qa-gate", "browser-qa"]);
      expect(run.engineRuns[0]!.status).toBe("succeeded");
      expect(run.qaRuns.map((row) => row.status)).toEqual(["succeeded"]);
      expect(run.pipelineOutput).toMatchObject({ browser_qa: { state: "passed" } });
    }, 40_000);

    it("a failed check leaves the receipt failed and tells the PM the task is not done", async () => {
      const run = await runScenario({ name: "qa fails", ...base, qa: rework });
      const states = Object.fromEntries(run.stages.map((row) => [row.stageId, row.state]));
      expect(states["browser-qa"]).toBe("failed");
      const waited = run.waited as { state: string; next?: Array<{ next: string }> };
      expect(waited.state).toBe("accepted");
      expect(waited.next).toHaveLength(1);
      expect(waited.next![0]!.next).toMatch(/browser check of this task's graph failed.*not done.*follow-up task/s);
      expect(waited.next![0]!.next).not.toMatch(/lane_pilot_helpers/);
    }, 40_000);

    it("runs no check for a task without qa_cases and qa_url, in any mode", async () => {
      for (const task of [{}, { qa_cases: qaTask.qa_cases }, { qa_url: qaTask.qa_url }]) {
        const run = await runScenario({ name: "no qa", finish: true, settings: { "plan_critique.enabled": false }, task });
        expect(run.stages.some((row) => row.stageId === "browser-qa")).toBe(false);
        expect(run.spawned).not.toContain("browser-qa:");
        expect(run.qaRuns).toEqual([]);
      }
    }, 60_000);

    it("a full-mode task with qa_cases and no qa_url is refused by the contract lint with the fix", async () => {
      const run = await runScenario({ name: "no qa_url", settings: { "plan_critique.enabled": false, quality_mode: "full" }, task: { qa_cases: qaTask.qa_cases } });
      expect(String(run.reply.reason)).toMatch(/contract lint/);
      expect(JSON.stringify(run.reply.findings)).toMatch(/qa_url_missing/);
      expect(run.attempt).toBeNull();
    }, 30_000);
  });

  it("keeps the task accepted when the memory stage fails; project life is independent of it", async () => {
    const run = await runScenario({ name: "memory fails", finish: true, settings: { "plan_critique.enabled": false, "memory.enabled": true, "memory.maintain": true, "memory.provider": "codex", "memory.model": "gpt-6-luna" } });
    expect((run.waited as { state: string }).state).toBe("accepted");
    expect(run.attempt?.state).toBe("accepted");
    // The fixture's memory helper answers prose, not memory records: the stage fails by its own receipt.
    const states = Object.fromEntries(run.stages.map((row) => [row.stageId, row.state]));
    expect(states["memory-maintenance"]).toBe("failed");
    expect(states["project-life"]).toBe("skipped");
    expect(states["acceptance-receipt"]).toBe("passed");
    // Both stages ran as steps of one graph run, which ended well; the memory thread carries the run and step it ran in.
    expect(run.afterAccept).toHaveLength(1);
    // The failed stage fails the graph run (the join), not the task: the run has no output, the task stays accepted.
    expect(run.afterAccept[0]!.status).toBe("failed");
    expect(run.afterAccept[0]!.output_json).toBeNull();
    const memory = run.spawnedMeta.find((meta) => meta.role === "memory-maintainer")!;
    expect(memory).toMatchObject({ stageId: "memory-maintenance", lanePilotWorkflowNode: "memory" });
    expect(memory.lanePilotWorkflowRunId).toBeTruthy();
  }, 30_000);

  it("refuses with engine_unavailable when the engine cannot start the pipeline, creating nothing", async () => {
    vi.spyOn(WorkflowEngine.prototype, "preflight").mockReturnValue(["executor \"lp.pm-read\" is not registered"]);
    const warnings: string[] = [];
    const run = await runScenario({ name: "engine down", warn: warnings });
    expect(run.reply).toMatchObject({ ok: false, error: { code: "engine_unavailable", retryable: true, sideEffects: "none" } });
    // No task, attempt, stage receipt or pipeline run: the PM sends the same task again.
    expect(run.stages).toEqual([]);
    expect(run.engineRuns).toEqual([]);
    expect(run.attempt).toBeNull();
    // The refusal is a failure line of the plugin log, which the wall's journal reads.
    expect(warnings.some((line) => /refused: engine_unavailable/.test(line))).toBe(true);
  }, 30_000);

  it("blocks the attempt when the engine refuses the run after the early check", async () => {
    const start = vi.spyOn(WorkflowEngine.prototype, "start").mockImplementation(() => { throw new Error("journal closed"); });
    const run = await runScenario({ name: "engine refuses" });
    expect(start).toHaveBeenCalled();
    expect(run.reply).toMatchObject({ state: "blocked" });
    expect(String(run.reply.reason)).toMatch(/dispatch_failed:engine_unavailable: journal closed/);
    expect(run.attempt?.state).toBe("blocked");
  }, 30_000);

  it("charges the helper threads to the run and tags them with the run and step that spawned them", async () => {
    const run = await runScenario({ name: "usage", usage: true, settings: { "pm_read.enabled": true, "pm_read.min_lines": 50, "pm_read.reasoning_effort": "medium" }, task: { read_first: ["README.md"] }, finish: true,
      pmRead: '{"summary":"README names the contract","keyFacts":["Managed workspaces isolate task edits."],"openQuestions":[]}' });
    const [runRow] = run.engineRuns;
    // pm-read, plan-critique and the writer each spent 1,000 tokens: the run's total is no longer 0. The writer step is charged when the engine's poll sees the task
    // end; the acceptance starts that poll at once (the browser check is the step after it), and tests/workflow/step-usage.test.ts pins the poll itself.
    expect(run.engineTokens[0]).toBe(3000);
    const byStage = (role: string) => run.spawnedMeta.find((meta) => meta.role === role)!;
    for (const [role, node] of [["pm-reader", "pm-read"], ["plan-critic", "plan-critique"], ["writer", "writer"]] as const) {
      expect(byStage(role), role).toMatchObject({ lanePilotWorkflowRunId: runRow!.id, lanePilotWorkflowNode: node });
      expect(byStage(role).lanePilotWorkflowStep, role).toBeTruthy();
    }
  }, 30_000);

  it("records the journal of a finished dispatch: one step per stage, the writer step settled when the task ends", async () => {
    const { engineRuns, engineSteps } = await runScenario({ name: "journal", settings: { "plan_critique.enabled": false }, finish: true });
    expect(engineSteps.map((step) => step.node_id)).toEqual(["pm-read", "quality-mode", "plan-critique", "specialist-review", "ownership-base", "task-folder", "writer", "qa-gate"]);
    expect(engineSteps.slice(0, -1).every((step) => step.state === "succeeded")).toBe(true);
    expect(["waiting", "succeeded"]).toContain(engineRuns[0]!.status);
  }, 30_000);
});
