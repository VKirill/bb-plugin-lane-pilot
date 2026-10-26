import { describe, expect, it } from "vitest";
import { createWall, askSha, type RepairView, type WallPorts } from "../../src/rooms/wall/service";
import { listRepairs, listWalls } from "../../src/rooms/wall/store";
import { wallSignature } from "../../src/rooms/wall/signature";
import { HOUR, NOW, freshDb, isReal } from "./helpers";

const REASON = "internal_error: another writer integration holds the base checkout lpattempt_aaa";
const KEY = wallSignature("blocked", REASON).classKey;

type Fake = ReturnType<typeof fakePorts>;
function fakePorts(h: ReturnType<typeof freshDb>, patch: { version?: { v: string } } = {}) {
  const state = {
    version: patch.version ?? { v: "0.1.268" },
    views: new Map<string, RepairView>(),
    reports: new Map<string, string>(),
    changed: ["src/rooms/relay/server/relay.ts", "tests/relay.test.ts"] as string[] | null,
    drill: null as { version: string; at: number; ok: boolean } | null,
    canary: null as { version: string; tripped: boolean; windowOpen: boolean } | null,
    benchAvailable: true,
    benchArms: new Map<string, "done" | "running">(),
    benchCompare: "pass" as "pass" | "fail" | "pending" | "unavailable",
    scores: new Map<string, number>(),
    hunterReplies: [] as Array<string | null>,
    readerCalls: [] as string[],
    told: [] as Array<{ thread: string; text: string }>,
    reverted: [] as string[],
    restarted: [] as string[],
    deferrals: new Map<string, { what: string; closed?: string }>(),
    busy: new Set<string>(),
    time: NOW,
  };
  const ports: WallPorts = {
    now: () => state.time,
    get version() { return state.version.v; },
    loadScope: async () => ({ isReal, scopeOf: (project) => (project === "proj_sand" ? "sandbox" : "real") }),
    logLines: () => [],
    codeFiles: async () => [],
    reader: async (prompt, who) => {
      state.readerCalls.push(who);
      const reply = state.hunterReplies.shift();
      return { text: reply ?? null, tokens: 100_000 };
    },
    tellPm: async (thread, text) => { state.told.push({ thread, text }); return true; },
    repair: {
      view: async (signature) => state.views.get(signature) ?? null,
      report: async (thread) => state.reports.get(thread) ?? "",
      tokens: async () => 3_000_000,
      busy: async (thread) => state.busy.has(thread),
      changedFiles: async () => state.changed as never,
      revert: async (commit) => { state.reverted.push(commit); return { ok: true, detail: "merged abc" }; },
    },
    release: { drill: async () => state.drill, canary: async () => state.canary },
    bench: {
      available: async () => state.benchAvailable,
      ensureArm: async (arm) => { const known = state.benchArms.get(arm); if (!known) { state.benchArms.set(arm, "running"); return "running"; } return known; },
      compare: async () => state.benchCompare,
      score: async (arm) => state.scores.get(arm) ?? null,
    },
    restart: async (plan) => { state.restarted.push(plan.taskId); return { ok: true, note: "restarted" }; },
    deferrals: {
      open: (input) => { state.deferrals.set(input.id, { what: input.what }); },
      close: (id, evidence) => { const row = state.deferrals.get(id); if (row) row.closed = evidence; },
    },
  };
  const kv = new Map<string, unknown>();
  const wall = createWall({ db: h.db, kv: { get: async (key) => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); } }, ports, log: () => undefined, hubDb: "/hub/data.db" });
  return { wall, state, kv };
}

/** A night's data: the class fails 5 times today among 30 attempts, a writer-side class twice, plus accepted work. */
function seedNight(h: ReturnType<typeof freshDb>, failures = 5) {
  for (let i = 0; i < 25; i++) h.attempt("accepted", null, NOW - 20 * HOUR + i);
  for (let i = 0; i < failures; i++) h.attempt("blocked", REASON, NOW - 3 * HOUR + i * 1000, { version: "0.1.268", task: `tf${i}` });
  h.attempt("validation_failed", "verification failed (npx vitest run a): 1 failed", NOW - 2 * HOUR);
  h.attempt("validation_failed", "verification failed (npx vitest run b): 2 failed", NOW - 2 * HOUR + 1);
}

