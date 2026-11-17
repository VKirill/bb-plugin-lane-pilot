import { createFakePluginHost, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { closeRun, createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { PROVIDER_RETRY_CONSENT_METHOD, createProviderRetryGuard, retryEligibility } from "../../src/rooms/stability/server/provider-retry";

type Row = ReturnType<typeof makeQueueEntry>;
const retryRow = (id: string, threadId: string): Row => makeQueueEntry({ id, threadId, sendAt: Date.now() + 3600_000, payload: { kind: "retry", attempt: 1, reason: "Rate limited", retryOfTurnRequestId: "req-1" } });
const inlineRow = (id: string, threadId: string): Row => makeQueueEntry({ id, threadId, payload: { kind: "inline" } });

function setup(rows: Row[], options: { listFails?: boolean; deleteFails?: boolean } = {}) {
  const deleted: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      queue: { list: async ({ threadId }: { threadId?: string }) => {
        if (options.listFails) throw new Error("queue unavailable");
        return rows.filter((row) => !threadId || row.threadId === threadId);
      } },
      queuedMessages: { delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
        if (options.deleteFails) throw new Error("already sent");
        deleted.push(queuedMessageId);
        return { ok: true as const };
      } },
    } } as never,
  });
  return { guard: createProviderRetryGuard(bb), harness, deleted };
}

describe("provider-retry guard", () => {
  it("deletes the retry rows of an abandoned thread and nothing else", async () => {
    const { guard, deleted } = setup([retryRow("r1", "t1"), inlineRow("i1", "t1"), retryRow("r2", "t2"), retryRow("r3", "t1")]);
    expect(await guard.abandon("t1")).toBe(2);
    expect(deleted).toEqual(["r1", "r3"]);
  });

  it("cancels a retry the plugin queues after the thread was abandoned, and leaves other threads' retries alone", async () => {
    const { guard, harness, deleted } = setup([]);
    await guard.abandon("t1");
    await harness.emitThreadEvent("message.queued", { entry: retryRow("late", "t1") });
    await harness.emitThreadEvent("message.queued", { entry: retryRow("other", "t2") });
    await harness.emitThreadEvent("message.queued", { entry: inlineRow("typed", "t1") });
    expect(deleted).toEqual(["late"]);
  });

  it("does nothing without provider-retry's rows, and never throws when the queue or a delete fails", async () => {
    expect(await setup([]).guard.abandon("t1")).toBe(0);
    expect(await setup([retryRow("r1", "t1")], { listFails: true }).guard.abandon("t1")).toBe(0);
    const failing = setup([retryRow("r1", "t1")], { deleteFails: true });
    expect(await failing.guard.abandon("t1")).toBe(0);
    const late = await failing.harness.emitThreadEvent("message.queued", { entry: retryRow("r2", "t1") });
    expect(late.errors).toEqual([]);
    expect(await failing.guard.abandon(null)).toBe(0);
    expect(await failing.guard.abandon("")).toBe(0);
  });
});

const consentInput = (threadId: string) => ({
  threadId, requestId: "req-1", reason: "Rate limited" as const, sendAt: 1_700_000_000_000,
});

/** A writer attempt live on `threadId`: queued → spawn_requested → running. */
function writerOn(db: ReturnType<typeof openDatabase>, runId: string, taskId: string, attemptId: string, threadId: string) {
  createAttempt(db, { id: attemptId, runId, taskId });
  transitionAttempt(db, attemptId, "spawn_requested");
  transitionAttempt(db, attemptId, "running", { threadId });
}

function setupWithDb() {
  const deleted: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      queue: { list: async ({ threadId }: { threadId?: string }) => [] },
      queuedMessages: { delete: async ({ queuedMessageId }: { queuedMessageId: string }) => { deleted.push(queuedMessageId); return { ok: true as const }; } },
    } } as never,
  });
  const db = openDatabase(bb);
  const guard = createProviderRetryGuard(bb, db);
  const consent = (threadId: string) => harness.behavior.callRpc(PROVIDER_RETRY_CONSENT_METHOD as never, consentInput(threadId) as never) as Promise<{ kind: string; reason?: string }>;
  return { bb, harness, db, guard, deleted, consent };
}

