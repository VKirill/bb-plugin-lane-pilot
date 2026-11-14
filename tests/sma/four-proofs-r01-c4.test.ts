// Region 1 · Task graph, batch c (fourth file): the running session and its ends (as_stream, as_continue, as_ticket, as_stop_door, as_pause_marker, as_effect_observe, as_usage, av_barrier).
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { createAttemptReopen, contractFixTurnPrompt } from "../../src/rooms/writer/server/reopen-attempt";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { needsHumanQuestion } from "../../src/rooms/writer/server/writer-task";
import { gitUndoCheckWrites } from "../../src/rooms/host-worker/handlers/git";
import { acceptanceProofGap } from "../../packages/contracts/src/stage-proof";
import { ATTEMPT_STREAM_EXCERPT_CHARS, noteAttemptStream, getReasoningTrace, saveReasoningTrace, createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { openTokenCursor, tokenCursorRow } from "../../src/rooms/usage/server/token-usage";
import { useGuardSync } from "../guard-pool";
import { hookEnv } from "../hook-env";
import { config, git, scratchRepo, taskOf } from "./r01-world-c";

function runWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: Array<{ threadId: string; text: string }> = [];
  const stops: string[] = [];
  harness.sdk.stub("threads.listRunning", async () => []);
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
  harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return undefined; });
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
  harness.sdk.stub("files.write", async () => ({}));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", "/ws");
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const task = taskOf("T1");
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(db, "T1", "Plan for T1");
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
  setAttemptWorkspace(db, "a1", { path: "/wt/T1", environmentId: null, decision: {} });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  return { bb, harness, db, ctx, sent, stops, task };
}

describe("the running session", () => {
  it("[sma:as_stream] what a session said is kept on the attempt as a masked, bounded excerpt: a credential that stands across the cut is masked before the cut, and the hash and length are of the whole text", () => {
    const { db } = runWorld();
    saveReasoningTrace(db, { planSha256: "p", sourceLength: 1, jevStatus: "ok", jevDecision: null, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null,
      providerId: "p", model: "wm", runId: "run1", attemptId: "a1", threadId: "thr_w" } as never);
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const text = `${"x".repeat(ATTEMPT_STREAM_EXCERPT_CHARS - 10)} token ${secret} and more words after it`;
    noteAttemptStream(db, "a1", text);
    const stream = (getReasoningTrace(db, "a1") as { stream?: { sha256: string; chars: number; excerpt: string } }).stream!;
    expect(stream.chars).toBe(text.length);
    expect(stream.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stream.excerpt.length).toBeLessThanOrEqual(ATTEMPT_STREAM_EXCERPT_CHARS);
    expect(stream.excerpt).not.toContain("ghp_");
    expect(stream.excerpt).not.toContain("a1B2a1B2");
    expect(stream.excerpt.startsWith("xxxx")).toBe(true);
    // A short stream is kept whole; an attempt with no trace keeps nothing and does not fail.
    noteAttemptStream(db, "a1", "all fine");
    expect((getReasoningTrace(db, "a1") as { stream?: { excerpt: string; chars: number } }).stream).toMatchObject({ excerpt: "all fine", chars: 8 });
    expect(() => noteAttemptStream(db, "ghost", "x")).not.toThrow();
    expect(getReasoningTrace(db, "ghost")).toBeNull();
  });

  it("[sma:as_continue] a blocked writer's question is answered in its own thread and worktree: the turn goes in, the attempt runs again, no new attempt is made, and the writer task restarts on the same thread", async () => {
    const w = runWorld();
    transitionAttempt(w.db, "a1", "blocked", { threadId: "thr_w", reason: "needs_human: which locale?" });
    const startWriterTask = vi.fn();
    const reopen = createAttemptReopen(w.ctx, { activeWriterTasks: new Set<string>(), startWriterTask } as never);
    const attempt = getAttempt(w.db, "a1")!;
    const turn = contractFixTurnPrompt({ question: "which locale?", changes: [{ field: "acceptance", from: ["done"], to: ["done in ru"] }] });
    const checked = await reopen.checkReopenable({ runId: "run1", taskId: "T1", run: { writer_workspace_path: "/ws" } as never, attempt });
    expect(checked).toEqual({ ok: true, threadId: "thr_w", workspacePath: "/ws" });
    const out = await reopen.reopenAttempt({ projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: "thr_pm", attempt, threadId: "thr_w", workspacePath: "/ws",
      config, contract: w.task, reason: "answered", turn, qaAnswer: "ru" });
    expect(out).toEqual({ ok: true });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.threadId).toBe("thr_w");
    expect(w.sent[0]!.text).toContain("- acceptance: [\"done\"] → [\"done in ru\"]");
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "running", thread_id: "thr_w" });
    expect(startWriterTask).toHaveBeenCalledTimes(1);
    expect(startWriterTask.mock.calls[0]![0]).toMatchObject({ runId: "run1", taskId: "T1", firstAttemptId: "a1", writerThreadId: "thr_w", turnSent: true });
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE task_id='T1'").get() as { n: number }).n).toBe(1);
  });

  it("[sma:as_continue] a turn that cannot be delivered leaves the attempt blocked on the same question, and a writer that is still finishing is not reopened", async () => {
    const w = runWorld();
    transitionAttempt(w.db, "a1", "blocked", { threadId: "thr_w", reason: "needs_human: which locale?" });
    w.harness.sdk.stub("threads.send", async () => { throw new Error("thread gone"); });
    const startWriterTask = vi.fn();
    const active = new Set<string>();
    const reopen = createAttemptReopen(w.ctx, { activeWriterTasks: active, startWriterTask } as never);
    const attempt = getAttempt(w.db, "a1")!;
    const out = await reopen.reopenAttempt({ projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: "thr_pm", attempt, threadId: "thr_w", workspacePath: "/ws",
      config, contract: w.task, reason: "answered", turn: "t", qaAnswer: "ru" });
    expect(out).toMatchObject({ ok: false });
    expect((out as { hint: string }).hint).toContain("the turn could not be delivered to the writer thread (thread gone); the task stays blocked");
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "blocked", reason: "needs_human: which locale?" });
    expect(startWriterTask).not.toHaveBeenCalled();
    active.add("run1:T1");
    expect(await reopen.checkReopenable({ runId: "run1", taskId: "T1", run: { writer_workspace_path: "/ws" } as never, attempt })).toEqual({ ok: false, hint: "the task's writer is still finishing; poll lane_pilot_wait_writer first" });
  });
});

