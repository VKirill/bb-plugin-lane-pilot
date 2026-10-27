import { describe, expect, it } from "vitest";
import { hostContract } from "../../src/rooms/contracts/host";
import { createWall, ROLLBACK_TRIES, type WallPorts } from "../../src/rooms/wall/service";
import { fullCommit, revertMerge, type RevertHost } from "../../src/rooms/wall/revert";
import { listRepairs } from "../../src/rooms/wall/store";
import { wallSignature } from "../../src/rooms/wall/signature";
import { HOUR, NOW, freshDb, isReal } from "./helpers";

/** The wall repairs of the review: the merge was kept as «merged <12 chars>» and the 12 characters went to `gitRevertCommits`. */
const FULL = "29754b58888b6f1c0d4e5a7b9c3d2e1f0a8b7c6d";
const SHORT = FULL.slice(0, 12);

/** A host that holds every call to the real input schema of its method, the way the plugin's host does. */
function schemaHost(options: { revert?: "reverted" | "conflict"; refuse?: boolean } = {}) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const host: RevertHost = {
    call: async (method, input) => {
      const contract = (hostContract as unknown as Record<string, { input: { parse(value: unknown): unknown } }>)[method];
      contract!.input.parse(input);                                  // throws like «host rpc input validation failed»
      calls.push({ method, input: input as Record<string, unknown> });
      if (options.refuse) throw new Error("host is not connected");
      if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: `${FULL}\n`, stderr: "" };
      if (method === "gitCreateWorktree") return { status: "ready", path: "/wt/night-revert", branch: "lane/x", reason: null };
      if (method === "gitRevertCommits") return { hostId: "h", status: options.revert ?? "reverted", commits: [], conflicts: ["src/a.ts"], later: [], reason: null };
      if (method === "gitIntegrate") return { hostId: "h", status: "merged", commit: "f".repeat(40), conflicts: [], reason: null };
      return { hostId: "h", removed: true };
    },
  };
  return { host, calls };
}

describe("the revert reaches the host with a commit the host accepts", () => {
  it("the 12 characters the first version passed are refused by the real schema (the live failure)", () => {
    const schema = (hostContract as unknown as Record<string, { input: { parse(value: unknown): unknown } }>).gitRevertCommits!.input;
    expect(() => schema.parse({ requestedHostId: "h", worktreePath: "/wt/x", commits: [SHORT] })).toThrow(/pattern/);
    expect(() => schema.parse({ requestedHostId: "h", worktreePath: "/wt/x", commits: [FULL] })).not.toThrow();
  });

  it("a full SHA goes through as it is; an abbreviated one stored in an old row is resolved with git first", async () => {
    const full = schemaHost();
    expect(await revertMerge(full.host, { hostId: "h", basePath: "/repo" }, FULL)).toMatchObject({ ok: true });
    expect(full.calls.some((call) => call.method === "runCommand")).toBe(false);
    expect(full.calls.find((call) => call.method === "gitRevertCommits")!.input.commits).toEqual([FULL]);

    const short = schemaHost();
    const result = await revertMerge(short.host, { hostId: "h", basePath: "/repo" }, SHORT);
    expect(result.ok).toBe(true);
    expect(short.calls.find((call) => call.method === "runCommand")!.input).toMatchObject({ cwd: "/repo", command: `git rev-parse --verify --quiet ${SHORT}^{commit}` });
    expect(short.calls.find((call) => call.method === "gitRevertCommits")!.input.commits).toEqual([FULL]);
  });

  it("text that is no commit never reaches a shell or the host; a conflict is a failed revert with its files", async () => {
    const { host, calls } = schemaHost();
    expect(await fullCommit(host, { hostId: "h", basePath: "/repo" }, "merged; rm -rf /")).toBeNull();
    expect(await revertMerge(host, { hostId: "h", basePath: "/repo" }, "up-to-date")).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
    const conflict = schemaHost({ revert: "conflict" });
    expect(await revertMerge(conflict.host, { hostId: "h", basePath: "/repo" }, FULL)).toEqual({ ok: false, detail: "conflict: src/a.ts" });
    expect(conflict.calls.some((call) => call.method === "gitRemoveWorktree")).toBe(true);
  });
});

