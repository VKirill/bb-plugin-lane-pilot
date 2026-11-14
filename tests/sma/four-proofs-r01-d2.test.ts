// Region 1 · Task graph, batch d (file 2): the critic's session and what the barrier makes of it, the prepared candidate, the repeated dispatch,
// and the phase's acceptance (prepared, lines, package). Real code on scratch databases and repositories; no model, no hub write.
import { describe, expect, it, vi } from "vitest";
import { observeCritic, observeNeedsDecision, observePrepared } from "./r01-world-d";
import { observeClosed, observeIdempotent, observeLines, observePreparedPhase, observeView } from "./r01-world-d2";

vi.setConfig({ testTimeout: 120_000 });

describe("the critic's session", () => {
  it("[sma:av_critic] the critic is an ordinary roster worker launched on the attempt's own copy; its approval passes the stage, its blocking finding stops it", async () => {
    const seen = await observeCritic();
    expect(seen.spawned).toBe(1);
    expect(seen.environment).toEqual({ type: "reuse", environmentId: "env_wt" });
    expect([seen.metaRole, seen.metaStage, seen.metaRun, seen.metaTask, seen.metaParent]).toEqual(["code-critic", "code-critique", "r", "t1", "thr_pm"]);
    expect(seen.approved).toEqual({ allowed: true, review: "passed", state: "passed", thread: "crit1" });
    expect(seen.blocked).toEqual({ allowed: false, state: "blocked" });
  });

  it("[sma:av_step] the critic step is written to the attempt's record as running, with its input hash, before the critic is launched", async () => {
    const seen = await observeCritic();
    expect(seen.atSpawn).toMatchObject({ state: "running" });
    expect(seen.atSpawn?.inputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[sma:av_needs_decision] a critic's block ends the attempt blocked with the verdict kept whole on its row, stopped and not redone, and nothing is merged", async () => {
    const seen = await observeNeedsDecision();
    expect(seen.result.status).toBe("blocked");
    expect(seen.attempt.state).toBe("blocked");
    expect(seen.attempt.reason).toBe(seen.result.reason);
    expect(seen.attempt.reason).toMatch(/^verdict_block:code-critique: the query is built from the request body/);
    expect(seen.attempt.reason).toContain("stopped, not redone");
    expect(seen.attempt.barrier).toMatchObject({ gate: "accept", status: "rejected", verdict: { status: "block", summary: "the query is built from the request body | the query is built from the request body" } });
    expect(seen.attempt.barrier?.tree).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.receipt.state).toBe("blocked");
  });
});

describe("the prepared candidate", () => {
  it("[sma:av_prepared] a writer's owned change passes validation and is declared prepared with its files and a diff key; no change is empty output, a change outside the contract is refused", async () => {
    const seen = await observePrepared();
    expect(seen.done).toMatchObject({ status: "accepted", produced: ["owned.ts"], hasDiffKey: true });
    expect(seen.idle).toMatchObject({ status: "empty_output", produced: [] });
    expect(seen.stray.status).toBe("validation_failed");
    expect(seen.stray.reason).toContain("outside owns_paths or inside never_touch: other.ts");
  });

  it("[sma:f_idem] the same dispatch delivered again is recognised as the task already there: no second task, no second attempt; a changed plan is new work", async () => {
    const seen = await observeIdempotent();
    expect(seen.first).toEqual({ taskId: "suite-green", state: "queued", dedup: null });
    expect(seen.again).toEqual({ taskId: "suite-green", sameAttempt: true, state: "queued", dedup: true });
    expect(seen.tasks).toBe(1);
    expect(seen.attempts).toBe(1);
    expect(seen.otherPlanDedup).toBeNull();
  });
});

describe("work acceptance of a phase", () => {
  it("[sma:ta_prepared] with the checks passed and only the person's decisions left, the phase is prepared and waits for his keyed decision on that package; a red machine line is not", () => {
    const seen = observePreparedPhase();
    expect(seen.ready.waitsForPm).toBe(true);
    expect(seen.ready.prepared).toBe(true);
    expect(seen.ready.key).toMatch(/^[0-9a-f]{16}$/);
    expect(seen.notReady.prepared).toBe(false);
    expect(seen.notReady.text).toContain("acceptance holds");
  });

  it("[sma:ta_closed] the phase is closed only after its closing documents read back as written; an unfaithful read-back keeps it open and tells the PM once", async () => {
    const seen = await observeClosed();
    expect(seen).toEqual({ heldState: "active", heldClosedDocs: null, heldNotices: 1, sameDayNotices: 1, closedState: "closed", closedDocs: true });
  });

  it("[sma:ta_lines] a piece not accepted keeps the landing line red; the person's two decisions are lines of their own and stay red until he decides", () => {
    const seen = observeLines();
    expect(seen.open).toEqual({ landed: false, useful: true, limits: true });
    expect(seen.landed).toEqual({ landed: true, useful: false, limits: false });
    expect(seen.ids.sort()).toEqual(["limits_acknowledged", "result_useful"]);
  });

  it("[sma:ta_view] the package shows the key the person decides on, the frozen verdict, and the card says which stages were decided by code and which by opinion", async () => {
    const seen = await observeView();
    expect(seen.verdict).toEqual({ state: "passed", detail: "all proved", mainSha: "head9" });
    expect(seen.keyHex && seen.keyIsShown).toBe(true);
    expect(seen.proofs).toEqual({ verification: "passed:code", "code-critique": "passed:advisory" });
    expect(seen.awaitsWord).toBe(true);
    expect(seen.notRun).toContain("plan-critique");
    expect(seen.notRun).not.toContain("verification");
    expect([seen.risk, seen.objective]).toEqual(["low", "do it"]);
  });
});