describe("provider-retry consent over the durable store", () => {
  it("declines ended work — accepted, canceled, superseded, run-closed — and allows live attempts and unknown threads", async () => {
    const { db, consent } = setupWithDb();
    createRun(db, "run_a", "proj_a");
    createTask(db, { id: "t_done", runId: "run_a", kind: "bb", contract: {} });
    writerOn(db, "run_a", "t_done", "att_done", "thr_done");
    transitionAttempt(db, "att_done", "accepted");
    expect(await consent("thr_done")).toEqual({ kind: "decline", reason: "attempt accepted" });

    createTask(db, { id: "t_c", runId: "run_a", kind: "bb", contract: {} });
    writerOn(db, "run_a", "t_c", "att_c", "thr_c");
    transitionAttempt(db, "att_c", "cancel_requested");
    transitionAttempt(db, "att_c", "canceled");
    expect((await consent("thr_c")).kind).toBe("decline");

    // A newer attempt of the same task on another thread supersedes the old one, which stays open meanwhile.
    createTask(db, { id: "t_s", runId: "run_a", kind: "bb", contract: {} });
    writerOn(db, "run_a", "t_s", "att_s1", "thr_old");
    writerOn(db, "run_a", "t_s", "att_s2", "thr_new");
    expect((await consent("thr_old")).kind).toBe("decline");
    expect((await consent("thr_new")).kind).toBe("allow");

    // A live attempt blocks the public close API. Seed only the closed columns after that refusal: this is a legacy
    // closed-run + open-attempt row that current admission APIs cannot construct, but retry consent must still fence.
    createRun(db, "run_b", "proj_a");
    createTask(db, { id: "t_r", runId: "run_b", kind: "bb", contract: {} });
    writerOn(db, "run_b", "t_r", "att_r", "thr_r");
    expect(closeRun(db, "run_b", "rpc")).toBe(false);
    db.prepare("UPDATE lane_pilot_run SET state='closed', closed_at=?, closed_by=?, updated_at=? WHERE id=?")
      .run(Date.now(), "rpc", Date.now(), "run_b");
    expect(() => createTask(db, { id: "t_r_rejected", runId: "run_b", kind: "bb", contract: {} }))
      .toThrow("Lane Pilot admission refused: run is closed; use the chat's current run");
    expect(await consent("thr_r")).toEqual({ kind: "decline", reason: "run closed" });

    createTask(db, { id: "t_l", runId: "run_a", kind: "bb", contract: {} });
    writerOn(db, "run_a", "t_l", "att_l", "thr_live");
    expect(await consent("thr_live")).toEqual({ kind: "allow" });
    // No durable record: PM, helper, probe and native threads keep core's fail-open default.
    expect(await consent("thr_unknown")).toEqual({ kind: "allow" });
  });

  it("a reused thread answers by its newest attempt: ended feedback attempt, live newest one allows", async () => {
    const { db, consent } = setupWithDb();
    createRun(db, "run_u", "proj_u");
    createTask(db, { id: "t_u", runId: "run_u", kind: "bb", contract: {} });
    writerOn(db, "run_u", "t_u", "att_u1", "thr_reuse");
    transitionAttempt(db, "att_u1", "cancel_requested");
    transitionAttempt(db, "att_u1", "canceled");
    writerOn(db, "run_u", "t_u", "att_u2", "thr_reuse");
    expect(await consent("thr_reuse")).toEqual({ kind: "allow" });
    expect(retryEligibility(db, "thr_reuse")).toEqual({ kind: "allow", reason: "attempt running" });
  });

  it("a late queued retry of ended work is deleted from the store even with an empty abandon set (post-restart guard)", async () => {
    const { harness, db, deleted } = setupWithDb();
    createRun(db, "run_q", "proj_q");
    createTask(db, { id: "t_q", runId: "run_q", kind: "bb", contract: {} });
    writerOn(db, "run_q", "t_q", "att_q", "thr_q");
    transitionAttempt(db, "att_q", "accepted");
    createTask(db, { id: "t_q2", runId: "run_q", kind: "bb", contract: {} });
    writerOn(db, "run_q", "t_q2", "att_q2", "thr_q2");

    await harness.emitThreadEvent("message.queued", { entry: retryRow("late-ended", "thr_q") });
    await harness.emitThreadEvent("message.queued", { entry: retryRow("late-live", "thr_q2") });
    await harness.emitThreadEvent("message.queued", { entry: retryRow("late-foreign", "thr_foreign") });
    expect(deleted).toEqual(["late-ended"]);
  });

  it("registers provider-retry.v1.consent discoverable with the exact wire shape; benign where nothing calls it", async () => {
    const { harness, consent } = setupWithDb();
    expect(harness.registrations.rpcMethods).toContain(PROVIDER_RETRY_CONSENT_METHOD);
    const published = harness.registrations.experimental_publishedRpcMethods.find((m) => m.method === PROVIDER_RETRY_CONSENT_METHOD);
    expect(published).toBeDefined();
    const input = JSON.stringify(published!.inputSchema);
    for (const key of ["threadId", "requestId", "reason", "sendAt"]) expect(input).toContain(`"${key}"`);
    for (const reason of ["Rate limited", "Provider overloaded", "Provider unavailable"]) expect(input).toContain(reason);
    expect(input).toContain('"minimum":0');
    const output = JSON.stringify(published!.outputSchema);
    expect(output).toContain('"allow"');
    expect(output).toContain('"decline"');
    // The current core never calls the endpoint; registration alone changes nothing until a 0.49 provider-retry asks.
    expect(await consent("thr_nobody")).toEqual({ kind: "allow" });
  });
});