describe("a revert that throws leaves no worktree behind", () => {
  it("the host refusing the call after the worktree was made removes the worktree and the error reaches the caller", async () => {
    const calls: string[] = [];
    const host: RevertHost = {
      call: async (method) => {
        calls.push(method);
        if (method === "gitCreateWorktree") return { status: "ready", path: "/wt/night-revert", branch: "lane/x", reason: null };
        if (method === "gitRevertCommits") throw new Error("host rpc input validation failed");
        return { removed: true };
      },
    };
    await expect(revertMerge(host, { hostId: "h", basePath: "/repo" }, FULL)).rejects.toThrow(/validation failed/);
    expect(calls).toEqual(["gitCreateWorktree", "gitRevertCommits", "gitRemoveWorktree"]);
  });
});

const REASON = "internal_error: another writer integration holds the base checkout lpattempt_aaa";
const KEY = wallSignature("blocked", REASON).classKey;

/** The wall with a repair merged and deployed, and a revert port that answers as told. */
function mergedWall(reverts: Array<{ ok: boolean; detail: string }>, commit = FULL) {
  const h = freshDb();
  for (let i = 0; i < 25; i++) h.attempt("accepted", null, NOW - 20 * HOUR + i);
  for (let i = 0; i < 5; i++) h.attempt("blocked", REASON, NOW - 3 * HOUR + i * 1000, { version: "0.1.268", task: `tf${i}` });
  const state = { version: "0.1.268", reverted: [] as string[], deferrals: new Map<string, string>(), time: NOW };
  const ports: WallPorts = {
    now: () => state.time, get version() { return state.version; },
    loadScope: async () => ({ isReal, scopeOf: () => "real" }), logLines: () => [], codeFiles: async () => [], reader: async () => ({ text: null, tokens: 0 }), tellPm: async () => true,
    repair: {
      view: async () => ({ threadId: "thr_fix", verdict: "fixed", outcome: null, branch: "b", worktreePath: "/wt", spawnedAt: NOW }),
      report: async () => "", tokens: async () => 1, busy: async () => false, changedFiles: async () => ["src/rooms/relay/server/relay.ts"],
      revert: async (sha) => { state.reverted.push(sha); return reverts.shift() ?? { ok: false, detail: "no more answers" }; },
    },
    release: { drill: async () => ({ version: "0.1.269", at: NOW + HOUR + 5, ok: true }), canary: async () => ({ version: "0.1.269", tripped: true, windowOpen: false }) },
    bench: { available: async () => true, ensureArm: async () => "running", compare: async () => "pass", score: async () => 0.5 },
    restart: async () => ({ ok: true, note: "" }),
    deferrals: { open: (input) => { state.deferrals.set(input.id, input.what); }, close: () => undefined },
  };
  const kv = new Map<string, unknown>();
  const wall = createWall({ db: h.db, kv: { get: async (key) => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); } }, ports, log: () => undefined, hubDb: "/hub/data.db" });
  return { h, wall, state, commit };
}

async function redCanaryAfterMerge(world: ReturnType<typeof mergedWall>) {
  const { wall, state } = world;
  await wall.runNight({ now: NOW });
  const assignment = wall.nextAssignment()!;
  wall.started(assignment.id, { threadId: "thr_fix", branch: "b", at: NOW });
  await wall.mergeGate(assignment.signature, { threadId: "thr_fix" });
  wall.settled(assignment.signature, { outcome: `merged ${world.commit.slice(0, 12)}`, verdict: "fixed", commit: world.commit });
  state.version = "0.1.269";
  state.time = NOW + HOUR;
  await wall.advance(state.time);                                  // deployed
  state.time = NOW + 2 * HOUR;
  await wall.advance(state.time);                                  // the canary tripped: red, revert
}

