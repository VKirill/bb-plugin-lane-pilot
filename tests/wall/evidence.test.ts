import { describe, expect, it } from "vitest";
import { shouldStopCycle } from "../../src/rooms/policy";
import { createWall, type WallPorts } from "../../src/rooms/wall/service";
import { cycleScoresOf } from "../../src/rooms/wall/select";
import { insertRepair, listRepairs, updateRepair } from "../../src/rooms/wall/store";
import { wallSignature } from "../../src/rooms/wall/signature";
import { EVIDENCE_WAIT_MS } from "../../src/rooms/wall/acceptance";
import { HOUR, NOW, freshDb, isReal } from "./helpers";

const REASON = "internal_error: another writer integration holds the base checkout lpattempt_aaa";
const KEY = wallSignature("blocked", REASON).classKey;

type Fakes = ReturnType<typeof world>;
function world(patch: { changed?: unknown; seed?: boolean; releaseFiles?: string[] | null; classFiles?: string[] } = {}) {
  const h = freshDb();
  if (patch.seed !== false) {
    for (let i = 0; i < 25; i++) h.attempt("accepted", null, NOW - 20 * HOUR + i);
    for (let i = 0; i < 5; i++) h.attempt("blocked", REASON, NOW - 3 * HOUR + i * 1000, { version: "0.1.268", task: `tf${i}` });
  }
  const state = {
    version: "0.1.268", time: NOW, benchAvailable: true, drillReceipt: true, compare: "pass" as "pass" | "fail" | "inconclusive" | "pending" | "unavailable",
    canary: null as { version: string; tripped: boolean; windowOpen: boolean } | null,
    ensured: [] as string[], compared: [] as Array<[string, string]>, reverted: [] as string[],
    changed: (patch.changed ?? ["src/rooms/relay/server/relay.ts"]) as unknown,
    releaseFiles: patch.releaseFiles, classFiles: patch.classFiles ?? [], asked: [] as Array<[string, string]>,
  };
  const ports: WallPorts = {
    now: () => state.time, get version() { return state.version; },
    loadScope: async () => ({ isReal, scopeOf: () => "real" }), logLines: () => [], codeFiles: async () => state.classFiles.map((path) => ({ path, lines: 1, text: "" })), reader: async () => ({ text: null, tokens: 0 }), tellPm: async () => true,
    repair: {
      view: async () => ({ threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "b", worktreePath: "/wt", spawnedAt: NOW }),
      report: async () => "", tokens: async () => 1, busy: async () => false, changedFiles: async () => state.changed as never,
      revert: async (sha) => { state.reverted.push(sha); return { ok: true, detail: "merged abc" }; },
    },
    release: { drill: async () => (state.drillReceipt ? { version: state.version, at: state.time + 1, ok: true } : null), canary: async () => state.canary,
      ...(patch.releaseFiles !== undefined ? { changedBetween: async (from: string, to: string) => { state.asked.push([from, to]); return state.releaseFiles ?? null; } } : {}) },
    bench: {
      available: async () => state.benchAvailable,
      ensureArm: async (arm) => { state.ensured.push(arm); return "done"; },
      compare: async (base, arm) => { state.compared.push([base, arm]); return state.compare; },
      score: async (arm) => (arm.endsWith("0.1.268") ? 0.5 : 0.67),
    },
    restart: async () => ({ ok: true, note: "" }),
    deferrals: { open: () => undefined, close: () => undefined },
  };
  const kv = new Map<string, unknown>();
  const wall = createWall({ db: h.db, kv: { get: async (key) => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); } }, ports, log: () => undefined, hubDb: "/hub/data.db" });
  return { h, wall, state };
}

const fixedIn = (w: Fakes) => (w.h.db.prepare("SELECT fixed_in FROM lane_pilot_wall_class WHERE class_key=?").get(KEY) as { fixed_in: string | null }).fixed_in;

/** Night, merge, and the release train shipping `shipped`; the repair is `deployed` and waits for its evidence. */
async function deployed(w: Fakes, shipped = "0.1.269") {
  await w.wall.runNight({ now: NOW });
  const assignment = w.wall.nextAssignment()!;
  w.wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
  expect(await w.wall.mergeGate(assignment.signature, { threadId: "thr_fix" })).toBe("merge");
  w.wall.settled(assignment.signature, { outcome: "merged c0ffee", verdict: "fixed", commit: "c0ffee".padEnd(40, "1") });
  w.state.version = shipped;
  w.state.time = NOW + HOUR;
  await w.wall.advance(w.state.time);
  expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "deployed", shippedVersion: shipped });
}