describe("the dangerous-call gate", () => {
  const guard = useGuardSync(join(process.cwd(), "lane-stack/hooks/guard_shell.py"));
  const call = (home: string, cwd: string, command: string) => guard({
    input: JSON.stringify({ agent_type: "writer", tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess_c", }),
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude", HOME: home, LANE_PILOT_ROLE: "writer", LANE_PILOT_AGENT_TYPE: "writer" }),
  });
  const tickets = (home: string) => { try { return readdirSync(join(home, ".agents", "permits", "sess_c")).filter((name) => name.endsWith(".ticket.json")).sort(); } catch { return []; } };

  it("[sma:as_ticket] a dangerous call is refused and a ticket is filed once; the PM's one-time grant lets the very same command through once, a grant for another directory does not count, a refusal is carried to the worker", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "sma-ticket-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sma-ticket-cwd-")));
    const other = realpathSync(mkdtempSync(join(tmpdir(), "sma-ticket-other-")));
    const command = "rm data.csv";
    const first = call(home, cwd, command);
    expect(first.status).not.toBe(0);
    const files = tickets(home);
    expect(files).toHaveLength(1);
    const digest = files[0]!.replace(".ticket.json", "");
    expect(first.stdout).toContain(`Permit ticket ${digest} is filed: Lane Pilot hands it to the PM; when it is granted, run the same command again (once).`);
    const ticket = JSON.parse(readFileSync(join(home, ".agents", "permits", "sess_c", files[0]!), "utf8"));
    expect(ticket).toMatchObject({ ticket: digest, command, cwd });
    // Asked again with no answer: still refused, no second ticket.
    expect(call(home, cwd, command).status).not.toBe(0);
    expect(tickets(home)).toHaveLength(1);
    // The same command from another directory is another ticket.
    expect(call(home, other, command).status).not.toBe(0);
    expect(tickets(home)).toHaveLength(2);
    // The PM grants the first one: it goes through once, and the permit is marked used.
    const answer = join(home, ".agents", "permits", "sess_c", `${digest}.answer.json`);
    writeFileSync(answer, JSON.stringify({ decision: "allow", at: Date.now() / 1000 + 1 }));
    const granted = call(home, cwd, command);
    expect(granted.status).toBe(0);
    expect(granted.stdout).toBe("");
    expect(JSON.parse(readFileSync(answer, "utf8")).used).toBeGreaterThan(0);
    const again = call(home, cwd, command);
    expect(again.status).not.toBe(0);
    expect(again.stdout).toContain("is filed");
    // A refusal by the PM is carried to the worker with its reason.
    writeFileSync(answer, JSON.stringify({ decision: "deny", why: "keep the export", at: Date.now() / 1000 + 2 }));
    const denied = call(home, cwd, command);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toContain("The PM refused this permit: keep the export");
  });
});

