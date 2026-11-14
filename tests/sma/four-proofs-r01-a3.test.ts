// Region 1 (Task graph), batch a: the four proofs for the baseline (ac_baseline, ac_baseline_red, ae_preflight), the permit channel
// (ac_channel) and the writer's question (ae_awaits, ag_parked). Real git for the baseline, a scratch HOME for the ticket folder.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { getBaseline } from "../../src/rooms/baseline";
import { closeOwnerItem, listOpenOwnerItemKeys } from "../../src/rooms/owner-waiting";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { onAttemptFinished, type AttemptFinished } from "../../src/rooms/writer/server/attempt-finished";
import { createWriterFinish } from "../../src/rooms/writer/server/finish";
import { world } from "../baseline/world";
import { config, contract } from "./r01-world-a";

vi.setConfig({ testTimeout: 180_000 });
const sentText = (w: Awaited<ReturnType<typeof world>>, index = 0) => (w.send.mock.calls[index] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;

describe("[sma:ac_baseline] the promised checks run before any work", () => {
  it("[sma:ac_baseline] before the first attempt the task's checks run on the base in a throwaway copy: each answer is recorded green or red for its command, and the copy is gone", async () => {
    const w = await world();
    const before = w.worktrees();
    const input = w.pendingTask("t1", ["test -f keep.txt", "grep -q no-such-line server.ts"]);
    const result = await w.services.baseline.preflight(input);
    expect(result.stop).toBeNull();
    expect(result.record).toMatchObject({ state: "ran", verdict: "partial", action: "proceed" });
    expect(result.record!.checks.map((check) => [check.command, check.status])).toEqual([["test -f keep.txt", "green"], ["grep -q no-such-line server.ts", "red"]]);
    expect(result.record!.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(getBaseline(w.db, "run1", "t1")!.checks).toHaveLength(2);
    expect(w.worktrees()).toBe(before);
    await w.dispose();
  });
});

describe("[sma:ac_baseline_red] only a person decides to proceed on a red baseline", () => {
  it("[sma:ac_baseline_red] a check red in files the task does not own stops the start and asks the owner; his yes on the item lets the family start", async () => {
    const w = await world({ settings: { "owner.words": "on" } });
    const red = "printf 'FAIL %s\\n' src/oth''er/legacy.test.ts >&2; exit 1";
    const input = { ...w.pendingTask("t1", [red]), task: { ...(w.pendingTask("t2", [red]).task as object), id: "t1", owns_paths: ["src/mine/**"], kind: "feature" } as never };
    const stopped = await w.services.baseline.preflight(input);
    expect(stopped.stop).toMatch(/^verdict_block: red_outside_task: .*red in src\/other\/legacy\.test\.ts/);
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ action: "stopped" });
    expect(listOpenOwnerItemKeys(w.db, { kind: "baseline_red" })).toEqual(["baseline-red:run1:t1"]);
    // Asked again with no word: still stopped. His yes: the same task starts.
    expect((await w.services.baseline.preflight(input)).stop).toMatch(/red_outside_task/);
    closeOwnerItem(w.db as never, "baseline-red:run1:t1", "owner:yes");
    expect((await w.services.baseline.preflight(input)).stop).toBeNull();
    await w.dispose();
  });
});

describe("[sma:ae_preflight] closed without a worker", () => {
  it("[sma:ae_preflight] a check task whose checks are all green on the base is closed «already done» with the PM told, a feature with the same checks is not", async () => {
    const w = await world();
    const check = { ...w.pendingTask("c1", ["true"]) };
    check.task = { ...(check.task as object), kind: "check" } as never;
    const done = await w.services.baseline.preflight(check);
    expect(done.stop).toBeNull();
    expect(done.alreadyDone).toMatch(/^already done: /);
    expect(done.record).toMatchObject({ action: "notified" });
    expect(sentText(w)).toContain("задача c1 закрыта принятой без писателя — все 1 проверок(и) уже зелёные на базе");
    const feature = w.pendingTask("f1", ["true"]);
    feature.task = { ...(feature.task as object), kind: "feature" } as never;
    expect((await w.services.baseline.preflight(feature)).alreadyDone).toBeUndefined();
    await w.dispose();
  });
});

