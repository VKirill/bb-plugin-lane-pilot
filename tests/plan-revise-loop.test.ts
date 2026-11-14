import { createHash } from "node:crypto";
import { createFakeWorktreeHost } from "./own-worktree-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/rooms/contracts";
import { shouldRunPlanCritique } from "../src/rooms/critique/critique";
import { parsePlanRevision, planReviseConfig } from "../src/rooms/writer/server/plan-revise";
import { contractEditions, createRun, getAttempt, getTaskPlan, listStageReceipts, openDatabase, renderTaskManifest, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/rooms/plugin-db";

/**
 * The planner <-> critic loop of the direct dispatch path (SMA n1269 «Up to three revision rounds», n1267, n1268, n22, n23, n25, n28): a plan the
 * critic returns is revised by the planner in its own session, a fresh critic judges every revision, and only what the planner cannot fix goes to
 * the PM with the findings of every round. Each case dispatches through the real pipeline graph and reads what was written: the contract editions,
 * the stage receipts, which thread got which message, where the task went.
 */

const projectId = "pr-project";
const pmThreadId = "pr-pm";
const runId = "pr-run";
const config = { projectId, hostId: "pr-host", pmWorkspacePath: "/tmp/pr-pm", writerWorkspacePath: "/tmp/pr-writer", pmProviderId: "codex", pmModel: "gpt-6-luna", writerProviderId: "codex", writerModel: "gpt-6-luna" };
const task: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:pr-task", id: "pr-task", title: "Write a fixture", risk: "high", lane: "writer", project_cwd: config.writerWorkspacePath, read_first: ["README.md L1-L2"],
  interfaces: ["note.txt exists"], invariants: ["Only write note.txt"], out_of_scope: ["Plugin source"], expected_outputs: ["note.txt"], owns_paths: ["note.txt"],
  never_touch: [".git/**"], depends_on: [], objective: "Write note.txt", acceptance: ["note.txt is present"], verify: "tests",
  verification: [{ command: "test -f note.txt", cwd: config.writerWorkspacePath, timeout_sec: 30 }],
};
const PLAN = "Write the fixture";
const noteSha = createHash("sha256").update("reviewed output\n", "utf8").digest("hex");
const PASS = '{"decision":"approve","summary":"Checked","findings":[]}';
const rework = (n: number) => JSON.stringify({ status: "rework", summary: `round ${n}: the plan has no step that writes the note`, evidence: "read the plan and note.txt",
  findings: [{ file: "note.txt", line: 1, severity: "high", evidence: "PLAN: no step writes note.txt", finding: `round ${n}: add a step that writes note.txt with its content` }] });
const revision = (text: string) => JSON.stringify({ edition_read: 1, plan: text, changes: "added the step" });

type Scenario = {
  settings?: Record<string, unknown>;
  task?: Partial<TaskV2>;
  /** The critic's answers, one per critic thread in order; the last repeats. */
  critic: string[];
  /** The planner's answers, one per round in order; the last repeats. */
  planner?: string[];
  /** Wait for the writer's end too. */
  finish?: boolean;
  /** The PM updates the task while the planner works on round 1. */
  pmUpdatesDuringRound?: boolean;
  /** Dispatch by `bb lane-pilot dispatch-bb` (the drill's door) instead of the PM tool; `plan` is its --plan, absent: no flag. */
  cli?: { plan?: string };
};