describe("provider-retry durable precedence over the RAM abandon set", () => {
  it("a redispatch descendant supersedes: «t_f»'s thread declines while «t_f.2»'s allows", async () => {
    const { db, consent } = setupWithDb();
    createRun(db, "run_f", "proj_f");
    createTask(db, { id: "t_f", runId: "run_f", kind: "bb", contract: {} });
    writerOn(db, "run_f", "t_f", "att_f1", "thr_f1");
    createTask(db, { id: "t_f.2", runId: "run_f", kind: "bb", contract: {} });
    writerOn(db, "run_f", "t_f.2", "att_f2", "thr_f2");
    expect((await consent("thr_f1")).kind).toBe("decline");
    expect(await consent("thr_f2")).toEqual({ kind: "allow" });
  });

  it("the family-latest tiebreak is deterministic: equal created_at still puts the later insert on top", async () => {
    const { db, consent } = setupWithDb();
    createRun(db, "run_g", "proj_g");
    createTask(db, { id: "t_g", runId: "run_g", kind: "bb", contract: {} });
    writerOn(db, "run_g", "t_g", "att_g1", "thr_g1");
    createTask(db, { id: "t_g.2", runId: "run_g", kind: "bb", contract: {} });
    writerOn(db, "run_g", "t_g.2", "att_g2", "thr_g2");
    // Same-ms created_at is the real race (Date.now() is millisecond-grained); pin it so the rowid order decides.
    db.prepare("UPDATE lane_pilot_attempt SET created_at=1 WHERE run_id=?").run("run_g");
    expect((await consent("thr_g1")).kind).toBe("decline");
    expect(await consent("thr_g2")).toEqual({ kind: "allow" });
  });

  it("durable allow supersedes a stale abandon mark on a reused thread; an unknown thread keeps the RAM delete", async () => {
    const { harness, db, deleted, consent, guard } = setupWithDb();
    createRun(db, "run_z", "proj_z");
    createTask(db, { id: "t_z", runId: "run_z", kind: "bb", contract: {} });
    writerOn(db, "run_z", "t_z", "att_z1", "thr_z");
    transitionAttempt(db, "att_z1", "accepted");
    await guard.abandon("thr_z");
    // The same thread is legitimately reused by a newer live attempt: queued event AND consent must both allow.
    writerOn(db, "run_z", "t_z", "att_z2", "thr_z");
    await harness.emitThreadEvent("message.queued", { entry: retryRow("reuse", "thr_z") });
    expect(await consent("thr_z")).toEqual({ kind: "allow" });
    expect(deleted).toEqual([]);
    // A thread the store does not know keeps the historical RAM behavior.
    await guard.abandon("thr_ram");
    await harness.emitThreadEvent("message.queued", { entry: retryRow("ram", "thr_ram") });
    expect(deleted).toEqual(["ram"]);
  });
});
