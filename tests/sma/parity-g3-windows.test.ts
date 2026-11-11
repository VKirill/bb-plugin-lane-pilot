import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createAttempt, createRun, createTask, migrations, openDatabase, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { listEvidence } from "../../src/rooms/storage";
import type { Services } from "../../server";
import {
  CLAIMS_MAX, claimScope, forceClearClaim, GUEST_TTL_MS, trimGuests, withGuestsLock, listClaims, listGuests, listLiveWindows, noteCheckoutGuest,
  projectCheckoutPaths, releaseClaim, windowCollisions, workFingerprint,
} from "../../src/rooms/verification/server";

const PATH = "/repo/plugin";

function open(metadata: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata[threadId] ?? null,
    // thr_a, thr_b and the like live in project P; thr_other in Q; thr_ghost does not exist.
    get: async ({ threadId }: { threadId: string }) => (threadId === "thr_ghost" ? null : { id: threadId, projectId: threadId === "thr_other" ? "Q" : "P" }),
  } } as never });
  const db = openDatabase(bb);
  return { bb, harness, db, kv: bb.storage.kv };
}

const config = (db: ReturnType<typeof openDatabase>) => savePrototypeConfig(db, {
  projectId: "P", hostId: "h1", pmWorkspacePath: "/repo/pm", writerWorkspacePath: PATH,
  pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m",
});

const taskContract = (owns: string[]) => ({ id: "t1", owns_paths: owns });