describe("one comparison is one cycle (review section 5)", () => {
  it("the review's numbers: three repairs judged by one comparison are one cycle, [.5, .125, .625] does not stop the series", () => {
    const repair = (baselineScore: number, benchScore: number, benchCompare?: { base: string; arm: string }) => ({ acceptance: { baselineScore, benchScore, ...(benchCompare ? { benchCompare } : {}) } });
    const live = [repair(0.5, 0.125), repair(0.125, 0.625), repair(0.125, 0.625), repair(0.125, 0.625)];
    expect(cycleScoresOf(live)).toEqual([0.5, 0.125, 0.625]);
    expect(shouldStopCycle(cycleScoresOf(live))).toBe(false);
    // Counted per repair, as it was: [.5, .125, .625, .625, .625] stops the night series.
    expect(shouldStopCycle([0.5, 0.125, 0.625, 0.625, 0.625])).toBe(true);
    // Rows that name the arms are told apart by them, not by the numbers: two comparisons with equal scores are two cycles.
    const arms = [repair(0.5, 0.5, { base: "night-1", arm: "night-2" }), repair(0.5, 0.5, { base: "night-2", arm: "night-3" }), repair(0.5, 0.5, { base: "night-2", arm: "night-3" })];
    expect(cycleScoresOf(arms)).toEqual([0.5, 0.5, 0.5]);
    expect(shouldStopCycle(cycleScoresOf(arms))).toBe(true);        // two distinct comparisons without improvement: the series is over, as the rule says
    expect(cycleScoresOf([{ acceptance: null }, { acceptance: { reason: "x" } }])).toEqual([]);
  });

  it("the night does not stop on them: a dry-run night with the live repair rows still picks its class", async () => {
    const w = world();
    const rows = [[0.5, 0.125], [0.125, 0.625], [0.125, 0.625], [0.125, 0.625]] as const;
    rows.forEach(([baselineScore, benchScore], index) => {
      const row = insertRepair(w.h.db, { classKey: `other:${index}`, signature: `sig${index}`, night: "2026-10-24", round: 1, role: "engineer", brief: {}, versionBefore: "0.1.268", tokensEst: 1, now: NOW - 48 * HOUR + index });
      updateRepair(w.h.db, row.id, { state: "accepted", acceptance: { baselineScore, benchScore } }, NOW - 47 * HOUR);
    });
    const summary = await w.wall.runNight({ dryRun: true, now: NOW });
    expect(summary.stoppedBy).toBeNull();
    expect(summary.picked.map((pick) => pick.classKey)).toEqual([KEY]);
  });

  it("the repairs of one release carry the arms of their comparison", async () => {
    const w = world();
    await deployed(w);
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    await w.wall.advance(NOW + 2 * HOUR);
    expect(listRepairs(w.h.db)[0]!.acceptance).toMatchObject({ benchCompare: { base: "night-0.1.268", arm: "night-0.1.269" }, benchScore: 0.67, baselineScore: 0.5 });
  });
});

describe("a repair is judged by the release that carried it (review section 4)", () => {
  it("a later release makes the experiment inconclusive: the bench of the newer version is not compared, nothing is accepted or reverted", async () => {
    const w = world();
    await deployed(w, "0.1.307");
    w.state.version = "0.1.328";                                    // the train shipped twenty more releases
    w.state.canary = { version: "0.1.328", tripped: false, windowOpen: false };
    const notes = await w.wall.advance(NOW + 3 * HOUR);
    expect(w.state.compared).toEqual([]);
    expect(w.state.ensured.filter((arm) => arm.includes("0.1.328"))).toEqual([]);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven", shippedVersion: "0.1.307" });
    expect(listRepairs(w.h.db)[0]!.outcome).toMatch(/0\.1\.328 was released after 0\.1\.307/);
    expect(notes.join("|")).toMatch(/unproven/);
    expect(w.state.reverted).toEqual([]);
    expect(w.wall.classes().find((row) => row.classKey === KEY)).toMatchObject({ failedMoves: 0 });
    expect(fixedIn(w)).toBeNull();
  });

  it("the bench arm that judges it is the shipped version's", async () => {
    const w = world();
    await deployed(w, "0.1.307");
    w.state.canary = { version: "0.1.307", tripped: false, windowOpen: false };
    await w.wall.advance(NOW + 3 * HOUR);
    expect(w.state.compared).toEqual([["night-0.1.268", "night-0.1.307"]]);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "accepted" });
  });
});