describe("a failed rollback is retried, not forgotten", () => {
  it("the revert fails: the repair stays open as rollback_pending with its error, and the class is not repaired on top of it", async () => {
    const world = mergedWall([{ ok: false, detail: "host is not connected" }]);
    await redCanaryAfterMerge(world);
    const row = listRepairs(world.h.db)[0]!;
    expect(row.state).toBe("rollback_pending");
    expect(row.acceptance).toMatchObject({ rollback: { attempts: 1, lastError: "host is not connected" } });
    expect(row.outcome).toMatch(/revert failed \(try 1 of 6\)/);
    expect(world.wall.classes().find((cls) => cls.classKey === KEY)).toMatchObject({ failedMoves: 0 });   // the round is judged when the revert settles
    expect(world.state.reverted).toEqual([FULL]);
    // Another night does not pick the class while its merge is still in the checkout.
    expect((await world.wall.runNight({ now: NOW + 3 * HOUR, dryRun: true })).picked).toEqual([]);
  });

  it("the next ticks try again, no faster than every ten minutes, and a revert that goes through ends the repair as red and reverted", async () => {
    const world = mergedWall([{ ok: false, detail: "host is not connected" }, { ok: true, detail: "merged abc" }]);
    await redCanaryAfterMerge(world);
    await world.wall.advance(NOW + 2 * HOUR + 60_000);             // too soon
    expect(world.state.reverted).toHaveLength(1);
    await world.wall.advance(NOW + 2 * HOUR + 11 * 60_000);
    expect(world.state.reverted).toEqual([FULL, FULL]);
    expect(listRepairs(world.h.db)[0]).toMatchObject({ state: "red", acceptance: expect.objectContaining({ revertedAt: expect.any(Number) }) });
    expect(listRepairs(world.h.db)[0]!.outcome).toMatch(/revert committed on try 2/);
    expect(world.wall.classes().find((cls) => cls.classKey === KEY)).toMatchObject({ failedMoves: 1 });
  });

  it("after the last try it is given up with its diagnosis in the backlog, not left quiet", async () => {
    const world = mergedWall(Array.from({ length: 10 }, () => ({ ok: false, detail: "conflict: src/rooms/verification/sandbox.ts" })));
    await redCanaryAfterMerge(world);
    for (let i = 1; i < ROLLBACK_TRIES; i++) await world.wall.advance(NOW + 2 * HOUR + i * 11 * 60_000);
    const row = listRepairs(world.h.db)[0]!;
    expect(world.state.reverted).toHaveLength(ROLLBACK_TRIES);
    expect(row.state).toBe("red");
    expect(row.acceptance).toMatchObject({ rollback: { attempts: ROLLBACK_TRIES, gaveUp: true } });
    expect(row.outcome).toMatch(/revert failed 6 times, last: conflict: src\/rooms\/verification\/sandbox\.ts/);
    // The backlog item is the wall and the owner's morning line, which carries the diagnosis (no deferral is opened).
    expect((world.h.db.prepare("SELECT what FROM lane_pilot_owner_item").all() as Array<{ what: string }>).map((item) => item.what).join("\n")).toMatch(/stays in the checkout.*conflict: src\/rooms\/verification\/sandbox\.ts/s);
    expect(world.wall.status().walls.map((wall) => wall.state)).toContain("backlog");
    // A rollback that gave up is not a rollback path: the next judge change is not merged on its word.
    expect(world.wall.classes().find((cls) => cls.classKey === KEY)).toMatchObject({ failedMoves: 1 });
  });
});

describe("the three live repairs whose revert never ran", () => {
  const stuck = async (reason: string) => {
    const world = mergedWall([{ ok: true, detail: "merged abc" }], SHORT);
    await world.wall.runNight({ now: NOW });
    const id = listRepairs(world.h.db)[0]!.id;
    // The state the first version left: red, the short commit, the validation error as outcome, no rollback record.
    world.h.db.prepare("UPDATE lane_pilot_wall_repair SET state='red', merged_commit=?, outcome=?, acceptance_json=? WHERE id=?")
      .run(SHORT, `${reason}; revert failed: host rpc input validation failed: Invalid string: must match pattern /^[a-f0-9]{40,64}$/`,
        JSON.stringify({ reason, mergedAtVersion: "0.1.305" }), id);
    return world;
  };

  it("red only by the bench (the October rows: 305→328, two paired tasks) is not undone: it is unproven", async () => {
    const world = await stuck("the bench subset is worse than the previous version: the night reverts the merge");
    const notes = await world.wall.advance(NOW + HOUR);
    expect(notes.join("|")).toMatch(/inconclusive bench comparison; left in place as unproven/);
    expect(world.state.reverted).toEqual([]);
    expect(listRepairs(world.h.db)[0]).toMatchObject({ state: "unproven" });
  });

  it("red for another reason is revisited on the next tick, and the short SHA reaches the revert for git to resolve, once", async () => {
    const world = await stuck("the class failed again on the shipped version: the night reverts the merge");
    const notes = await world.wall.advance(NOW + HOUR);
    expect(notes.join("|")).toMatch(/never ran; tried again/);
    expect(world.state.reverted).toEqual([SHORT]);
    expect(listRepairs(world.h.db)[0]).toMatchObject({ state: "red", acceptance: expect.objectContaining({ revertedAt: expect.any(Number) }) });
    await world.wall.advance(NOW + 2 * HOUR);
    expect(world.state.reverted).toEqual([SHORT]);
  });
});
