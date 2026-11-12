import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { failureClassCooldownMs } from "../../src/rooms/contracts/failure-class";
import { backlogBoard, backlogMatches, type TodoMeta } from "../../src/rooms/backlog/logic";
import { proposeTaskWords } from "../../src/rooms/cockpit/ui/screens-work";
import { journalStoreInstall, STORE_JOURNAL } from "../../src/rooms/verification/git-integrate";
import { runRollbackCli } from "../../src/rooms/rollback/server/cli";
import { createRollback } from "../../src/rooms/rollback/server/rollback";
import { createDocsStage } from "../../src/rooms/docs/server/docs";
import { docsMaintenancePrompt } from "../../src/rooms/docs/docs";
import { attemptRecord } from "../../src/rooms/tools/server/receipts";
import { similarWorksLines } from "../../src/rooms/writer/server/writer-knowledge";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { failedTasksAllProjects, saveReasoningTrace, setRunThread, saveStageReceipt, appendGateEvaluation } from "../../src/rooms/storage";
import { upsertAttemptChange, appendTaskReceipt } from "../../src/rooms/rollback/store";
import { recordStage } from "../../src/rooms/runs/server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import type { TaskV2 } from "../../src/rooms/contracts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const contract: TaskV2 = {
  schema_version: 2, display_title: "Экспорт отчётов в CSV", kind: "feature", area: "feature:sma", id: "t1", title: "Экспорт отчётов в CSV ломается", risk: "low", lane: "writer", project_cwd: "/w",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["docs updated"],
  owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "починить экспорт CSV в отчётах", acceptance: ["done"],
  verify: "tests", verification: [],
};
const todo = (id: string, over: Partial<TodoMeta> = {}): TodoMeta =>
  ({ id, title: id, status: "ready", priority: "medium", estimate: 5, dependsOn: [], created: "2026-01-01", ...over });
const idleEvents = [
  { seq: 3, type: "turn/completed", createdAt: 2_000, threadId: "x", data: { status: "completed" } },
  { seq: 2, type: "turn/started", createdAt: 1_100, threadId: "x", data: {} },
  { seq: 1, type: "client/turn/requested", createdAt: 1_000, threadId: "x", data: {} },
];