describe("acceptance without evidence (review section 2)", () => {
  it("no bench and no attempts of the new version: the repair waits, then is unproven; never accepted", async () => {
    const w = world();
    w.state.benchAvailable = false;                                // the gate needs a runnable bench to merge, the acceptance may find it gone
    await w.wall.runNight({ now: NOW });
    w.state.benchAvailable = true;
    const assignment = w.wall.nextAssignment()!;
    w.wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
    await w.wall.mergeGate(assignment.signature, { threadId: "thr_fix" });
    w.wall.settled(assignment.signature, { outcome: "merged c0ffee", verdict: "fixed", commit: "c0ffee".padEnd(40, "1") });
    w.state.version = "0.1.269";
    await w.wall.advance(NOW + HOUR);
    w.state.benchAvailable = false;
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    await w.wall.advance(NOW + 2 * HOUR);
    expect(listRepairs(w.h.db)[0]!.state).toBe("deployed");
    await w.wall.advance(NOW + HOUR + EVIDENCE_WAIT_MS + 1);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
    expect(fixedIn(w)).toBeNull();
  });
});

describe("a drill receipt and the exposure of the class (Astra, 2026-10-27)", () => {
  it("a passed bench and a quiet canary without a drill receipt of the shipped version wait; with the receipt the repair is accepted", async () => {
    const w = world();
    await deployed(w);
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    w.state.drillReceipt = false;
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "deployed" });
    w.state.drillReceipt = true;
    await w.wall.advance(NOW + 4 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "accepted" });
  });

  it("the class failing in 10 of 10 attempts of the shipped version in its own project: not accepted, the merge is reverted", async () => {
    const w = world();
    await deployed(w);
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    w.state.compare = "inconclusive";
    for (let i = 0; i < 10; i++) w.h.attempt("blocked", REASON, NOW + 2 * HOUR + i * 1000, { version: "0.1.269", task: `tg${i}` });
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "red" });
    expect(w.state.reverted).toEqual(["c0ffee".padEnd(40, "1")]);
    expect(fixedIn(w)).toBeNull();
  });

  it("clean attempts in projects the class never ran in do not accept the repair", async () => {
    const w = world();
    await deployed(w);
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    w.state.compare = "inconclusive";
    for (let i = 0; i < 20; i++) w.h.attempt("accepted", null, NOW + 2 * HOUR + i, { version: "0.1.269", run: "run_sand" });
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "deployed" });
  });
});

describe("a runnable bench is availability, not a passed bench (review section 2)", () => {
  const JUDGE = [{ path: "src/rooms/verification/gate-output.ts", status: "M" }, { path: "tests/gate-output-new.test.ts", status: "A" }];

  it("a repair of the judge merges provisionally and is accepted only on the bench result, not on attempts of the new version", async () => {
    const w = world({ changed: JUDGE });
    await deployed(w);
    const merged = listRepairs(w.h.db)[0]!;
    expect(merged.policy).toMatchObject({ decision: "merge", strict: true, provisional: true, requireBench: true });
    expect((merged.policy as { change: { attrs: Record<string, unknown> } }).change.attrs).toMatchObject({ bench_available: true, rollback_path_ok: true });
    w.state.canary = { version: "0.1.269", tripped: false, windowOpen: false };
    w.state.compare = "inconclusive";
    for (let i = 0; i < 30; i++) w.h.attempt("accepted", null, NOW + 2 * HOUR + i, { version: "0.1.269" });
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]!.state).toBe("deployed");        // thirty good attempts do not vouch for a change of the judge
    w.state.compare = "pass";
    await w.wall.advance(NOW + 4 * HOUR);
    expect(listRepairs(w.h.db)[0]!.state).toBe("accepted");
  });

  it("a revert that is stuck is not a rollback path: the next change of the judge is rejected on it", async () => {
    const w = world({ changed: JUDGE });
    await w.wall.runNight({ now: NOW });
    const stuck = insertRepair(w.h.db, { classKey: "other:1", signature: "sig-stuck", night: "2026-10-24", round: 1, role: "engineer", brief: {}, versionBefore: "0.1.268", tokensEst: 1, now: NOW - 48 * HOUR });
    updateRepair(w.h.db, stuck.id, { state: "rollback_pending" }, NOW - 47 * HOUR);
    const assignment = w.wall.nextAssignment()!;
    w.wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
    expect(await w.wall.mergeGate(assignment.signature, { threadId: "thr_fix" })).toBe("release");
    const row = listRepairs(w.h.db).find((item) => item.id === assignment.id)!;
    expect((row.policy as { reason: string }).reason).toMatch(/revert is not in working order/);
  });
});