const verdictLine = (verdict: string) => `report\nNIGHT-REPORT: test=tests/x.test.ts sites=2 class=${KEY}\nSITE: src/a.ts:1 — fixed\nSITE: src/b.ts:2 — fixed\nSELF-REPAIR-VERDICT: ${verdict}`;

describe("a dry-run night", () => {
  it("says what it would pick and why, keeps nothing, calls no model", async () => {
    const h = freshDb(); seedNight(h);
    const { wall, state } = fakePorts(h);
    const summary = await wall.runNight({ dryRun: true, now: NOW });
    expect(summary.dryRun).toBe(true);
    expect(summary.classesSeen).toBe(2);
    expect(summary.picked).toEqual([expect.objectContaining({ classKey: KEY, round: 1, role: "engineer" })]);
    expect(summary.picked[0]!.why).toMatch(/origin harness/);
    expect(summary.morning.map((row) => row.why).join("|")).toMatch(/within the bar/);
    expect(state.readerCalls).toEqual([]);
    for (const table of ["lane_pilot_wall_entry", "lane_pilot_wall_class", "lane_pilot_wall_repair", "lane_pilot_wall_night"]) {
      expect((h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
  });
});

describe("the real night and the life of one repair", () => {
  it("queues a repair with the proof, the sweep and the cap; the watcher's tick takes it; a fixed branch that touches a judge is HELD and nobody is asked", async () => {
    const h = freshDb(); seedNight(h);
    const { wall, state } = fakePorts(h);
    const summary = await wall.runNight({ now: NOW });
    expect(summary.picked).toHaveLength(1);
    expect(summary.spendTokens).toBe(4_000_000);
    expect(state.benchArms.has("night-0.1.268")).toBe(true);        // the baseline arm for "not worse than the previous version"
    const queued = listRepairs(h.db);
    expect(queued).toHaveLength(1);
    const assignment = wall.nextAssignment()!;
    expect(assignment.signature).toMatch(/^night:[0-9a-f]{12}:harness: internal_error/);
    expect(assignment.brief).toContain("SITE: <file>:<line>");
    expect(assignment.samples[0]).toMatchObject({ kind: "night", version: "0.1.268" });
    // A second run of the same night adds no second repair for a class that has one under way.
    expect((await wall.runNight({ now: NOW + 1000 })).picked).toEqual([]);

    wall.started(assignment.id, { threadId: "thr_fix", branch: "lane/self-repair-1", at: NOW + 1000 });
    expect(wall.nextAssignment()).toBeNull();
    state.views.set(assignment.signature, { threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "lane/self-repair-1", worktreePath: "/wt/x", spawnedAt: NOW });
    state.reports.set("thr_fix", verdictLine("fixed"));
    // It touches the judge (plan-fact) and changes an existing test: no strict proof, so it is rejected — nothing waits for the owner.
    state.changed = [{ path: "src/rooms/relay/server/relay.ts", status: "M" }, { path: "src/rooms/tasks/plan-fact.ts", status: "M" }, { path: "tests/plan-fact.test.ts", status: "M" }];
    await wall.advance(NOW + 2 * HOUR);
    const decided = await wall.mergeGate(assignment.signature, { threadId: "thr_fix" });
    expect(decided).toBe("release");
    const row = listRepairs(h.db)[0]!;
    expect(row.outcome).toMatch(/fixed; 2 sites listed; test tests\/x\.test\.ts/);
    expect(row.policy).toMatchObject({ decision: "reject", tier: "owner_only" });
    expect((row.policy as { reason: string }).reason).toMatch(/an existing test was changed or deleted/);
    expect(await wall.mergeGate(assignment.signature, { threadId: "thr_fix" })).toBe("release");   // stored, not decided again
  });

  it("the night merges a repair with its proofs, the train ships, the checks go green and the repair is accepted; the failed attempts are planned for a re-run", async () => {
    const h = freshDb(); seedNight(h);
    // A failed attempt of the class in a sandbox project with its receipts: it is restarted from its earliest affected stage.
    h.attempt("blocked", REASON, NOW - 2 * HOUR, { id: "sand1", task: "ts1", run: "run_sand" });
    for (const stage of ["pm-read", "plan-critique", "specialist-review"]) h.receipt("ts1", stage, "passed", "i", "run_sand");
    h.receipt("ts1", "writer-agent", "failed", "i", "run_sand");
    const { wall, state } = fakePorts(h);
    await wall.runNight({ now: NOW });
    const assignment = wall.nextAssignment()!;
    wall.started(assignment.id, { threadId: "thr_fix", branch: "lane/self-repair-1", at: NOW + 1000 });
    state.views.set(assignment.signature, { threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "lane/self-repair-1", worktreePath: "/wt/x", spawnedAt: NOW });
    expect(await wall.mergeGate(assignment.signature, { threadId: "thr_fix" })).toBe("merge");
    expect(listRepairs(h.db)[0]!.policy).toMatchObject({ decision: "merge", tier: "night_decides", benchEnforcedAfterDeploy: true });
    wall.settled(assignment.signature, { outcome: "merged abcdef123456", verdict: "fixed", commit: "abcdef123456" });
    expect(listRepairs(h.db)[0]).toMatchObject({ state: "merged", mergedCommit: "abcdef123456" });

    // Not shipped yet: nothing changes.
    await wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(h.db)[0]!.state).toBe("merged");
    // The train shipped 0.1.269.
    state.version.v = "0.1.269";
    await wall.advance(NOW + 4 * HOUR);
    expect(listRepairs(h.db)[0]).toMatchObject({ state: "deployed", shippedVersion: "0.1.269" });
    // The drill and the canary are not in yet: pending.
    await wall.advance(NOW + 4 * HOUR + 1);
    expect(listRepairs(h.db)[0]!.state).toBe("deployed");
    state.drill = { version: "0.1.269", at: NOW + 4 * HOUR + 10, ok: true };
    state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    state.benchArms.set("night-0.1.268", "done");
    state.benchArms.set("night-0.1.269", "done");
    state.scores.set("night-0.1.268", 0.5); state.scores.set("night-0.1.269", 0.67);
    for (let i = 0; i < 12; i++) h.attempt("accepted", null, NOW + 5 * HOUR + i, { version: "0.1.269" });
    const notes = await wall.advance(NOW + 6 * HOUR);
    expect(notes.join("|")).toMatch(/accepted \(all checks green\); 6 re-run\(s\) planned/);
    const accepted = listRepairs(h.db)[0]!;
    expect(accepted.state).toBe("accepted");
    expect(accepted.acceptance).toMatchObject({ benchScore: 0.67, baselineScore: 0.5, recurred: false });
    expect(state.restarted).toEqual(["ts1"]);                 // only the sandbox task is restarted, from its writer stage; the real-project failures are listed
    const reruns = h.db.prepare("SELECT task_id, scope, state, from_stage FROM lane_pilot_wall_rerun ORDER BY task_id").all() as Array<{ task_id: string; scope: string; state: string; from_stage: string }>;
    expect(reruns.filter((row) => row.scope === "real").every((row) => row.state === "listed")).toBe(true);
    expect(reruns.find((row) => row.task_id === "ts1")).toMatchObject({ scope: "sandbox", state: "dispatched", from_stage: "writer-agent" });
  });

  it("a red canary reverts the merge in code, the class stays open and the round counts as failed", async () => {
    const h = freshDb(); seedNight(h);
    const { wall, state } = fakePorts(h);
    await wall.runNight({ now: NOW });
    const assignment = wall.nextAssignment()!;
    wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
    state.views.set(assignment.signature, { threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "b", worktreePath: "/wt", spawnedAt: NOW });
    await wall.mergeGate(assignment.signature, { threadId: "thr_fix" });
    wall.settled(assignment.signature, { outcome: "merged c0ffee", verdict: "fixed", commit: "c0ffee1234" });
    state.version.v = "0.1.269";
    await wall.advance(NOW + HOUR);
    state.drill = { version: "0.1.269", at: NOW + HOUR + 5, ok: true };
    state.canary = { version: "0.1.269", tripped: true, windowOpen: false };
    await wall.advance(NOW + 2 * HOUR);
    expect(state.reverted).toEqual(["c0ffee1234"]);
    expect(listRepairs(h.db)[0]).toMatchObject({ state: "red" });
    expect(wall.classes().find((row) => row.classKey === KEY)).toMatchObject({ failedMoves: 1, state: "open" });
  });

  it("a red drill is the train's rollback: the plugin runs the old version again, the class stays open", async () => {
    const h = freshDb(); seedNight(h);
    const { wall, state } = fakePorts(h);
    await wall.runNight({ now: NOW });
    const assignment = wall.nextAssignment()!;
    wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
    state.views.set(assignment.signature, { threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "b", worktreePath: "/wt", spawnedAt: NOW });
    await wall.mergeGate(assignment.signature, { threadId: "thr_fix" });
    wall.settled(assignment.signature, { outcome: "merged c0ffee", verdict: "fixed", commit: "c0ffee1234" });
    state.version.v = "0.1.269";
    await wall.advance(NOW + HOUR);
    expect(listRepairs(h.db)[0]!.state).toBe("deployed");
    state.version.v = "0.1.268";                               // the train rolled back
    await wall.advance(NOW + 2 * HOUR);
    expect(listRepairs(h.db)[0]).toMatchObject({ state: "rolled_back" });
    expect(wall.classes().find((row) => row.classKey === KEY)!.failedMoves).toBe(1);
    expect(state.reverted).toEqual([]);                        // nothing to revert: the train restored the old dist
  });
});

describe("the loop guard on a class: two rounds, the hunt, one informed round, the backlog", () => {
  it("never retries forever", async () => {
    const h = freshDb(); seedNight(h);
    const { wall, state } = fakePorts(h);
    const T = (n: number) => NOW + n * 24 * HOUR;
    const flood = (n: number) => { for (let i = 0; i < 5; i++) h.attempt("blocked", REASON, T(n) - HOUR + i * 100, { version: "0.1.268", task: `f${n}-${i}` }); };
    // Nights 0 and 1: the engineer's repair ends "needs-owner" - a failed move each time.
    for (let n = 0; n <= 1; n++) {
      if (n > 0) flood(n);
      const night = await wall.runNight({ now: T(n) });
      expect(night.picked, `night ${n}`).toHaveLength(1);
      const a = wall.nextAssignment()!;
      wall.started(a.id, { threadId: `thr_${n}`, branch: "b", at: T(n) });
      wall.settled(a.signature, { outcome: "released: needs-owner", verdict: "needs-owner", commit: null });
    }
    expect(wall.classes().find((row) => row.classKey === KEY)!.failedMoves).toBe(2);
    // Night 2: no third engineer round. The dry run says the hunt is what it would do.
    flood(2);
    expect((await wall.runNight({ dryRun: true, now: T(2) })).hunts).toEqual([KEY]);
    expect(state.readerCalls).toEqual([]);
    // For real: three hunters read from other sides; one cites something real, one something invented, one answers no JSON.
    state.hunterReplies.push(
      JSON.stringify({ verdict: "lp_fault", summary: "the integration lock is never released after a failed merge", action: "self_repair", evidence: [{ kind: "sql", ref: "by_version", quote: "0.1.268" }] }),
      JSON.stringify({ verdict: "lp_fault", summary: "invented", action: "self_repair", evidence: [{ kind: "file", ref: "src/not/there.ts", line: 3, quote: "an invented quote here" }] }),
      "no json at all",
    );
    const third = await wall.runNight({ now: T(2) });
    expect(third.hunts).toEqual([KEY]);
    expect(state.readerCalls).toEqual(["hunter", "hunter", "hunter"]);
    expect(wall.classes().find((row) => row.classKey === KEY)).toMatchObject({ hunt: "usable", stage: "informed" });
    expect(third.picked).toEqual([expect.objectContaining({ classKey: KEY, role: "informed" })]);
    const informed = wall.nextAssignment()!;
    expect(informed.selection).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
    expect(informed.brief).toMatch(/HUNTERS' FINDINGS/);
    expect(informed.brief).toMatch(/\[task\] lp_fault -> self_repair/);
    expect(informed.brief).not.toMatch(/invented/);                  // a finding whose citation does not hold never reaches the engineer
    // The informed round fails too: the backlog, with the full analysis and a register entry that waits for a person's term.
    wall.started(informed.id, { threadId: "thr_inf", branch: "b", at: T(2) });
    wall.settled(informed.signature, { outcome: "released: not-lane-pilot", verdict: "not-lane-pilot", commit: null });
    state.hunterReplies.push("# Full analysis\n1. chronology...");
    flood(3);
    const fourth = await wall.runNight({ now: T(3) });
    expect(fourth.backlog).toEqual([KEY]);
    expect(fourth.picked).toEqual([]);
    expect(wall.classes().find((row) => row.classKey === KEY)!.stage).toBe("backlog");
    const walls = listWalls(h.db, { states: ["backlog"] });
    expect(walls).toHaveLength(1);
    expect(walls[0]!.deferralId).toMatch(/^dfr_wall_/);
    expect((walls[0]!.analysis as { text: string }).text).toMatch(/Full analysis/);
    expect(state.deferrals.size).toBe(1);
    // One line on the morning list for the class the machine ended: informational (no wake), with where the analysis is; nothing waits for the owner.
    const items = h.db.prepare("SELECT key, source, kind, what, why, wake FROM lane_pilot_owner_item").all() as Array<{ key: string; source: string; kind: string; what: string; why: string; wake: number }>;
    expect(items).toEqual([expect.objectContaining({ key: `wall:class:${KEY}`, source: "wall", kind: "loop_exhausted", wake: 0 })]);
    expect(items[0]!.why).toMatch(/wall show class:.*Ничего не ждёт тебя/s);
    // A fifth night picks nothing for it: the backlog keeps it with its analysis.
    flood(4);
    const fifth = await wall.runNight({ now: T(4) });
    expect(fifth.picked).toEqual([]);
    expect(fifth.morning.find((row) => row.classKey === KEY)!.why).toMatch(/backlog/);
    expect(fifth.morning.find((row) => row.classKey === KEY)!.why).not.toMatch(/waits for a person/);
  });

  it("the night's token cap holds: a round that would pass it is not started", async () => {
    const h = freshDb(); seedNight(h);
    const { wall } = fakePorts(h);
    await wall.setConfig({ nightTokenCap: 3_000_000 });            // below the assumed cost of one round
    const night = await wall.runNight({ now: NOW });
    expect(night.picked).toEqual([]);
    expect(night.morning.find((row) => row.classKey === KEY)!.why).toMatch(/token cap/);
    expect(night.capTokens).toBe(3_000_000);
    expect(night.spendTokens).toBe(0);
  });
});

describe("the same ladder for an ordinary task", () => {
  const FAILURE = "owns_paths rejected src/i18n/en.json";
  const stop = (wall: ReturnType<typeof fakePorts>["wall"], task: unknown = { objective: "add copy", owns_paths: ["src/pages/**"] }) =>
    wall.noteTaskStop({ projectId: "proj_real", runId: "run_real", taskId: "P1.2", family: "P1", reason: FAILURE, state: "validation_failed", pmThreadId: "thr_pm", task, plan: "the plan" });

  function seedTask(h: ReturnType<typeof freshDb>) {
    h.db.prepare("INSERT INTO lane_pilot_task (id,run_id,kind,contract_json,created_at) VALUES ('P1.2','run_real','bb',?,?)").run(JSON.stringify({ objective: "add copy", owns_paths: ["src/pages/**"], expected_outputs: ["src/i18n/en.json"] }), NOW);
    h.attempt("validation_failed", FAILURE, NOW - 3 * HOUR, { id: "t1", task: "P1" });
    h.attempt("validation_failed", FAILURE, NOW - 2 * HOUR, { id: "t2", task: "P1.2" });
    h.receipt("P1.2", "writer-agent", "failed", "i", "run_real", FAILURE);
  }

  it("two identical failures open a wall; the hunters' checked findings go to the PM once; the same ask is not sent again", async () => {
    const h = freshDb(); seedTask(h);
    const { wall, state } = fakePorts(h);
    const first = await stop(wall);
    expect(first.step).toBe("hunt");
    expect(await stop(wall)).toMatchObject({ key: first.key, step: "stopped" });         // idempotent
    state.hunterReplies.push(
      JSON.stringify({ verdict: "contract_wrong", summary: "the contract expects src/i18n/en.json but owns only src/pages/**", action: "update_contract",
        evidence: [{ kind: "file", ref: "TASK", line: 1, quote: "src/i18n/en.json" }, { kind: "receipt", ref: "run_real/P1.2/writer-agent", quote: "owns_paths rejected src/i18n/en.json" }] }),
      JSON.stringify({ verdict: "env_fault", summary: "made up", action: "none", evidence: [{ kind: "check_output", ref: "x", quote: "the disk is full on the machine" }] }),
      null,
    );
    await wall.advance(NOW);
    const row = listWalls(h.db, { kind: "task" })[0]!;
    expect(row).toMatchObject({ state: "hunted", hunt: "usable" });
    expect(state.told).toHaveLength(1);
    expect(state.told[0]).toMatchObject({ thread: "thr_pm" });
    expect(state.told[0]!.text).toMatch(/contract_wrong -> update_contract/);
    expect(state.told[0]!.text).not.toMatch(/made up/);
    const same = { objective: "add copy", owns_paths: ["src/pages/**"] };
    expect(wall.dispatchGuard({ runId: "run_real", family: "P1", task: { id: "P1.3", ...same }, plan: "the plan" })).toMatch(/wall_unchanged_ask/);
    expect(wall.dispatchGuard({ runId: "run_real", family: "P1", task: { id: "P1.3", ...same, owns_paths: ["src/pages/**", "src/i18n/**"] }, plan: "the plan" })).toBeNull();
    expect(wall.dispatchGuard({ runId: "run_real", family: "OTHER", task: same, plan: "the plan" })).toBeNull();
    expect(askSha({ id: "A", x: 1 }, "p")).toBe(askSha({ id: "B", x: 1 }, "p"));
  });

  it("the move after the hunters' message fails the same way: the backlog, and the family is not sent again", async () => {
    const h = freshDb(); seedTask(h);
    const { wall, state } = fakePorts(h);
    await stop(wall);
    state.hunterReplies.push(JSON.stringify({ verdict: "split_needed", summary: "two jobs in one task", action: "split", evidence: [{ kind: "receipt", ref: "run_real/P1.2/writer-agent", quote: "owns_paths rejected" }] }));
    await wall.advance(NOW);
    const again = await stop(wall);
    expect(again.step).toBe("backlog");
    const row = listWalls(h.db, { kind: "task" })[0]!;
    expect(row.state).toBe("backlog");
    expect(row.deferralId).toMatch(/^dfr_wall_/);
    expect(wall.dispatchGuard({ runId: "run_real", family: "P1", task: { objective: "different" }, plan: "other plan" })).toMatch(/wall_backlog/);
    // An accepted attempt of the family closes the wall and its register entry.
    h.attempt("accepted", null, NOW + HOUR, { task: "P1.4", id: "t9" });
    await wall.advance(NOW + 2 * HOUR);
    expect(listWalls(h.db, { kind: "task" })[0]).toMatchObject({ state: "closed", closedBy: "accepted attempt t9" });
    expect(state.deferrals.get(row.deferralId!)!.closed).toMatch(/accepted/);
    expect(wall.dispatchGuard({ runId: "run_real", family: "P1", task: {}, plan: "" })).toBeNull();
  });

  it("hunters that cite nothing real send the wall straight to the backlog", async () => {
    const h = freshDb(); seedTask(h);
    const { wall, state } = fakePorts(h);
    await stop(wall);
    state.hunterReplies.push(JSON.stringify({ verdict: "contract_wrong", summary: "x", action: "update_contract", evidence: [{ kind: "file", ref: "TASK", line: 400, quote: "not in the contract at all" }] }), null, null);
    await wall.advance(NOW);
    expect(listWalls(h.db, { kind: "task" })[0]).toMatchObject({ state: "backlog", hunt: "unknown" });
    expect(state.told).toEqual([]);
  });
});