describe("the ends of a session", () => {
  it("[sma:as_stop_door] a stop from a door cancels the running attempt once its writer is observed gone: the thread is stopped, the work on record, the open writer stages canceled, the attempt canceled with the door's code; an attempt that had already ended is closed without a stop", async () => {
    const w = runWorld();
    for (const stage of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(w.db, { runId: "run1", taskId: "T1", stageId: stage, state: "pending", input: "Plan for T1" });
    const noted: string[] = [];
    const rollback = { noteStopped: async (id: string) => { noted.push(id); return { recorded: true }; } };
    const out = await cancelAttemptById({ bb: w.bb, db: w.db, cancelQueuedAttempt: () => ({ ok: false, state: "x", reason: "unused" }) } as never, "a1", rollback, "the owner pressed stop", "owner_cancel");
    expect(out).toEqual({ ok: true, state: "canceled", reason: null });
    expect(w.stops).toEqual(["thr_w"]);
    expect(noted).toEqual(["a1"]);
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "canceled", reason: "the owner pressed stop" });
    const stages = Object.fromEntries(listStageReceipts(w.db, "run1", "T1").map((row) => [row.stageId, row.state]));
    expect(stages).toMatchObject({ "writer-agent": "canceled", verification: "canceled", "acceptance-receipt": "canceled" });
    // A work that is not on record after the stop is not reported complete.
    const w2 = runWorld();
    const failing = { noteStopped: async () => ({ recorded: false, error: "git did not answer" }) };
    const half = await cancelAttemptById({ bb: w2.bb, db: w2.db, cancelQueuedAttempt: () => ({ ok: false, state: "x", reason: "unused" }) } as never, "a1", failing, undefined, "unknown");
    expect(half).toEqual({ ok: false, state: "canceled", reason: "writer stopped, but what its worktree holds is not on record: git did not answer" });
    // An attempt that ended on its own is closed, no thread is stopped.
    const w3 = runWorld();
    transitionAttempt(w3.db, "a1", "blocked", { threadId: "thr_w", reason: "needs_human: q" });
    const closed = await cancelAttemptById({ bb: w3.bb, db: w3.db, cancelQueuedAttempt: () => ({ ok: false, state: "x", reason: "unused" }) } as never, "a1");
    expect(closed).toMatchObject({ ok: true, state: "canceled" });
    expect(w3.stops).toEqual([]);
    expect(getAttempt(w3.db, "a1")?.state).toBe("canceled");
  });

  it("[sma:as_pause_marker] the writer's first line says it stopped for a person's word: ASK_PM: or the old NEEDS_HUMAN: in any case, even in backticks or bold, and the question is what follows, cleaned and bounded; any other answer is no pause", () => {
    expect(needsHumanQuestion("NEEDS_HUMAN: which locale?\nmore text")).toBe("which locale?");
    expect(needsHumanQuestion("ASK_PM: may I edit tests/a.test.ts?")).toBe("may I edit tests/a.test.ts?");
    expect(needsHumanQuestion("needs_human: lower case marker")).toBe("lower case marker");
    expect(needsHumanQuestion("`NEEDS_HUMAN: may I edit `a.ts`?`")).toBe("may I edit `a.ts`?");
    expect(needsHumanQuestion("**ASK_PM:** which one\n")).toBe("which one");
    expect(needsHumanQuestion("  \n  NEEDS_HUMAN:   spaced\n   out  ")).toBe("spaced");
    expect(needsHumanQuestion("ASK_PM:")).toBe("the writer stopped without a question");
    expect(needsHumanQuestion(`ASK_PM: ${"q".repeat(900)}`)).toBe("q".repeat(600));
    expect(needsHumanQuestion("I did it.\nASK_PM: not first")).toBeNull();
    expect(needsHumanQuestion("Done: changed src/a.ts")).toBeNull();
  });

  it("[sma:as_effect_observe] after the checks, files they wrote outside the task's owns_paths are undone, tracked ones restored and new ones removed, while the task's own files and the listed ones stay", async () => {
    const { base } = scratchRepo();
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, "docs"), { recursive: true });
    writeFileSync(join(base, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(base, "docs", "x.md"), "original\n");
    git(base, "add", "-A");
    git(base, "commit", "-qm", "files");
    // What the checks left behind: a tracked file changed outside owns, a new report file outside owns, the task's own new file, a file the caller keeps.
    writeFileSync(join(base, "docs", "x.md"), "changed by a check\n");
    mkdirSync(join(base, "reports"), { recursive: true });
    writeFileSync(join(base, "reports", "out.js"), "built\n");
    writeFileSync(join(base, "src", "new.ts"), "export const n = 1;\n");
    writeFileSync(join(base, "docs", "keep.txt"), "kept by the caller\n");
    const out = await gitUndoCheckWrites({ requestedHostId: "h", projectCwd: base, keep: ["docs/keep.txt"], ownsPaths: ["src/"], neverTouch: [], bookkeeping: [] } as never, {} as never);
    expect([...(out as { reverted: string[] }).reverted].sort()).toEqual(["docs/x.md", "reports/out.js"]);
    expect((out as { failed: string[] }).failed).toEqual([]);
    expect(readFileSync(join(base, "docs", "x.md"), "utf8")).toBe("original\n");
    expect(() => readFileSync(join(base, "reports", "out.js"), "utf8")).toThrow();
    expect(readFileSync(join(base, "src", "new.ts"), "utf8")).toBe("export const n = 1;\n");
    expect(readFileSync(join(base, "docs", "keep.txt"), "utf8")).toBe("kept by the caller\n");
    // A file the contract forbids is undone even inside owns_paths.
    writeFileSync(join(base, "src", "secret.env"), "k=v\n");
    const forbidden = await gitUndoCheckWrites({ requestedHostId: "h", projectCwd: base, keep: [], ownsPaths: ["src/"], neverTouch: ["src/secret.env"], bookkeeping: [] } as never, {} as never);
    expect((forbidden as { reverted: string[] }).reverted).toContain("src/secret.env");
  });

  it("[sma:as_usage] a spend row exists for the session's thread from its first second with zero totals, and a later open does not reset what the sync booked", () => {
    const { db } = runWorld();
    openTokenCursor(db, { threadId: "thr_w", projectId: "proj1", providerId: "codex", at: 5 });
    expect(tokenCursorRow(db, "thr_w")).toMatchObject({ provider_id: "codex" });
    expect(JSON.parse(tokenCursorRow(db, "thr_w")!.total_json)).toEqual({});
    // The sync books the first turn's totals; a second open (a reload, a re-spawn) keeps them.
    db.prepare("UPDATE lane_pilot_token_cursor SET total_json=?, last_model='gpt' WHERE thread_id=?").run(JSON.stringify({ input: 10, output: 4, total: 14 }), "thr_w");
    openTokenCursor(db, { threadId: "thr_w", projectId: "other", providerId: "other" });
    expect(tokenCursorRow(db, "thr_w")).toMatchObject({ provider_id: "codex", last_model: "gpt" });
    expect(JSON.parse(tokenCursorRow(db, "thr_w")!.total_json)).toEqual({ input: 10, output: 4, total: 14 });
  });
});

describe("the barrier before acceptance", () => {
  it("[sma:av_barrier] a handed-in work is accepted only on a stage decided by code: the model's opinions alone, or nothing, are refused with the stages named; a passing check, the gate on the files or a receipt is enough", () => {
    expect(acceptanceProofGap(["code-critique"])).toBe("acceptance_without_code_proof: only advisory stages passed (code-critique); a model's opinion cannot accept a task on its own");
    expect(acceptanceProofGap(["pm-read", "code-critique", "code-critique", "plan-critique"])).toBe("acceptance_without_code_proof: only advisory stages passed (pm-read, code-critique, plan-critique); a model's opinion cannot accept a task on its own");
    expect(acceptanceProofGap([])).toBe("acceptance_without_code_proof: no stage passed");
    expect(acceptanceProofGap(["verification"])).toBeNull();
    expect(acceptanceProofGap(["code-critique", "verification"])).toBeNull();
    expect(acceptanceProofGap(["writer-agent"])).toBeNull();
    expect(acceptanceProofGap(["acceptance-receipt", "pm-read"])).toBeNull();
  });
});