describe("a later release voids a repair's evidence only when it touched the repair or its class (Fable's recheck of 0.1.341, R5)", () => {
  const release341 = (w: Fakes, canary = true) => {
    w.state.version = "0.1.341";
    if (canary) w.state.canary = { version: "0.1.341", tripped: false, windowOpen: false };
  };

  it("a release that changed other files leaves the repair judged: the running version's canary, bench and drill decide", async () => {
    const w = world({ releaseFiles: ["CHANGELOG.md", "package.json", "src/rooms/council/server/council.ts"] });
    await deployed(w, "0.1.340");
    release341(w);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(w.state.asked).toEqual([["0.1.340", "0.1.341"]]);
    expect(w.state.compared).toEqual([["night-0.1.268", "night-0.1.341"]]);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "accepted", shippedVersion: "0.1.340" });
  });

  it("without the canary of the running version it keeps waiting, it is not set aside", async () => {
    const w = world({ releaseFiles: ["src/rooms/council/server/council.ts"] });
    await deployed(w, "0.1.340");
    release341(w, false);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "deployed" });
  });

  it("a release that changed a file of the repair voids it as before", async () => {
    const w = world({ releaseFiles: ["CHANGELOG.md", "src/rooms/relay/server/relay.ts"] });
    await deployed(w, "0.1.340");
    release341(w);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(w.state.compared).toEqual([]);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
    expect(listRepairs(w.h.db)[0]!.outcome).toMatch(/0\.1\.341 was released after 0\.1\.340/);
  });

  it("a release that changed the source of the failure class voids it", async () => {
    const w = world({ releaseFiles: ["src/rooms/writer/server/lock-holder.ts"], classFiles: ["src/rooms/writer/server/lock-holder.ts"] });
    await deployed(w, "0.1.340");
    release341(w);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
  });

  it("a release whose files cannot be told voids it (nothing shows it was unrelated)", async () => {
    const w = world({ releaseFiles: null });
    await deployed(w, "0.1.340");
    release341(w);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
  });

  it("a repair set aside by the old rule is judged again once its release is known to be unrelated, and only inside the evidence wait", async () => {
    const w = world({ releaseFiles: null });
    await deployed(w, "0.1.340");
    release341(w);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
    w.state.releaseFiles = ["src/rooms/council/server/council.ts"];
    const notes = await w.wall.advance(NOW + 4 * HOUR);
    expect(notes.join("|")).toMatch(/judged again/);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "accepted" });
  });

  it("is judged again only once: when the release did touch the repair it stays unproven, and the next advance does not reopen it", async () => {
    const w = world({ releaseFiles: ["src/rooms/relay/server/relay.ts"] });
    await deployed(w, "0.1.340");
    release341(w, false);
    await w.wall.advance(NOW + 3 * HOUR);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
    const again = await w.wall.advance(NOW + 4 * HOUR);
    expect(again.join("|")).not.toMatch(/judged again/);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
  });

  it("an old unproven repair (past the evidence wait) is not reopened", async () => {
    const w = world({ releaseFiles: null });
    await deployed(w, "0.1.340");
    release341(w, false);
    await w.wall.advance(NOW + 3 * HOUR);
    w.state.releaseFiles = ["src/rooms/council/server/council.ts"];
    const notes = await w.wall.advance(NOW + 3 * HOUR + EVIDENCE_WAIT_MS + HOUR);
    expect(notes.join("|")).not.toMatch(/judged again/);
    expect(listRepairs(w.h.db)[0]).toMatchObject({ state: "unproven" });
  });
});