async function runScenario(scenario: Scenario) {
  const spawned: Array<Record<string, unknown>> = [];
  const meta = new Map<string, Record<string, unknown>>();
  const asked = new Map<string, number>();
  const sends: Array<{ threadId: string; text: string }> = [];
  // The files the plugin wrote (the task home): they read back as written.
  const written = new Map<string, string>();
  let critics = 0, nextWriter = 0, porcelain = 0, plannerRounds = 0;
  let updateReply: Promise<unknown> | null = null;
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
          const id = metadata.role === "writer" ? `writer-thread-${++nextWriter}` : metadata.stageId === "plan-critique" ? `critic-thread-${++critics}`
            : metadata.stageId === "plan-revise" ? "planner-thread" : `${String(metadata.stageId ?? metadata.role)}-thread`;
          meta.set(id, metadata);
          return { id };
        },
        wait: async () => ({ matched: true, thread: { status: "idle" } }),
        get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId, ...(threadId === pmThreadId ? { environmentId: "pr-pm-env" } : {}) }) as never,
        events: { list: async ({ threadId }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
          ...(asked.has(threadId) ? [{ type: "client/turn/requested", threadId, seq: 10, createdAt: asked.get(threadId) }, { type: "turn/started", threadId, seq: 11 }, { type: "turn/completed", threadId, seq: 12, data: { status: "completed" } }] : [])] },
        send: async (sent) => {
          const args = sent as unknown as { threadId: string; input?: Array<{ text?: string }>; text?: string };
          asked.set(args.threadId, Date.now());
          sends.push({ threadId: args.threadId, text: (args.input ?? []).map((part) => part.text ?? "").join("\n") || String(args.text ?? "") });
          return {} as never;
        },
        stop: async () => ({ ok: true }) as never,
        output: async ({ threadId }) => {
          if (threadId.startsWith("critic-thread-")) {
            const n = Number(threadId.slice("critic-thread-".length));
            return { output: scenario.critic[Math.min(n, scenario.critic.length) - 1]! };
          }
          if (threadId === "planner-thread") {
            const answers = scenario.planner ?? [revision("Write the fixture: create note.txt with the reviewed output and check it")];
            const answer = answers[Math.min(plannerRounds, answers.length - 1)]!;
            plannerRounds += 1;
            if (scenario.pmUpdatesDuringRound && plannerRounds === 1) {
              updateReply = harness.behavior.callAgentTool("lane_pilot_update_task", { taskId: task.id, plan: "The PM's own plan: write note.txt" }, { threadId: pmThreadId, projectId });
              for (let i = 0; i < 100 && !contractEditions(db, task.id).some((row) => row.reason === "pm_update:planner_loop_stopped"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
            }
            return { output: answer };
          }
          return threadId === "code-critique-thread" ? { output: PASS } : threadId === "specialist-thread" ? { output: '{"decision":"approve","summary":"No risk","risks":[]}' } : { output: "writer created note.txt" };
        },
        list: async () => [...meta.keys()].map((id) => ({ id })) as never,
        queue: { list: async () => [] },
        queuedMessages: { delete: async () => ({ ok: true }) },
      },
      plugins: {
        experimental_discoverRpc: async ({ method }: { method: string }) => { throw new Error(`no plugin publishes ${method}`); },
        callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
          if (pluginId === "bb--git") {
            if (method === "workspaceStatus") return { outcome: "available", workspace: { branch: { currentBranch: "pr", defaultBranch: "main" } } };
            if (method === "diff") return { outcome: "available", diff: { diff: "diff --git a/note.txt b/note.txt", files: "note.txt", shortstat: "1 file changed", truncated: false } };
          }
          throw new Error(`plugin ${pluginId} is not enabled`);
        },
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
      },
      files: {
        listPaths: async () => ({ truncated: false, paths: [{ kind: "file", name: "README.md", path: "README.md", positions: [], score: 1 }] }) as never,
        read: async ({ path }) => written.has(path) ? { content: written.get(path)! } : path.endsWith("README.md") ? { content: "readme\n" } : path.endsWith(".txt") ? { content: "reviewed output\n", sha256: noteSha } : { content: null },
        write: async (args) => { const { path, content } = args as unknown as { path: string; content: string }; written.set(path, content); return { ok: true } as never; },
      },
    },
    experimental_callHostRpc: async (call) => {
      const input = call.input as Record<string, unknown>;
      if (call.method === "inspectCritiqueCoverage") return { hostId: config.hostId, status: "complete", pathCount: 1, findings: [] };
      if (call.method === "snapshotDryRun") return { hostId: config.hostId, entries: ((input.paths as string[]) ?? []).map((path) => ({ path, kind: path.endsWith("/note.txt") ? "missing" : "file", sha256: null, symlinkTarget: null })) };
      if (call.method === "gitOwnershipBase") return { hostId: config.hostId, status: "not-git", branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "synthetic workspace has no git repository" };
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
  const settings = { "plan_critique.min_score": 0, "plan_critique.min_write_tasks": 1, "memory.enabled": false, "project_life.enabled": false, "docs.enabled": false, ...scenario.settings };
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, projectId, key, value);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath, "none");
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatched = { ...task, ...scenario.task };
  const reply = JSON.parse(scenario.cli
    ? String((await harness.behavior.runCli(["dispatch-bb", projectId, pmThreadId, JSON.stringify(dispatched), ...(scenario.cli.plan !== undefined ? ["--plan", scenario.cli.plan] : [])])).stdout)
    : String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm: true, objective: "Проверка цикла планировщика", plan: PLAN, task: dispatched }, { threadId: pmThreadId, projectId }))) as Record<string, unknown>;
  // The loop goes on after the dispatch answers: wait for the pipeline run to stop.
  const pipelineOpen = () => db.prepare("SELECT 1 FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' AND status='running'").get();
  for (let i = 0; i < 300 && (pipelineOpen() || getAttempt(db, String(reply.attemptId ?? ""))?.reason?.startsWith("dispatch_stages_pending")); i++) await new Promise((resolve) => setTimeout(resolve, 30));
  if (updateReply) await updateReply;
  for (let i = 0; i < 300 && (pipelineOpen() || getAttempt(db, String(reply.attemptId ?? ""))?.reason?.startsWith("dispatch_stages_pending")); i++) await new Promise((resolve) => setTimeout(resolve, 30));
  let waited: Record<string, unknown> | null = null;
  if (scenario.finish) waited = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId, timeoutSec: 10 }, { threadId: pmThreadId, projectId })));
  const attemptId = String(reply.attemptId ?? "");
  const pipeline = db.prepare("SELECT id, output_json FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline' ORDER BY rowid DESC LIMIT 1").get() as { id: string; output_json: string | null } | undefined;
  const out = {
    reply, waited,
    attempt: attemptId ? (({ state, reason }) => ({ state, reason }))(getAttempt(db, attemptId)!) : null,
    everBlocked: !!db.prepare("SELECT 1 FROM lane_pilot_attempt_transition WHERE attempt_id=? AND to_state='blocked' AND refused=0").get(attemptId),
    stages: Object.fromEntries(listStageReceipts(db, runId, task.id).map((row) => [row.stageId, row])),
    editions: contractEditions(db, task.id),
    editionPlans: db.prepare("SELECT edition, reason, plan FROM lane_pilot_task_contract_edition WHERE task_id=? ORDER BY edition").all(task.id) as Array<{ edition: number; reason: string | null; plan: string | null }>,
    plan: getTaskPlan(db, task.id),
    spawned: spawned.map((row) => ({ id: "", role: String((row.pluginMetadata as Record<string, unknown>).role), stageId: String((row.pluginMetadata as Record<string, unknown>).stageId ?? ""), prompt: String(row.prompt ?? "") })),
    criticThreads: critics,
    plannerRounds,
    sends,
    steps: (db.prepare("SELECT node_id, state FROM lane_pilot_wf_step WHERE run_id IN (SELECT id FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline') ORDER BY rowid").all() as Array<{ node_id: string; state: string }>),
    pipelineOutput: JSON.parse(pipeline?.output_json ?? "null") as { reply?: Record<string, unknown> } | null,
    manifest: renderTaskManifest(db, task.id) as { files: Array<{ kind: string; path: string; supersedes?: string; produced_by: { node: string }; read_by: Array<{ node: string; sha256: string | null }>; sha256: string }> } | null,
    written,
    critiqueEvents: (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_stage_event WHERE task_id=? AND stage_id='plan-critique' AND state='running'").get(task.id) as { n: number }).n,
  };
  await harness.lifecycle.dispose();
  return out;
}