describe("[sma:ac_channel] the permit channel on the worker's machine", () => {
  it("[sma:ac_channel] the machine lists the unanswered, unexpired tickets of its writers with category, command and folder, and nothing it has an answer for", async () => {
    const { listPermitTickets, answerPermit } = await import("../../src/rooms/host-worker/host-handlers");
    const home = mkdtempSync(join(tmpdir(), "lp-r01a-permits-"));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = join(home, ".agents", "permits", "sess1");
      mkdirSync(dir, { recursive: true });
      const now = Date.now() / 1000;
      writeFileSync(join(dir, "a1b2c3d4e5f60718.ticket.json"), JSON.stringify({ category: "delete", command: "rm -rf build", cwd: "/w", at: now }));
      writeFileSync(join(dir, "0011223344556677.ticket.json"), JSON.stringify({ category: "sql", command: "DROP TABLE x", cwd: "/w", at: now }));
      writeFileSync(join(dir, "ffeeddccbbaa9988.ticket.json"), JSON.stringify({ category: "delete", command: "rm old", cwd: "/w", at: now - 30 * 86_400 }));
      const listed = await listPermitTickets({ requestedHostId: "h" } as never, {} as never);
      expect(listed.tickets.map((ticket) => [ticket.ticket, ticket.category, ticket.command, ticket.cwd]).sort())
        .toEqual([["0011223344556677", "sql", "DROP TABLE x", "/w"], ["a1b2c3d4e5f60718", "delete", "rm -rf build", "/w"]]);
      // The PM's answer takes one ticket out of the list; the other stays.
      expect((await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "a1b2c3d4e5f60718", decision: "allow", why: "build output" } as never, {} as never)).written).toBe(true);
      expect((await listPermitTickets({ requestedHostId: "h" } as never, {} as never)).tickets.map((ticket) => ticket.ticket)).toEqual(["0011223344556677"]);
    } finally { process.env.HOME = before; }
  });
});

describe("[sma:ae_awaits] [sma:ag_parked] a writer's question parks the attempt for a person", () => {
  function finishWorld(answer: string) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const task = contract("t1");
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    const writes: Array<{ path: string; content: string }> = [];
    const ctx = { state: { disposed: false }, bb: { storage: bb.storage, log: { warn() {}, error() {} }, sdk: { threads: { stop: async () => undefined, events: { list: async () => [] }, get: async () => ({ status: "idle" }), output: async () => ({ text: answer }) },
      files: { read: async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); }, write: async (args: { path: string; content: string }) => { writes.push(args); } } } },
      db, getThreadBounded: async () => ({ status: "idle" }), host: { call: async () => ({}) }, isDisposed: () => false, log: () => undefined };
    const finish = createWriterFinish(ctx as never, { validateWriterResult: async () => ({ status: "accepted" }), workspaceDirt: async () => ({ ok: true, snapshots: [] }), runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }) } as never);
    return { db, writes, ctx, run: () => finish.finishWriterAttempt({ projectId: "P", config, task, runId: "run", taskId: "t1", attemptId: "a1", pmThreadId: "pm", writerThreadId: "writer-1", dirtBefore: [] }) };
  }

  it("[sma:ae_awaits] [sma:ag_parked] an answer that is a question ends the attempt blocked with the question as its reason, skips the accept gate, and saves the question as a file with its answer open", async () => {
    const w = finishWorld("`NEEDS_HUMAN: which locale should the totals use?`");
    expect(await w.run()).toMatchObject({ status: "blocked", reason: "needs_human: which locale should the totals use?" });
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "blocked", reason: "needs_human: which locale should the totals use?" });
    expect(w.db.prepare("SELECT status FROM lane_pilot_gate_event WHERE task_id='t1' AND gate='accept'").all()).toEqual([{ status: "skipped" }]);
    const qa = w.writes.find((write) => write.path.endsWith("QA.md"));
    expect(qa?.content).toContain("Q (writer): which locale should the totals use?");
    expect(qa?.content).toContain("A: open — the writer is parked here");
    expect(listOpenOwnerItemKeys(w.db, {})).toEqual([]);
  });

  it("[sma:ae_complete] a finished attempt reaches the attempt-finished readers under its own task, with the answer's status, reason and the result record, while its row waits for a person", async () => {
    const w = finishWorld("`NEEDS_HUMAN: which locale?`\nAPPROACH: ask first\nLESSON: the locale is not in the contract");
    const heard: AttemptFinished[] = [];
    onAttemptFinished(w.ctx as never, (event) => { heard.push(event); }, "probe");
    const result = await w.run();
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ scope: "attempt", runId: "run", taskId: "t1", attemptId: "a1", status: "blocked", reason: "needs_human: which locale?" });
    expect(heard[0]!.result).toBe(result);
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "blocked", reason: "needs_human: which locale?" });
  });
});