describe("parity a6-misc", () => {
  it("[sma:ae_auto_retry] the pause after a repeated same-class failure doubles and stays under the cap", () => {
    expect(failureClassCooldownMs("merge", {}, 1)).toBe(30_000);
    expect(failureClassCooldownMs("merge", {}, 2)).toBe(60_000);
    expect(failureClassCooldownMs("merge", {}, 3)).toBe(120_000);
    expect(failureClassCooldownMs("infra", {}, 2)).toBe(120_000);
    expect(failureClassCooldownMs("merge", { "writer.cooldown_max_ms": 90_000 }, 3)).toBe(90_000);
    expect(failureClassCooldownMs("provider", {}, 5)).toBe(0);
  });

  it("[sma:m_in_priority] within one urgency band the smaller estimate comes first, and a lower band still comes after", () => {
    const big = todo("big", { estimate: 8, created: "2026-01-01" });
    const small = todo("small", { estimate: 2, created: "2026-06-01" });
    const low = todo("low", { estimate: 1, priority: "low", created: "2025-01-01" });
    expect(backlogBoard([big, low, small]).issuable.map((item) => item.id)).toEqual(["small", "big", "low"]);
  });

  it("[sma:m_sg_words] a phrase becomes a proposed title, description and promise by fixed rules", () => {
    const proposal = proposeTaskWords("Кнопка оплаты в корзине, чтобы покупатель видел итог до оплаты");
    expect(proposal.title).toBe("Кнопка оплаты в корзине");
    expect(proposal.title.length).toBeLessThanOrEqual(60);
    expect(proposal.promise).toHaveLength(1);
    expect(proposal.promise[0]).toMatch(/^Then /);
    expect(proposal.promise[0]).toContain("видел итог");
    const withPath = proposeTaskWords("Починить src/api/export.ts экспорт отчётов");
    expect(withPath.title).not.toContain("src/api");
    expect(proposeTaskWords("Когда покупатель платит, то заказ закрывается").promise[0]).toMatch(/^When .+, then /);
  });

  it("[sma:m_sg_breakdown] a phrase that repeats a backlog line is matched and asked about", () => {
    const items = [todo("csv-export", { title: "Экспорт отчётов в CSV ломается" }), todo("logo", { title: "Новый логотип", status: "open" })];
    expect(backlogMatches("починить экспорт CSV в отчётах", items).map((item) => item.id)).toEqual(["csv-export"]);
  });

  it("[sma:dt_bugs] two projects with a task each that failed twice give exactly two lines, one per task with its latest reason", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    for (const [projectId, taskId] of [["p1", "t1"], ["p2", "t2"]] as const) {
      createRun(database, `run-${taskId}`, projectId);
      createTask(database, { id: taskId, runId: `run-${taskId}`, kind: "bb", contract: {} });
      for (const [index, reason] of ["first boom", "second boom"].entries()) {
        const attemptId = `a-${taskId}-${index}`;
        createAttempt(database, { id: attemptId, runId: `run-${taskId}`, taskId });
        transitionAttempt(database, attemptId, "spawn_requested");
        transitionAttempt(database, attemptId, "running", { threadId: "thr" });
        transitionAttempt(database, attemptId, "validation_failed", { reason });
      }
    }
    const rows = failedTasksAllProjects(database, 0);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.projectId, row.taskId, row.reason]).sort()).toEqual([["p1", "t1", "second boom"], ["p2", "t2", "second boom"]]);
  });

  it("[sma:ap_run_dir] one call returns the whole record of an attempt and nothing of the task's other attempt", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    createRun(database, "run1", "p1");
    createTask(database, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    for (const id of ["a1", "a2"]) createAttempt(database, { id, runId: "run1", taskId: "t1" });
    transitionAttempt(database, "a1", "spawn_requested");
    transitionAttempt(database, "a1", "running", { threadId: "thr_w1" });
    saveStageReceipt(database, { runId: "run1", taskId: "t1", stageId: "verification", contractVersion: 1, state: "passed", inputSha256: "i1", outputSha256: null, attempt: 1, providerId: null, model: null, threadId: null, result: { checks: [{ command: "npm test", exitCode: 0 }] }, reason: null, updatedAt: 1 });
    saveStageReceipt(database, { runId: "run1", taskId: "t1", stageId: "code-critique", contractVersion: 1, state: "passed", inputSha256: "critic-hash-1", outputSha256: null, attempt: 1, providerId: null, model: null, threadId: null, result: null, reason: null, updatedAt: 1 });
    appendGateEvaluation(database, { projectId: "p1", runId: "run1", taskId: "t1", gate: "verification", status: "passed", inputSha256: "", outputSha256: "", attempt: 1, occurredAt: 1 });
    appendGateEvaluation(database, { projectId: "p1", runId: "run1", taskId: "t1", gate: "verification", status: "failed", inputSha256: "", outputSha256: "", attempt: 2, occurredAt: 2 });
    saveReasoningTrace(database, { planSha256: "p", sourceLength: 1,
      requestedReasoningLevel: "medium", effectiveReasoningLevel: "medium", fallbackReason: null, providerId: "x", model: "y", serviceTier: null,
      requestedServiceTier: "default", runId: "run1", attemptId: "a1", threadId: "thr_w1",
      dispatchContext: { memoryText: "", executionPacket: "packet-1", executionPacketSha256: "s", pmReadContext: "", agent: "w", helperMode: "auto", helperRequired: false } });
    upsertAttemptChange(database, { attemptId: "a1", runId: "run1", taskId: "t1" }, { outcome: "merged", mergeCommit: "abc", changed: [{ path: "src/a.ts", status: "modified" }] });
    const record = attemptRecord(database, "a1")!;
    expect(record.attempt.threadId).toBe("thr_w1");
    expect(record.stageReceipts.map((row) => row.stage).sort()).toEqual(["code-critique", "verification"]);
    expect(record.gateEvents).toHaveLength(1);
    expect(record.gateEvents[0]).toMatchObject({ gate: "verification", status: "passed", attempt: 1 });
    expect((record.dispatchContext as { executionPacket: string }).executionPacket).toBe("packet-1");
    expect((record.verification as { checks: Array<{ command: string }> }).checks[0]!.command).toBe("npm test");
    expect(record.criticInputHash).toBe("critic-hash-1");
    expect(record.change).toMatchObject({ outcome: "merged", mergeCommit: "abc" });
  });

  it("[sma:ap_similar] a writer brief carries at most five accepted similar works and no blocked one", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    createRun(database, "run1", "p1");
    for (let index = 0; index < 9; index++) {
      const taskId = `old-${index}`;
      createTask(database, { id: taskId, runId: "run1", kind: "bb",
        contract: { ...contract, id: taskId, title: `Экспорт отчётов в CSV ломается ${index}`, display_title: `Экспорт отчётов ${index}` } });
      const attemptId = `a-old-${index}`;
      createAttempt(database, { id: attemptId, runId: "run1", taskId });
      transitionAttempt(database, attemptId, "spawn_requested");
      transitionAttempt(database, attemptId, "running", { threadId: "thr" });
      transitionAttempt(database, attemptId, index < 7 ? "accepted" : "blocked", { reason: "nope" });
      upsertAttemptChange(database, { attemptId, runId: "run1", taskId }, { outcome: "merged", mergeCommit: "m", changed: [{ path: `src/f${index}.ts`, status: "modified" }] });
    }
    const text = await similarWorksLines(
      { db: database, host: {} as never, chainForRun: async () => [], log: () => undefined },
      { projectId: "p1", runId: "run1", hostId: "h", task: { ...contract, id: "new-task" } as TaskV2, memorySettings: { contextBudget: 3000 } as never },
      async () => ({ approach: "через поток записи" }));
    const listed = (text.match(/«/g) ?? []).length;
    expect(listed).toBe(5);
    expect(text).not.toContain("old-7");
    expect(text).not.toContain("old-8");
    expect(text).toContain("через поток записи");
    expect(text).toContain("src/f");
  });

  it("[sma:m_sg_clarify] the clarification graph proposes questions and writes nothing", () => {
    const workflow = builtinWorkflow("lp.clarify")!;
    expect(workflow).toMatchObject({ id: "lp.clarify", status: "published" });
    expect(JSON.stringify(workflow)).not.toContain("fs.write");
    expect(JSON.stringify(workflow)).not.toContain("lp-task");
    const agent = workflow.nodes.find((node) => node.type === "agent")!;
    expect(agent).toMatchObject({ role: "analyst" });
    expect(String((agent as { prompt?: string }).prompt)).toContain(".agents/plans/items");
    const emit = workflow.nodes.find((node) => (node as { action?: string }).action === "emit")!;
    expect((emit as { map?: Record<string, string> }).map).toMatchObject({ questions: "analyst.questions" });
  });

  it("[sma:k_lib_rollbackmark] a revert records only a stated cause; without one the status says cause unknown", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    createRun(database, "run1", "p1");
    appendTaskReceipt(database, { kind: "revert", projectId: "p1", runId: "run1", taskId: "t1", attemptId: "a1",
      baseSha: "b", changeSha: "c", resultCommit: "abc", state: "merged", summary: "s",
      detail: { rollbackMark: { cause: null, by: "cli", at: new Date().toISOString() } } });
    const api = createRollback({ db: database } as never, {} as never);
    expect(JSON.stringify(api.rollback.status("t1"))).toContain("cause unknown");
    appendTaskReceipt(database, { kind: "reverify", projectId: "p1", runId: "run1", taskId: "t1", attemptId: "a1",
      baseSha: "b", changeSha: "c", resultCommit: null, state: "passed", summary: "s", detail: {} });
    expect(JSON.stringify(api.rollback.status("t1"))).toContain("cause unknown");
    // --why is forwarded into the revert options.
    let seen: { why?: string; by?: string } = {};
    const stub = { reverify: async () => null, status: () => null,
      revert: async (_ref: string, options: { why?: string; by?: string }) => { seen = options; return { ok: true, state: "dry_run" }; } };
    await runRollbackCli(stub as never, "revert", ["t1", "--dry-run", "--why", "broke checkout"]);
    expect(seen).toMatchObject({ why: "broke checkout", by: "cli" });
  });

  it("[sma:k_lib_storejournal] each install into the store is journaled with who, when and what", async () => {
    const root = await mkdtemp(join(tmpdir(), "lp-store-"));
    try {
      await writeFile(join(root, "package-lock.json"), `{"lock":${Date.now()}}`);
      if (existsSync(STORE_JOURNAL)) rmSync(STORE_JOURNAL);
      await journalStoreInstall({ basePath: root, dir: root, command: "npm ci --no-audit --no-fund", trigger: "/tmp/wt-1", exitCode: 0 });
      const { readFileSync } = await import("node:fs");
      const [entry] = readFileSync(STORE_JOURNAL, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entry).toMatchObject({ basePath: root, dir: root, command: "npm ci --no-audit --no-fund", trigger: "/tmp/wt-1", exitCode: 0 });
      expect(entry!.lockSha256).toBe(sha(readFileSync(join(root, "package-lock.json"), "utf8")));
      expect(typeof entry!.at).toBe("string");
    } finally {
      await rm(root, { recursive: true, force: true });
      if (existsSync(STORE_JOURNAL)) rmSync(STORE_JOURNAL);
    }
  });

  it("[sma:m_in_scan] the board fetches before it reads and labels the data's age", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const calls: string[] = [];
    const { createBacklog } = await import("../../src/rooms/backlog/server/scanner");
    const database = openDatabase(bb);
    const { savePrototypeConfig } = await import("../../src/rooms/storage");
    savePrototypeConfig(database, { projectId: "p1", hostId: "h", writerWorkspacePath: "/w", pmWorkspacePath: "/w", pmProviderId: "x", pmModel: "y", writerProviderId: "x", writerModel: "y" } as never);
    const api = createBacklog({ db: database, bb: bb as never, isDisposed: () => false, log: () => undefined,
      host: { call: async (_m: string, input: { command?: string }) => {
        calls.push(input.command ?? "");
        if (input.command?.includes("git fetch")) return { exitCode: 0, stdout: "3", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      } } as never } as never);
    const board = await api.backlog.board("p1");
    expect(calls[0]).toContain("git fetch");
    expect(calls[1]).toContain("meta.yaml");
    expect(board.fetched).toBe(true);
    expect(board.behind).toBe(3);
    expect(typeof board.readAt).toBe("string");
    const failing = createBacklog({ db: database, bb: bb as never, isDisposed: () => false, log: () => undefined,
      host: { call: async () => ({ exitCode: 1, stdout: "", stderr: "" }) } as never } as never);
    expect((await failing.backlog.board("p1")).fetched).toBe(false);
  });

  it("[sma:bi_pause] holding a task of another run is refused, not reported as held", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    createRun(database, "run1", "p1");
    createRun(database, "run2", "p1");
    createTask(database, { id: "x", runId: "run2", kind: "bb", contract: {} });
    const rpc = cockpitRpc({ db: database, bb: bb as never } as never, {} as never) as Record<string, (input: unknown) => Promise<unknown>>;
    const answer = await rpc.cockpit_queue!({ runId: "run1", taskIds: ["x"], action: "hold" }) as { changed: string[]; refused: Array<{ taskId: string; why: string }> };
    expect(answer.changed).toEqual([]);
    expect(answer.refused).toEqual([{ taskId: "x", why: "not a task of run run1" }]);
    expect(database.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get("x")).toMatchObject({ held_until: null });
    const own = await rpc.cockpit_queue!({ runId: "run2", taskIds: ["x"], action: "hold" }) as { changed: string[] };
    expect(own.changed).toEqual(["x"]);
  });

  it("[sma:ag_doc_gate] docs edits commit only after a separate role passed them; the author's own thread refuses", async () => {
    const seed = (result: Record<string, unknown>) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
      const database = openDatabase(bb);
      createRun(database, "run1", "p1", "bb", "/w");
      setRunThread(database, "run1", "thr_pm");
      createTask(database, { id: "t1", runId: "run1", kind: "bb", contract });
      recordStage(database, { runId: "run1", taskId: "t1", stageId: "acceptance-receipt", state: "passed", input: "i" });
      const snapshot = { pages: [{ path: "docs/a.md", modifiedAt: 1, content: "# A", sha256: sha("# A") }], since: "yesterday", truncated: false, inputSha256: "x", pageCap: 0 };
      recordStage(database, { runId: "run1", taskId: "t1", stageId: "docs-maintenance", state: "running", input: "i", threadId: "thr_author",
        result: { snapshot, ...result } });
      return { bb, harness, database, snapshot };
    };
    const ctxOf = (bb: never, database: never, outputs: Record<string, string>, writes: string[]) => ({
      bb, db: database, isDisposed: () => false, log: () => undefined,
      host: { call: async (method: string) => method === "gitCommitDocs" ? { status: "committed", commit: "abc123" } : {} },
      acceptedTaskWorkspace: () => ({ task: { ...contract, project_cwd: "/w" }, path: "/w", environmentId: null }),
      workspaceExecutionEnvironment: () => ({}),
      configForRun: async () => ({ hostId: "h" }),
      realtime: { notify: () => undefined },
    });
    const sdkFor = (harness: { sdk: { stub: (name: string, fn: unknown) => void } }, outputs: Record<string, string>, writes: string[]) => {
      harness.sdk.stub("threads.get", async () => ({ id: "x", status: "idle", projectId: "p1" }));
      harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => idleEvents.map((event) => ({ ...event, threadId })));
      harness.sdk.stub("threads.queue.list", async () => []);
      harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_pm" ? { role: "pm", lanePilotRunId: "run1" } : {});
      harness.sdk.stub("threads.output", async ({ threadId }: { threadId: string }) => ({ output: outputs[threadId] ?? "" }));
      harness.sdk.stub("files.write", async (args: { path: string }) => { writes.push(args.path); return {}; });
      harness.sdk.stub("files.read", async () => ({ content: "# A2" }));
    };
    const editsOut = JSON.stringify([{ path: "docs/a.md", expectedSha256: sha("# A"), content: "# A2" }]);
    const services = { stageHelperSettings: async () => ({ "docs.review": "gate" }), docsVerdict: async () => ({ need: true }), reconcileDocsChild: async () => ({ kind: "not_found" }) };

    // With docs.review = off the pass writes as before: no reviewer is asked, nothing is committed by the stage.
    {
      const { bb, harness, database } = seed({});
      const writes: string[] = [];
      sdkFor(harness as never, { thr_author: editsOut }, writes);
      const stage = createDocsStage(ctxOf(bb as never, database as never, {}, writes) as never, { ...services, stageHelperSettings: async () => ({ "docs.review": "off" }) } as never);
      const answer = await stage.runDocsMaintenance({ threadId: "thr_pm", projectId: "p1", runId: "run1", taskId: "t1", timeoutSec: 1 });
      expect(answer.state).toBe("passed");
      expect(writes).toEqual(["/w/docs/a.md"]);
      expect((answer.result as { commit?: string }).commit).toBeUndefined();
    }

    // The reviewer is the author's own thread: refused, nothing written.
    {
      const { bb, harness, database } = seed({ review: { threadId: "thr_author" } });
      const writes: string[] = [];
      sdkFor(harness as never, { thr_author: editsOut }, writes);
      const stage = createDocsStage(ctxOf(bb as never, database as never, {}, writes) as never, services as never);
      const answer = await stage.runDocsMaintenance({ threadId: "thr_pm", projectId: "p1", runId: "run1", taskId: "t1", timeoutSec: 1 });
      expect(answer.state).toBe("failed");
      expect(answer.reason).toBe("docs_review_same_role");
      expect(writes).toEqual([]);
    }
    // A separate reviewer's pass: the page is written and committed, the receipt names both roles.
    {
      const { bb, harness, database } = seed({ review: { threadId: "thr_review", role: "auditor" } });
      const writes: string[] = [];
      sdkFor(harness as never, { thr_author: editsOut, thr_review: JSON.stringify({ verdict: "pass" }) }, writes);
      const stage = createDocsStage(ctxOf(bb as never, database as never, {}, writes) as never, services as never);
      const answer = await stage.runDocsMaintenance({ threadId: "thr_pm", projectId: "p1", runId: "run1", taskId: "t1", timeoutSec: 1 });
      expect(answer.state).toBe("passed");
      expect(writes).toEqual(["/w/docs/a.md"]);
      const result = answer.result as { commit: string; roles: { author: string; reviewer: string } };
      expect(result.commit).toBe("abc123");
      expect(result.roles).toEqual({ author: "docs-maintainer", reviewer: "auditor" });
    }
    // One rework round, then the owner item (SMA ag_doc_gate): a receipt that already holds rework.round 1 gets no
    // second round — the refusal fails the pass and writes nothing.
    {
      const { bb, harness, database } = seed({ review: { threadId: "thr_review", role: "auditor" }, rework: { round: 1 } });
      const writes: string[] = [];
      sdkFor(harness as never, { thr_author: editsOut, thr_review: JSON.stringify({ verdict: "changes", notes: "still no citations" }) }, writes);
      const stage = createDocsStage(ctxOf(bb as never, database as never, {}, writes) as never, services as never);
      const answer = await stage.runDocsMaintenance({ threadId: "thr_pm", projectId: "p1", runId: "run1", taskId: "t1", timeoutSec: 1 });
      expect(answer.state).toBe("failed");
      expect(answer.reason).toMatch(/^docs_review_refused/);
      expect(writes).toEqual([]);
    }
    // The rework round itself: the reviewer's notes go back to the maintainer in the one round there is (prompt level).
    expect(docsMaintenancePrompt({ since: "yesterday", pages: [], pageCap: 3, reviewNotes: "cite file:line" })).toContain("cite file:line");
  });
});