afterEach(() => { vi.restoreAllMocks(); });

const planner = { "plan_critique.revise_by": "planner" };
const toPm = (run: Awaited<ReturnType<typeof runScenario>>) => run.sends.filter((row) => row.threadId === pmThreadId);
const blockedReply = (run: Awaited<ReturnType<typeof runScenario>>) => (run.pipelineOutput?.reply ?? run.reply) as Record<string, unknown> & { plannerLoop?: { revisions: number; maxRounds: number; stopped: string | null; rounds: Array<{ round: number; findings: unknown[] }>; note: string } };

describe("the planner revises a plan the critic returned", () => {
  it("[sma:k_wp_revision] [sma:k_wp_planner] [sma:p2_planner] [sma:p2_session_end] a return goes to the planner, its revision passes a fresh critic and the writer starts; the PM gets nothing", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), PASS], finish: true });
    // The revision is the second contract edition, written by the planner with its round; the stored plan is the planner's.
    expect(run.editions.map((row) => row.reason)).toEqual(["created", "planner_revision:1/3"]);
    expect(run.editionPlans[1]!.plan).toBe("Write the fixture: create note.txt with the reviewed output and check it");
    expect(run.plan).toBe("Write the fixture: create note.txt with the reviewed output and check it");
    // The planner is a session of its own (role planner); the critic of the revision is a new thread, and it has the last word: it passed.
    expect(run.spawned.filter((row) => row.role === "planner").map((row) => row.stageId)).toEqual(["plan-revise"]);
    expect(run.criticThreads).toBe(2);
    expect(run.stages["plan-critique"]!.state).toBe("passed");
    expect(run.steps.map((row) => row.node_id).slice(0, 6)).toEqual(["pm-read", "quality-mode", "plan-critique", "plan-revise", "plan-critique", "specialist-review"]);
    // The planner's brief names the edition it reads and carries the critic's finding.
    const brief = run.spawned.find((row) => row.role === "planner")!.prompt;
    expect(brief).toContain("CONTRACT EDITION 1");
    expect(brief).toContain("round 1: add a step that writes note.txt");
    // The task went to the writer and was accepted; the attempt never blocked, and no message went to the PM's thread.
    expect((run.waited as { state: string }).state).toBe("accepted");
    expect(run.everBlocked).toBe(false);
    expect(toPm(run)).toEqual([]);
  }, 60_000);

  // The task home (docs/task-folder.md): the planner's revision is the home's new PLAN.md and contract edition, and the fresh critic of the next
  // round reads that PLAN.md through the manifest. Mutation it fails under: the plan-revise executor not recording the revision in the home (the
  // critic then reads the dispatch's PLAN.md, or stops), or the critic reading the in-memory plan instead of the manifest.
  it("plan-revise → plan-critique: the revision is PLAN.md's next edition in the task home and the next critic reads it through the manifest", async () => {
    const revised = "Write the fixture: create note.txt with the reviewed output and check it";
    const run = await runScenario({ settings: planner, critic: [rework(1), PASS], finish: true });
    const plans = run.manifest!.files.filter((row) => row.kind === "plan");
    expect(plans.map((row) => row.produced_by.node)).toEqual(["dispatch", "plan-revise"]);
    expect(run.manifest!.files.filter((row) => row.kind === "contract").map((row) => row.path)).toEqual(["contract.v1.json", "contract.v2.json"]);
    const current = plans.at(-1)!;
    expect(current).toMatchObject({ path: "PLAN.v2.md", supersedes: "PLAN.md" });
    expect(run.written.get(`${config.writerWorkspacePath}/.agents/tasks/${task.id}/PLAN.v2.md`)).toBe(`${revised}\n`);
    // The second critic's read is recorded on the revised PLAN.md, with the revised text's hash; the first critic read the dispatch's plan.
    const reads = run.manifest!.files.flatMap((row) => row.read_by.filter((read) => read.node === "plan-critique").map((read) => read.sha256));
    expect(reads).toEqual([createHash("sha256").update(`${PLAN}\n`).digest("hex"), current.sha256]);
    expect(current.sha256).toBe(createHash("sha256").update(`${revised}\n`).digest("hex"));
    expect((run.waited as { state: string }).state).toBe("accepted");
  }, 60_000);

  it("an info note does not hold the plan: a pass with an info finding goes to the writer, a return with only an info finding is answered by the planner; the PM gets nothing", async () => {
    const note = { file: "note.txt", line: 1, severity: "info", evidence: "PLAN: create note.txt", finding: "the note could end with a trailing newline" };
    const passed = await runScenario({ settings: planner, critic: [JSON.stringify({ status: "pass", summary: "the plan holds", evidence: "read the plan", findings: [note] })] });
    expect(passed.stages["plan-critique"]!.state).toBe("passed");
    expect(passed.plannerRounds).toBe(0);
    expect(passed.editions.map((row) => row.reason)).toEqual(["created"]);
    expect(toPm(passed)).toEqual([]);
    const returned = await runScenario({ settings: planner, critic: [JSON.stringify({ status: "rework", summary: "one note", evidence: "read the plan", findings: [note] }), PASS] });
    expect(returned.plannerRounds).toBe(1);
    expect(returned.editions.map((row) => row.reason)).toEqual(["created", "planner_revision:1/3"]);
    expect(returned.stages["plan-critique"]!.state).toBe("passed");
    expect(returned.everBlocked).toBe(false);
    expect(toPm(returned)).toEqual([]);
    // The planner is told a note is answered in the plan, never by sending it to the PM.
    expect(returned.spawned.find((row) => row.role === "planner")!.prompt).toContain("A finding of severity info is a note");
  }, 60_000);

  it("[sma:k_wp_revision] [sma:k_d_ref_gates] after the planner's last round the task goes to the PM with the findings of every round", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), rework(2), rework(3), rework(4)],
      planner: [revision("plan v2: write note.txt"), revision("plan v3: write note.txt and test it"), revision("plan v4: write note.txt, test it, read it back")] });
    // Three planner revisions, four critics (one per plan), then the PM.
    expect(run.editions.map((row) => row.reason)).toEqual(["created", "planner_revision:1/3", "planner_revision:2/3", "planner_revision:3/3"]);
    expect(run.criticThreads).toBe(4);
    expect(run.critiqueEvents).toBe(4);
    expect(run.attempt).toMatchObject({ state: "blocked" });
    expect(run.attempt!.reason).toMatch(/^planner_rounds_exhausted:3\/3: plan_critique_blocked/);
    const reply = blockedReply(run);
    expect(reply.plannerLoop).toMatchObject({ revisions: 3, maxRounds: 3, stopped: "rounds_exhausted" });
    expect(reply.plannerLoop!.rounds.map((row) => row.round)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(reply.plannerLoop!.rounds)).toMatch(/round 1: add a step[\s\S]*round 4: add a step/);
    expect(reply.plannerLoop!.note).toMatch(/planner used its 3 revision rounds/);
    // No writer ever started.
    expect(run.spawned.some((row) => row.role === "writer")).toBe(false);
  }, 60_000);

  it("plan_critique.max_rounds caps the planner's rounds", async () => {
    const run = await runScenario({ settings: { ...planner, "plan_critique.max_rounds": 1 }, critic: [rework(1), rework(2)] });
    expect(run.editions.map((row) => row.reason)).toEqual(["created", "planner_revision:1/1"]);
    expect(run.attempt!.reason).toMatch(/^planner_rounds_exhausted:1\/1/);
  }, 60_000);

  it("[sma:p2_issue_troubles] a structural finding in a field only the PM owns goes straight to the PM, without a planner round", async () => {
    // acceptance is the PM's (so are owns_paths, objective, never_touch, expected_outputs, risk and depends_on). An unresolved REPLACE_ME in it is
    // the plan critique's structural error (task_placeholder); the contract lint already refuses an expected output outside owns_paths and a
    // depends_on that names the task itself or closes a loop, before the critique.
    const run = await runScenario({ settings: planner, critic: [PASS], task: { acceptance: ["REPLACE_ME: the result the PM has not written yet"] } });
    expect(run.attempt).toMatchObject({ state: "blocked", reason: "structural_plan_critique_blocked" });
    expect(run.stages["plan-critique"]!.state).toBe("blocked");
    expect(run.editions.map((row) => row.reason)).toEqual(["created"]);
    expect(run.spawned.some((row) => row.role === "planner")).toBe(false);
    expect(run.steps.some((row) => row.node_id === "plan-revise")).toBe(false);
  }, 60_000);

  it("dispatch-bb --plan: the plan text is the task's plan and the critic's input, apart from the objective; without the flag the objective is the plan", async () => {
    const own = "Step 1: write note.txt with the reviewed output. Step 2: run the check.";
    const flagged = await runScenario({ settings: planner, critic: [PASS], cli: { plan: own } });
    expect(flagged.plan).toBe(own);
    const critic = flagged.spawned.find((row) => row.stageId === "plan-critique")!;
    expect(critic.prompt).toContain(own);
    expect(flagged.stages["plan-critique"]!.state).toBe("passed");
    const bare = await runScenario({ settings: planner, critic: [PASS], cli: {} });
    expect(bare.plan).toBe(task.objective);
    expect(bare.spawned.find((row) => row.stageId === "plan-critique")!.prompt).not.toContain(own);
  }, 60_000);

  it("plan_critique.revise_by pm keeps the old path: the return blocks for the PM at once", async () => {
    const run = await runScenario({ settings: { "plan_critique.revise_by": "pm" }, critic: [rework(1), PASS] });
    expect(run.attempt).toMatchObject({ state: "blocked", reason: "plan_critique_blocked" });
    expect(run.criticThreads).toBe(1);
    expect(run.spawned.some((row) => row.role === "planner")).toBe(false);
    expect(run.editions.map((row) => row.reason)).toEqual(["created"]);
    expect(blockedReply(run).plannerLoop).toBeUndefined();
    expect(run.stages["writer-agent"]!.state).toBe("skipped");
  }, 60_000);

  it("[sma:p2_checker] [sma:k_wp_checker] the second round goes on in the same planner session; every critic is a fresh session", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), rework(2), PASS],
      planner: [revision("plan v2: write note.txt"), revision("plan v3: write note.txt and test it")], finish: true });
    expect(run.spawned.filter((row) => row.role === "planner")).toHaveLength(1);
    expect(run.plannerRounds).toBe(2);
    // Round 2 is a message into the planner's own thread, naming the round and the new finding.
    const followUps = run.sends.filter((row) => row.threadId === "planner-thread");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.text).toMatch(/revision 2 of at most 3[\s\S]*round 2: add a step/);
    expect(run.spawned.filter((row) => row.stageId === "plan-critique")).toHaveLength(3);
    expect(run.sends.some((row) => row.threadId.startsWith("critic-thread-"))).toBe(false);
    expect(run.editions.map((row) => row.reason)).toEqual(["created", "planner_revision:1/3", "planner_revision:2/3"]);
    expect((run.waited as { state: string }).state).toBe("accepted");
  }, 60_000);

  it("quality_mode quick has no critic and so no planner loop", async () => {
    const run = await runScenario({ settings: { ...planner, quality_mode: "quick" }, critic: [rework(1)], finish: true });
    expect(run.stages["plan-critique"]).toMatchObject({ state: "skipped", reason: "quality_mode_quick" });
    expect(run.criticThreads).toBe(0);
    expect(run.spawned.some((row) => row.role === "planner")).toBe(false);
    expect((run.waited as { state: string }).state).toBe("accepted");
  }, 60_000);

  it("a medium task with 8 owns_paths gets the critic under plan_critique.min_owns_paths 8; with 7 it is below the threshold", async () => {
    const owns = (n: number) => ["note.txt", ...Array.from({ length: n - 1 }, (_, index) => `extra-${index + 1}.txt`)];
    const common = { "plan_critique.min_score": 7, "plan_critique.min_write_tasks": 3, "plan_critique.min_owns_paths": 8 };
    const eight = await runScenario({ settings: common, critic: [PASS], task: { risk: "medium", owns_paths: owns(8) } });
    expect(eight.stages["plan-critique"]!.state).toBe("passed");
    expect(eight.criticThreads).toBe(1);
    const seven = await runScenario({ settings: common, critic: [PASS], task: { risk: "medium", owns_paths: owns(7) } });
    expect(seven.stages["plan-critique"]).toMatchObject({ state: "skipped", reason: "below_critique_threshold" });
    expect(seven.criticThreads).toBe(0);
    // The policy itself: the default threshold is 8 (D1), 0 turns it off, and the reason names the count.
    expect(shouldRunPlanCritique({ taskRisk: "medium", tasks: [{ lane: "writer" }], ownsPaths: 8, minOwnsPaths: 8 })).toMatchObject({ run: true, reason: "8 owns_paths>=8" });
    expect(shouldRunPlanCritique({ taskRisk: "medium", tasks: [{ lane: "writer" }], ownsPaths: 8 })).toMatchObject({ run: true, reason: "8 owns_paths>=8" });
    expect(shouldRunPlanCritique({ taskRisk: "medium", tasks: [{ lane: "writer" }], ownsPaths: 7 })).toMatchObject({ run: false });
    expect(shouldRunPlanCritique({ taskRisk: "medium", tasks: [{ lane: "writer" }], ownsPaths: 27, minOwnsPaths: 0 })).toMatchObject({ run: false });
  }, 60_000);

  it("a planner that returns the same plan sends the task to the PM; the critic never sees the same plan twice", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), PASS], planner: [revision(PLAN)] });
    expect(run.criticThreads).toBe(1);
    expect(run.editions.map((row) => row.reason)).toEqual(["created"]);
    expect(run.attempt!.state).toBe("blocked");
    expect(run.attempt!.reason).toMatch(/^planner_stopped:planner_unchanged: plan_critique_blocked/);
    expect(blockedReply(run).plannerLoop).toMatchObject({ revisions: 0, stopped: expect.stringMatching(/^planner_unchanged/) });
  }, 60_000);

  it("a planner that needs a field only the PM owns sends the task to the PM", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), PASS], planner: [JSON.stringify({ edition_read: 1, needs_pm: "acceptance must name beta.md: change acceptance" })] });
    expect(run.criticThreads).toBe(1);
    expect(run.attempt!.reason).toMatch(/^planner_stopped:planner_needs_pm/);
    expect(JSON.stringify(blockedReply(run).plannerLoop)).toContain("acceptance must name beta.md");
  }, 60_000);

  it("a planner that takes the honest exit of the hand-off standard sends the task to the PM with what it lacked", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), PASS], planner: ['The checkout has no alpha.md. {"outcome": "blocked", "blocker": {"needs": "the file alpha.md", "from": "the PM"}, "handoff": "nothing"}'] });
    expect(run.attempt!.state).toBe("blocked");
    expect(run.attempt!.reason).toMatch(/^planner_stopped:planner_helper_blocked/);
    expect(JSON.stringify(blockedReply(run).plannerLoop)).toContain("needs the file alpha.md from the PM");
  });

  it("the PM's lane_pilot_update_task during the loop stops it: the planner's revision is not stored and later returns go to the PM", async () => {
    const run = await runScenario({ settings: planner, critic: [rework(1), rework(2), PASS], pmUpdatesDuringRound: true });
    // The PM's edition says it stopped the loop; no planner edition was written over it.
    expect(run.editions.map((row) => row.reason)).toEqual(["created", "pm_update:planner_loop_stopped"]);
    expect(run.plan).toBe("The PM's own plan: write note.txt");
    // The PM's plan was critiqued again (critic 2), returned, and the task went to the PM, not to the planner.
    expect(run.spawned.filter((row) => row.role === "planner")).toHaveLength(1);
    expect(run.criticThreads).toBe(2);
    expect(run.attempt).toMatchObject({ state: "blocked", reason: "plan_critique_blocked" });
  }, 60_000);
});