describe("parity g3 windows", () => {
  it("[sma:k_st_sessions] a Guest written by an older build (threadId, at only) still loads; a new one round-trips providerId, label and claims through kv", async () => {
    const { kv } = open();
    await kv.set("checkout-guests:/repo/plugin", [{ threadId: "thr_old", at: Date.now() }] as never);
    expect((await listGuests(kv as never, PATH)).map((row) => row.threadId)).toEqual(["thr_old"]);
    const claim = { name: "ui", globs: ["src/**"], description: "d", base: "abc", threadId: "thr_new", at: Date.now() };
    await kv.set("checkout-guests:/repo/plugin", [{ threadId: "thr_new", at: Date.now(), providerId: "claude-code", label: "mine", claims: [claim] }] as never);
    const [guest] = await listGuests(kv as never, PATH);
    expect(guest!.providerId).toBe("claude-code");
    expect(guest!.label).toBe("mine");
    expect(guest!.claims).toEqual([claim]);
  });

  it("[sma:k_lib_registry] an ordinary chat sending in a project checkout with no active run is listed by listLiveWindows(projectId); after the TTL it is not; a chat with a Lane Pilot role is never listed", async () => {
    const { bb, db, kv } = open({ thr_writer: { role: "writer" } });
    config(db); // a configured checkout, but no run at all
    await noteCheckoutGuest(bb, db, "thr_owner", PATH, { providerId: "claude-code" });
    await noteCheckoutGuest(bb, db, "thr_writer", PATH);
    const now = Date.now();
    const live = await listLiveWindows(kv as never, projectCheckoutPaths(db, "P"), now);
    expect(live.map((row) => row.threadId)).toEqual(["thr_owner"]);
    expect(live[0]!.providerId).toBe("claude-code");
    expect(await listLiveWindows(kv as never, projectCheckoutPaths(db, "P"), now + GUEST_TTL_MS + 1)).toEqual([]);
    // A folder that is no checkout of a Lane Pilot project is never leased.
    await noteCheckoutGuest(bb, db, "thr_else", "/elsewhere");
    expect(await listLiveWindows(kv as never, ["/elsewhere"])).toEqual([]);
  });

  it("[sma:k_st_claims] a claim round-trips name, globs, base sha, holder thread and time through the guest entry and is dropped with an expired lease", async () => {
    const { kv } = open();
    const at = Date.now();
    const result = await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**", "docs/**"], description: "front end", base: "deadbeef", now: at });
    expect(result.ok).toBe(true);
    const [claim] = await listClaims(kv as never, PATH);
    expect(claim).toEqual({ name: "ui", globs: ["src/**", "docs/**"], description: "front end", base: "deadbeef", threadId: "thr_a", at });
    expect(await listClaims(kv as never, PATH, at + GUEST_TTL_MS + 1)).toEqual([]);
  });

  it("[sma:k_lib_claims] two claimScope calls with the same name from different threads fired together: exactly one returns ok, the other claim_taken with the holder; an invalid glob stores nothing", async () => {
    const { kv } = open();
    const [first, second] = await Promise.all([
      claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] }),
      claimScope(kv as never, { path: PATH, threadId: "thr_b", name: "ui", globs: ["lib/**"] }),
    ]);
    const results = [first, second];
    expect(results.filter((row) => row.ok)).toHaveLength(1);
    const loser = results.find((row) => !row.ok)!;
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.code).toBe("claim_taken");
      expect(loser.holder).toMatch(/^thr_[ab]$/);
    }
    // An invalid glob stores nothing: no claim, and not even a lease rewrite of the claim list.
    const bad = await claimScope(kv as never, { path: PATH, threadId: "thr_c", name: "docs", globs: ["../outside/**"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_glob");
    expect((await listClaims(kv as never, PATH)).map((row) => row.name)).toEqual(["ui"]);
  });

  it("[sma:k_lib_collision] windowCollisions of two overlapping claims and one open task returns the claim pair and the claim-task pair, [] for disjoint globs, and [] (no throw) for malformed input", () => {
    const claims = [
      { name: "ui", globs: ["src/**"] },
      { name: "page", globs: ["src/page/**"] },
      { name: "docs", globs: ["docs/**"] },
    ];
    const tasks = [{ id: "t1", globs: ["src/app.ts"] }];
    const hits = windowCollisions(claims, tasks);
    expect(hits).toContainEqual({ a: "ui", b: "page", kind: "claim" });
    expect(hits).toContainEqual({ a: "ui", b: "t1", kind: "task" });
    // The kit's conservative literal-base rule: src/page/** does not provably cover src/app.ts, so no pair.
    expect(hits).not.toContainEqual({ a: "page", b: "t1", kind: "task" });
    expect(hits.filter((hit) => hit.a === "docs" || hit.b === "docs")).toEqual([]);
    expect(windowCollisions([{ name: "x" } as never], null as never)).toEqual([]);
  });

  it("[sma:k_lib_fingerprint] workFingerprint on a fake host returning branch and 60 porcelain lines yields the branch and at most 50 paths; a failing host yields an empty fingerprint without throwing", async () => {
    const host = { call: async (_method: string, input: { command?: string }) => {
      if (input.command === "git rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: "parity/g3\n", stderr: "" };
      if (input.command === "git status --porcelain -uall") return { exitCode: 0, stdout: Array.from({ length: 60 }, (_, i) => ` M file${i}.ts`).join("\n"), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    } };
    const fp = await workFingerprint(host as never, "h1", PATH);
    expect(fp.branch).toBe("parity/g3");
    expect(fp.paths.length).toBeLessThanOrEqual(50);
    expect(fp.paths).toContain("file3.ts");
    const dead = { call: async () => { throw new Error("host gone"); } };
    await expect(workFingerprint(dead as never, "h1", PATH)).resolves.toEqual({ branch: null, paths: [] });
  });
});

describe("parity g3 window verbs", () => {
  function cli(hostCall: (method: string, input: { command?: string }) => Promise<unknown>, metadata: Record<string, unknown> = {}) {
    const { bb, harness, db, kv } = open(metadata);
    bb.hosts.experimental_client = (() => ({ call: hostCall })) as never;
    config(db);
    registerCli(createCore(bb, db), {} as Services, migrations);
    return { bb, harness, db, kv };
  }

  it("[sma:k_v_status] window status lists the guests of a project's checkout with claims and collisions: both threads, their claims and the task's owns_paths appear, the collisions are printed, exit 0", async () => {
    const { harness, db, kv } = cli(async () => ({ exitCode: 0, stdout: "main\n", stderr: "" }));
    createRun(db, "run", "P", "cli", PATH);
    createTask(db, { id: "t1", runId: "run", kind: "cli", contract: taskContract(["src/**"]) });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    await claimScope(kv as never, { path: PATH, threadId: "thr_b", name: "docs", globs: ["docs/**"] });
    const out = await harness.behavior.runCli(["window", "status", "P"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("thr_a");
    expect(out.stdout).toContain("thr_b");
    expect(out.stdout).toContain("ui");
    expect(out.stdout).toContain("docs");
    expect(out.stdout).toContain("t1");
    expect(out.stdout).toContain("src/**");
    // The claim ui overlaps the open task's owns_paths; docs does not.
    expect(out.stdout).toMatch(/collision: ui.*overlaps.*t1 \(task\)/);
    expect(out.stdout).not.toMatch(/collision: docs/);
  });

  it("[sma:k_v_claim] window claim records a named glob claim for the calling thread and prints a collision with an open task's owns_paths; a same-name claim of another live thread exits 1; the claim stores HEAD as base", async () => {
    const { harness, db, kv } = cli(async (_m, input) => ({
      exitCode: 0, stderr: "",
      stdout: input.command === "git rev-parse HEAD" ? "c0ffee00\n" : "main\n",
    }));
    createRun(db, "run", "P", "cli", PATH);
    createTask(db, { id: "t1", runId: "run", kind: "cli", contract: taskContract(["src/**"]) });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const ok = await harness.behavior.runCli(["window", "claim", "P", "thr_a", "ui", "src/**", "front end"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("claimed ui");
    expect(ok.stdout).toMatch(/collision: ui.*overlaps.*t1/);
    const [claim] = await listClaims(kv as never, PATH);
    expect(claim).toMatchObject({ name: "ui", threadId: "thr_a", base: "c0ffee00", globs: ["src/**"], description: "front end" });
    const taken = await harness.behavior.runCli(["window", "claim", "P", "thr_b", "ui", "lib/**"]);
    expect(taken.exitCode).toBe(1);
    expect(taken.stderr).toContain("thr_a");
    // The holder re-setting its own claim is not a refusal.
    const again = await harness.behavior.runCli(["window", "claim", "P", "thr_a", "ui", "app/**"]);
    expect(again.exitCode).toBe(0);
    expect((await listClaims(kv as never, PATH))[0]!.globs).toEqual(["app/**"]);
  });

  it("[sma:k_v_release] [sma:k_lib_termattempt] release by the holder deletes the claim, prints edits_left, and writes a window evidence record with base, the changed files and the outcome; a release by another thread is refused", async () => {
    const { harness, db, kv } = cli(async (_m, input) => {
      const command = input.command ?? "";
      if (command === "git rev-parse HEAD") return { exitCode: 0, stdout: "ba5e\n", stderr: "" };
      if (command.startsWith("git status")) return { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" };
      if (command.startsWith("git diff")) return { exitCode: 0, stdout: "src/app.ts\nsrc/new.ts\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"], base: "ba5e123" });
    const foreign = await harness.behavior.runCli(["window", "release", "P", "thr_b", "ui"]);
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr).toContain("thr_a");
    expect(await listClaims(kv as never, PATH)).toHaveLength(1);
    const done = await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui", "--outcome", "committed"]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("released ui (committed)");
    expect(done.stdout).toContain("src/app.ts");
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    const evidence = await listEvidence(kv as never, "P", { op: "window" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ op: "window", target: "ui", by: "thr_a" });
    const checks = Object.fromEntries(evidence[0]!.checks.map((row) => [row.name, row.detail]));
    expect(checks.base).toBe("ba5e123");
    expect(checks.files).toBe("src/app.ts, src/new.ts");
    expect(checks.outcome).toBe("committed");
  });

  it("[sma:k_v_forceclear] window force-clear without --reason refuses and deletes nothing; with --reason it writes the evidence record first and then deletes the foreign claim", async () => {
    const { harness, db, kv } = cli(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    const bare = await harness.behavior.runCli(["window", "force-clear", "P", "ui"]);
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toMatch(/reason/);
    expect(await listClaims(kv as never, PATH)).toHaveLength(1);
    const cleared = await harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "stale claim, holder left for the day"]);
    expect(cleared.exitCode).toBe(0);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    const evidence = await listEvidence(kv as never, "P", { op: "window" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ op: "window", target: "ui", why: "stale claim, holder left for the day" });
    expect(evidence[0]!.checks.map((row) => row.name)).toContain("holder");
    expect(evidence[0]!.checks.find((row) => row.name === "holder")!.detail).toBe("thr_a");
  });
});

describe("parity g3 window review fixes", () => {
  function cli(hostCall: (method: string, input: { command?: string }) => Promise<unknown> = async () => ({ exitCode: 0, stdout: "", stderr: "" })) {
    const { bb, harness, db, kv } = open();
    bb.hosts.experimental_client = (() => ({ call: hostCall })) as never;
    config(db);
    registerCli(createCore(bb, db), {} as Services, migrations);
    return { bb, harness, db, kv };
  }
  const as = (threadId: string) => ({ threadId });

  it("[review 1] force-clear from any thread is refused and the claim stays; the owner without a thread clears it", async () => {
    const { harness, kv } = cli();
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    const refused = await harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "x"], as("thr_b"));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/owner at a terminal/);
    expect(await listClaims(kv as never, PATH)).toHaveLength(1);
    expect((await harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "x"])).exitCode).toBe(0);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
  });

  it("[review 1] a chat claims and releases only for itself and in its own project; status shows a chat its own project only", async () => {
    const { harness, kv } = cli();
    const other = await harness.behavior.runCli(["window", "claim", "P", "thr_b", "ui", "src/**"], as("thr_a"));
    expect(other.exitCode).toBe(1);
    expect(other.stderr).toMatch(/only for itself/);
    const wrongProject = await harness.behavior.runCli(["window", "claim", "P", "thr_other", "ui", "src/**"], as("thr_other"));
    expect(wrongProject.exitCode).toBe(1);
    expect(wrongProject.stderr).toMatch(/own project/);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    expect((await harness.behavior.runCli(["window", "claim", "P", "thr_a", "ui", "src/**"], as("thr_a"))).exitCode).toBe(0);
    const foreignRelease = await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"], as("thr_b"));
    expect(foreignRelease.exitCode).toBe(1);
    expect(foreignRelease.stderr).toMatch(/only for itself/);
    const foreignStatus = await harness.behavior.runCli(["window", "status", "P"], as("thr_other"));
    expect(foreignStatus.exitCode).toBe(1);
    expect(foreignStatus.stderr).toMatch(/own project/);
    expect((await harness.behavior.runCli(["window", "status", "P"], as("thr_a"))).exitCode).toBe(0);
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"], as("thr_a"))).exitCode).toBe(0);
  });

  it("[review 1] the owner at a terminal cannot claim for a thread that does not exist; nothing is stored", async () => {
    const { harness, kv } = cli();
    const ghost = await harness.behavior.runCli(["window", "claim", "P", "thr_ghost", "ui", "src/**"]);
    expect(ghost.exitCode).toBe(1);
    expect(ghost.stderr).toMatch(/no thread thr_ghost/);
    expect(await kv.get("checkout-guests:/repo/plugin")).toBeFalsy();
  });

  it("[review 2] force-clear whose evidence cannot be written clears nothing; release still releases and says so", async () => {
    const { harness, kv } = cli();
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    const set = kv.set.bind(kv);
    (kv as { set: unknown }).set = async (key: string, value: never) => { if (key.startsWith("evidence:")) throw new Error("kv down"); return set(key, value); };
    const cleared = await harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "x"]);
    expect(cleared.exitCode).toBe(1);
    expect(cleared.stderr).toContain("evidence not written; nothing cleared");
    expect(await listClaims(kv as never, PATH)).toHaveLength(1);
    const released = await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"]);
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain("evidence not written");
    expect(await listClaims(kv as never, PATH)).toEqual([]);
  });

  it("[review 3] trimming drops expired entries, then live ones without claims, never a live claim holder; the 41st claim is refused", async () => {
    const now = Date.now();
    const claim = (n: number) => ({ name: `c${n}`, globs: ["a"], description: "", base: null, threadId: `h${n}`, at: now });
    const holders = Array.from({ length: 12 }, (_, i) => ({ threadId: `h${i}`, at: now - 1000 * (20 - i), claims: [claim(i)] }));
    const extra = [{ threadId: "dead", at: now - GUEST_TTL_MS - 5 }, { threadId: "plain", at: now - 10 }];
    const kept = trimGuests([...holders, ...extra], now);
    expect(kept.filter((row) => row.claims?.length)).toHaveLength(12);
    expect(kept.map((row) => row.threadId)).not.toContain("dead");
    expect(kept.map((row) => row.threadId)).not.toContain("plain");
    expect(kept.length).toBe(12);
    const { kv } = open();
    for (let i = 0; i < CLAIMS_MAX; i++) expect((await claimScope(kv as never, { path: PATH, threadId: `h${i}`, name: `n${i}`, globs: ["a/**"] })).ok).toBe(true);
    const full = await claimScope(kv as never, { path: PATH, threadId: "late", name: "late", globs: ["a/**"] });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("too_many_claims");
    expect((await claimScope(kv as never, { path: PATH, threadId: "h0", name: "n0", globs: ["b/**"] })).ok).toBe(true);
    expect((await listGuests(kv as never, PATH)).filter((row) => row.claims?.length)).toHaveLength(CLAIMS_MAX);
  });

  it("[review 4] claimScope refuses more than 20 globs, a glob over 200 characters, the whole tree and a base that is not a hex id", async () => {
    const { kv } = open();
    const base = { path: PATH, threadId: "thr_a", name: "ui" };
    const refused = async (input: Partial<Parameters<typeof claimScope>[1]>) => claimScope(kv as never, { ...base, globs: ["src/**"], ...input });
    expect((await refused({ globs: Array.from({ length: 21 }, (_, i) => `d${i}/**`) })).ok).toBe(false);
    expect((await refused({ globs: [`${"a".repeat(201)}`] })).ok).toBe(false);
    for (const whole of ["**", "*", "**/*", ".", "./**", " ** "]) {
      const hit = await refused({ globs: [whole] });
      expect(hit.ok, whole).toBe(false);
      if (!hit.ok) expect(hit.why).toMatch(/whole tree|empty/);
    }
    for (const bad of ["abc", "HEAD", "abc1234; rm -rf /", "g".repeat(10)]) expect((await refused({ base: bad })).ok, bad).toBe(false);
    expect(await kv.get("checkout-guests:/repo/plugin")).toBeFalsy();
    expect((await refused({ globs: Array.from({ length: 20 }, (_, i) => `d${i}/**`), base: "abcdef1" })).ok).toBe(true);
  });

  it("[review 4] a stored base that is not a hex id never reaches the git diff command; a good one is quoted", async () => {
    const commands: string[] = [];
    const { harness, kv } = cli(async (_m, input) => { commands.push(input.command ?? ""); return { exitCode: 0, stdout: "", stderr: "" }; });
    const at = Date.now();
    await kv.set("checkout-guests:/repo/plugin", [{ threadId: "thr_a", at, claims: [{ name: "ui", globs: ["src/**"], description: "", base: "x; rm -rf /", threadId: "thr_a", at }] }] as never);
    await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"]);
    expect(commands.some((c) => c.startsWith("git diff"))).toBe(false);
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"], base: "abcdef12" });
    await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"]);
    expect(commands).toContain("git diff --name-only 'abcdef12'");
  });

  it("[review 5] an expired lease does not carry its claims into the revived entry, and a new claim by that thread starts clean", async () => {
    const { bb, db, kv } = open();
    config(db);
    const old = Date.now() - GUEST_TTL_MS - 1000;
    await kv.set("checkout-guests:/repo/plugin", [{ threadId: "thr_a", at: old, claims: [{ name: "ui", globs: ["src/**"], description: "", base: null, threadId: "thr_a", at: old }] }] as never);
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    expect((await listGuests(kv as never, PATH))[0]!.claims).toBeUndefined();
    await kv.set("checkout-guests:/repo/plugin", [{ threadId: "thr_b", at: old, claims: [{ name: "ui", globs: ["src/**"], description: "", base: null, threadId: "thr_b", at: old }] }] as never);
    expect((await claimScope(kv as never, { path: PATH, threadId: "thr_b", name: "docs", globs: ["docs/**"] })).ok).toBe(true);
    expect((await listClaims(kv as never, PATH)).map((row) => row.name)).toEqual(["docs"]);
  });

  it("[review 6] status reads at most the 5 newest run folders and fingerprints at most 3 at a time", async () => {
    let running = 0, peak = 0;
    const { harness, db } = cli(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return { exitCode: 0, stdout: "main\n", stderr: "" }; });
    for (let i = 0; i < 9; i++) createRun(db, `run${i}`, "P", "cli", `/repo/run${i}`);
    db.prepare("UPDATE lane_pilot_run SET updated_at = CAST(substr(id, 4) AS INTEGER) + 1000").run();
    const paths = projectCheckoutPaths(db, "P");
    expect(paths.filter((row) => row.startsWith("/repo/run")).sort()).toEqual(["/repo/run4", "/repo/run5", "/repo/run6", "/repo/run7", "/repo/run8"]);
    const out = await harness.behavior.runCli(["window", "status", "P"]);
    expect(out.exitCode).toBe(0);
    expect(peak).toBeLessThanOrEqual(3);
    const dead = await harness.behavior.runCli(["window", "status", "P", "--json"]);
    expect(dead.exitCode).toBe(0);
  });

  it("[review 7] a locked job that never returns is cut after the limit, the lock is released and the next job runs", async () => {
    const stuck = withGuestsLock("/lock/test", () => new Promise<never>(() => {}), 30);
    const next = withGuestsLock("/lock/test", async () => "done", 30);
    await expect(stuck).rejects.toThrow(/timed out/);
    await expect(next).resolves.toBe("done");
  });

  it("[review 8] two notes of one thread within 5 minutes make one write; after 5 minutes the entry is written again; a role thread is never written", async () => {
    const { bb, db, kv } = open({ thr_writer: { role: "writer" } });
    config(db);
    const set = vi.spyOn(kv, "set");
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    expect(set.mock.calls.filter(([key]) => String(key).startsWith("checkout-guests:"))).toHaveLength(1);
    const guests = (await kv.get("checkout-guests:/repo/plugin")) as Array<{ threadId: string; at: number }>;
    await kv.set("checkout-guests:/repo/plugin", guests.map((row) => ({ ...row, at: row.at - 6 * 60_000 })) as never);
    set.mockClear();
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    expect(set).toHaveBeenCalledTimes(1);
    await noteCheckoutGuest(bb, db, "thr_writer", PATH);
    expect((await listGuests(kv as never, PATH)).map((row) => row.threadId)).toEqual(["thr_a"]);
  });
});
