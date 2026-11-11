import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createAttempt, createRun, createTask, migrations, openDatabase, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { listEvidence } from "../../src/rooms/storage";
import type { Services } from "../../server";
import {
  claimScope, forceClearClaim, GUEST_TTL_MS, listClaims, listGuests, listLiveWindows, noteCheckoutGuest,
  projectCheckoutPaths, releaseClaim, windowCollisions, workFingerprint,
} from "../../src/rooms/verification/server";

const PATH = "/repo/plugin";

function open(metadata: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async ({ threadId }: { threadId: string }) => metadata[threadId] ?? null,
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

  it("[sma:k_v_release + sma:k_lib_termattempt] release by the holder deletes the claim, prints edits_left, and writes a window evidence record with base, the changed files and the outcome; a release by another thread is refused", async () => {
    const { harness, db, kv } = cli(async (_m, input) => {
      const command = input.command ?? "";
      if (command === "git rev-parse HEAD") return { exitCode: 0, stdout: "ba5e\n", stderr: "" };
      if (command.startsWith("git status")) return { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" };
      if (command.startsWith("git diff")) return { exitCode: 0, stdout: "src/app.ts\nsrc/new.ts\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"], base: "ba5e" });
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
    expect(checks.base).toBe("ba5e");
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