describe("the planner loop's settings and answer", () => {
  it("defaults (D1, since 0.1.567): the planner revises, three rounds at most; pm is the explicit opt-out", () => {
    expect(planReviseConfig({})).toEqual({ by: "planner", maxRounds: 3 });
    expect(planReviseConfig({ "plan_critique.revise_by": "planner", "plan_critique.max_rounds": 9 })).toEqual({ by: "planner", maxRounds: 3 });
    expect(planReviseConfig({ "plan_critique.revise_by": "pm", "plan_critique.max_rounds": 0 })).toEqual({ by: "pm", maxRounds: 1 });
    expect(planReviseConfig({ "plan_critique.revise_by": "nonsense" })).toEqual({ by: "planner", maxRounds: 3 });
  });

  it("reads the planner's answer: a plan with its edition, or needs_pm", () => {
    expect(parsePlanRevision('```json\n{"edition_read": 2, "plan": "new plan", "read_first": ["a.ts"]}\n```')).toMatchObject({ editionRead: 2, plan: "new plan", readFirst: ["a.ts"] });
    expect(parsePlanRevision('{"edition_read": 1, "needs_pm": "owns_paths lacks b.ts"}')).toMatchObject({ needsPm: "owns_paths lacks b.ts" });
    expect(() => parsePlanRevision('{"edition_read": 1}')).toThrow(/neither a plan nor needs_pm/);
  });
});
