// Region 20 · Terminal coordination, batch a: two actors against one scratch state, the outcome checked for both
// (the second is refused / waits / sees the first one's claim; the claim is gone after release).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { migrations, openDatabase, savePrototypeConfig, saveProjectSetting } from "../../src/rooms/plugin-db";
import { listEvidence } from "../../src/rooms/storage";
import type { Services } from "../../server";
import { claimScope, listClaims, listLiveWindows, noteCheckoutGuest, projectCheckoutPaths, releaseClaim } from "../../src/rooms/verification/server";
import { buildCapsule } from "../../src/rooms/session-hooks/logic";
import { createRelay, type RelayItem } from "../../src/rooms/relay/server/relay";
import { EVENT_FIELDS, postEvent, taskEventBody } from "../../src/rooms/relay/server/outbound";
import { collectHandoffBrief } from "../../src/rooms/writer/server/writer-handoff";
import { BASE_MOVED, HEAD_MOVED } from "../../src/rooms/verification/git-integrate/git-core";
import { createWorktree, integrateWorktree, syncWorktree } from "../../src/rooms/verification/git-integrate";
import migrationLock from "../fixtures/migrations.lock.json";

vi.setConfig({ testTimeout: 120_000 });

const PATH = "/repo/plugin";
const KEY = "checkout-guests:/repo/plugin";

function open() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async () => null,
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "P" }),
  } } as never });
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo/pm", writerWorkspacePath: PATH, pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
  return { bb, harness, db, kv: bb.storage.kv };
}
function cli(hostCall: (method: string, input: { command?: string }) => Promise<unknown> = async () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const world = open();
  world.bb.hosts.experimental_client = (() => ({ call: hostCall })) as never;
  registerCli(createCore(world.bb, world.db), {} as Services, migrations);
  return world;
}

describe("region 20 windows: two terminals in one project", () => {
  it("[sma:k_v_heartbeat] a window that keeps sending keeps its lease and its claim, one that went quiet drops out of the live list, and re-claiming renews a claim's lease", async () => {
    const { bb, db, kv } = open();
    const hour = 3_600_000;
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    await noteCheckoutGuest(bb, db, "thr_b", PATH);
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    await claimScope(kv as never, { path: PATH, threadId: "thr_c", name: "docs", globs: ["docs/**"], now: Date.now() - 5.5 * hour });
    // Everyone's last sign of life is 5.5 hours old (thr_c's is its claim).
    const old = (await kv.get(KEY)) as Array<{ threadId: string; at: number }>;
    await kv.set(KEY, old.map((row) => ({ ...row, at: row.threadId === "thr_c" ? row.at : row.at - 5.5 * hour })) as never);
    const paths = projectCheckoutPaths(db, "P");
    expect((await listLiveWindows(kv as never, paths)).map((row) => row.threadId).sort()).toEqual(["thr_a", "thr_b", "thr_c"]);
    // thr_a sends a message again (the heartbeat), thr_c claims again; thr_b says nothing.
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    await claimScope(kv as never, { path: PATH, threadId: "thr_c", name: "docs", globs: ["docs/**"] });
    const later = Date.now() + hour;
    const live = await listLiveWindows(kv as never, paths, later);
    expect(live.map((row) => row.threadId).sort()).toEqual(["thr_a", "thr_c"]);
    expect(live.find((row) => row.threadId === "thr_a")!.at).toBeGreaterThan(Date.now() - 60_000);
    // thr_a's own claim survived its heartbeat; thr_b held none.
    expect((await listClaims(kv as never, PATH, later)).map((claim) => `${claim.name}:${claim.threadId}`).sort()).toEqual(["docs:thr_c", "ui:thr_a"]);
  });

  it("[sma:k_v_forceclear] [sma:k_lib_claims] after the owner force-clears thr_a's claim, thr_b can take the name; before that thr_b is refused and sees who holds it", async () => {
    const { harness, kv } = cli();
    expect((await harness.behavior.runCli(["window", "claim", "P", "thr_a", "ui", "src/**"])).exitCode).toBe(0);
    const refused = await harness.behavior.runCli(["window", "claim", "P", "thr_b", "ui", "lib/**"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("thr_a");
    expect((await harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "thr_a is gone"])).exitCode).toBe(0);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    const taken = await harness.behavior.runCli(["window", "claim", "P", "thr_b", "ui", "lib/**"]);
    expect(taken.exitCode).toBe(0);
    expect(await listClaims(kv as never, PATH)).toMatchObject([{ name: "ui", threadId: "thr_b", globs: ["lib/**"] }]);
    const evidence = await listEvidence(kv as never, "P", { op: "window" });
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.checks.find((row) => row.name === "holder")!.detail).toBe("thr_a");
  });

  it("[sma:k_lib_termattempt] each released window leaves its own attempt record with who released, the base, the files and whether the outcome was clean or abandoned", async () => {
    const { harness, kv } = cli(async (_method, input) => {
      const command = input.command ?? "";
      if (command === "git rev-parse HEAD") return { exitCode: 0, stdout: "ba5e123\n", stderr: "" };
      if (command.startsWith("git diff")) return { exitCode: 0, stdout: "src/a.ts\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await harness.behavior.runCli(["window", "claim", "P", "thr_a", "ui", "src/**"]);
    await harness.behavior.runCli(["window", "claim", "P", "thr_b", "docs", "docs/**"]);
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui", "--outcome", "abandoned"])).stdout).toContain("released ui (abandoned)");
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_b", "docs", "--outcome", "handed_off"])).stdout).toContain("released docs (handed_off)");
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    const records = await listEvidence(kv as never, "P", { op: "window" });
    expect(records).toHaveLength(2);
    const byTarget = Object.fromEntries(records.map((row) => [row.target, row]));
    expect(byTarget.ui).toMatchObject({ by: "thr_a" });
    expect(byTarget.docs).toMatchObject({ by: "thr_b" });
    const outcome = (target: string) => byTarget[target]!.checks.find((row) => row.name === "outcome")!;
    expect(outcome("ui")).toMatchObject({ ok: false, detail: "abandoned" });
    expect(outcome("docs")).toMatchObject({ ok: true, detail: "handed_off" });
    expect(byTarget.ui!.checks.find((row) => row.name === "files")!.detail).toBe("src/a.ts");
  });

  it("[sma:k_lib_journal] a window cannot release or change another window's claim; only the holder's release leaves a journal record, under the holder's name", async () => {
    const { harness, kv } = cli();
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"], base: "abcdef12" });
    const forged = await releaseClaim(kv as never, { path: PATH, threadId: "thr_b", name: "ui" });
    expect(forged).toMatchObject({ ok: false, code: "not_holder", holder: "thr_a" });
    const viaVerb = await harness.behavior.runCli(["window", "release", "P", "thr_b", "ui"]);
    expect(viaVerb.exitCode).toBe(1);
    expect(await listEvidence(kv as never, "P", { op: "window" })).toEqual([]);
    expect(await listClaims(kv as never, PATH)).toMatchObject([{ name: "ui", threadId: "thr_a", globs: ["src/**"], base: "abcdef12" }]);
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"])).exitCode).toBe(0);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
    expect((await listEvidence(kv as never, "P", { op: "window" })).map((row) => row.by)).toEqual(["thr_a"]);
    expect(await releaseClaim(kv as never, { path: PATH, threadId: "thr_a", name: "ui" })).toMatchObject({ ok: false, code: "no_claim" });
  });
});

describe("region 20 relay: one window asks another", () => {
  function relayWorld() {
    let items: RelayItem[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    const relay = createRelay({
      load: async () => structuredClone(items), save: async (next) => { items = structuredClone(next); },
      send: async (threadId, text) => { sent.push({ threadId, text }); },
      settled: async () => true, output: async () => "", taskStates: async () => ({}), now: () => 1_000_000, log: () => undefined,
    });
    return { relay, sent, items: () => items };
  }

  it("[sma:k_v_ask] the question reaches the asked window and nobody else, a repeat is not sent twice, only the asked window can answer and the asker gets the answer", async () => {
    const w = relayWorld();
    const ask = await w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.threadId).toBe("thr_writer");
    expect(w.sent[0]!.text).toContain("Which files do you hold?");
    expect(w.sent[0]!.text).toContain(ask.id);
    expect(w.items()).toMatchObject([{ kind: "ask", fromThreadId: "thr_pm", toThreadId: "thr_writer", answeredAt: null }]);
    const again = await w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
    expect(again.alreadyWaiting).toBe(true);
    expect(w.sent).toHaveLength(1);
    await expect(w.relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_pm", question: "me?" })).rejects.toThrow(/itself/);
    await expect(w.relay.reply({ askId: ask.id, fromThreadId: "thr_other", answer: "mine" })).rejects.toThrow(/only the asked/);
    await w.relay.reply({ askId: ask.id, fromThreadId: "thr_writer", answer: "src/** until 14:00" });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]!.threadId).toBe("thr_pm");
    expect(w.sent[1]!.text).toContain("src/** until 14:00");
    expect(w.items()[0]).toMatchObject({ answeredAt: 1_000_000 });
  });
});

describe("region 20 hand-off to a second writer", () => {
  it("[sma:k_v_flight] the continuation brief a second writer gets carries what the first one left: stop reason, dirty files, its last failing command and the instruction", async () => {
    const events = [
      { data: { item: { type: "agentMessage", text: "parser nearly done" } } },
      { data: { item: { type: "commandExecution", command: "npm test -- parser", exitCode: 1, aggregatedOutput: "AssertionError: parser boom" } } },
    ];
    const bb = { log: { warn: () => undefined, error: () => undefined, info: () => undefined }, sdk: { threads: { events: { list: async (query: { types?: unknown }) => (query.types ? events : []) } } } };
    const calls: string[] = [];
    const host = { call: async (_method: string, input: { command?: string; cwd?: string }) => { calls.push(`${input.cwd}: ${input.command}`); return { exitCode: 0, stdout: " M src/parser.ts\n", stderr: "" }; } };
    const brief = await collectHandoffBrief({ bb: bb as never, host: host as never, hostId: "h1", threadId: "thr_first", workspacePath: "/wt/a1", stopReason: "provider_error: limit" });
    expect(calls).toEqual(["/wt/a1: git status --short; git diff --stat"]);
    expect(brief).toContain("Stop reason: provider_error: limit");
    expect(brief).toContain(" M src/parser.ts");
    expect(brief).toContain("Last failing command (exit 1): npm test -- parser");
    expect(brief).toContain("AssertionError: parser boom");
    expect(brief).toContain("Do not start over");
    // The first writer's thread cannot be read: the second still gets the instruction and the reason.
    const dead = { sdk: { threads: { events: { list: async () => { throw new Error("gone"); } } } }, log: bb.log };
    const fallback = await collectHandoffBrief({ bb: dead as never, host: host as never, hostId: "h1", threadId: "thr_first", workspacePath: "/wt/a1", stopReason: "stalled" });
    expect(fallback).toContain("Stop reason: stalled");
    expect(fallback).toContain("Last failing command: none in the thread's events.");
  });

  it("[sma:k_lib_flight] the capsule keeps the last 5 asks cut to 300 characters and 30 files and claims, and building it changes nothing it was given", () => {
    const asks = Array.from({ length: 9 }, (_, index) => `ask ${index} ${"x".repeat(400)}`);
    const files = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`);
    const input = { asks, files, claims: files.slice(), trigger: "precompact" as const };
    const frozen = JSON.stringify(input);
    const capsule = buildCapsule(input);
    expect(capsule.asks.map((ask) => ask.slice(0, 5))).toEqual(["ask 4", "ask 5", "ask 6", "ask 7", "ask 8"]);
    expect(capsule.asks.every((ask) => ask.length === 300)).toBe(true);
    expect(capsule.files).toEqual(files.slice(0, 30));
    expect(capsule.claims).toEqual(files.slice(0, 30));
    expect(capsule.trigger).toBe("precompact");
    expect(JSON.stringify(input)).toBe(frozen);
    expect(buildCapsule(input)).toEqual(capsule);
  });
});

describe("region 20 outward status", () => {
  const WEBHOOK = "https://hooks.example/lp";
  afterEach(() => vi.restoreAllMocks());

  it("[sma:k_lib_snapshot] the outward body has exactly the nine listed fields in order, each clipped to 200 characters, and nothing the caller adds", () => {
    const body = taskEventBody({ event: "task.accepted", projectId: "P", runId: "r1", taskId: "t1", title: "x".repeat(500), kind: "bb", state: "accepted", attempt: 3, at: 1700000000000,
      contract: { owns_paths: ["secret/**"] }, output: "stdout", path: "/home/ubuntu/x" });
    expect(Object.keys(body)).toEqual([...EVENT_FIELDS]);
    expect(Object.keys(body)).toHaveLength(9);
    expect(body.title).toBe("x".repeat(200));
    expect(body.attempt).toBe(3);
    expect(body.at).toBe(1700000000000);
    expect(taskEventBody({ event: "owner.waiting" })).toEqual({ event: "owner.waiting", projectId: null, runId: null, taskId: null, title: null, kind: null, state: null, attempt: null, at: null });
  });

  it("[sma:k_v_snapshot] a status event is posted to the project's https webhook with the nine fields only; an http address, no address, and a project of another address post nothing", async () => {
    const { db } = open();
    const post = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    saveProjectSetting(db, "P", "events.webhook_url", "http://hooks.example/lp");
    expect(await postEvent(db, "P", { event: "owner.waiting", state: "waiting" })).toBe(false);
    expect(await postEvent(db, "Q", { event: "owner.waiting", state: "waiting" })).toBe(false);
    expect(post).not.toHaveBeenCalled();
    saveProjectSetting(db, "P", "events.webhook_url", WEBHOOK);
    expect(await postEvent(db, "P", { event: "owner.waiting", state: "waiting", title: "needs you", projectId: "EVIL", contract: { secret: 1 }, output: "leak" }, () => undefined)).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, init] = post.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual([...EVENT_FIELDS]);
    expect(sent).toMatchObject({ event: "owner.waiting", projectId: "P", state: "waiting", title: "needs you", runId: null });
    expect(typeof sent.at).toBe("number");
    expect(JSON.stringify(sent)).not.toMatch(/secret|leak/);
  });
});

describe("region 20 migrations as the shared counter", () => {
  it("[sma:k_lib_slots] two branches that add a migration cannot collide: an addition at the end is taken, one slotted into the middle is refused, and every locked statement still sits at its index", () => {
    const hashes = migrations.map((statement) => createHash("sha256").update(statement).digest("hex"));
    expect(hashes).toEqual(migrationLock as string[]);
    const a = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const dbA = a.storage.database();
    a.storage.migrate(dbA, migrations as never);
    expect(() => a.storage.migrate(dbA, [...migrations, "CREATE TABLE branch_a_added(x)"] as never)).not.toThrow();
    const b = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const dbB = b.storage.database();
    b.storage.migrate(dbB, migrations as never);
    const middle = [...migrations.slice(0, 40), "CREATE TABLE branch_b_added(x)", ...migrations.slice(40)];
    expect(() => b.storage.migrate(dbB, middle as never)).toThrow(/does not match the recorded statement/);
  });
});

describe("region 20 git copies: one per task, merged one at a time", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  const roots: string[] = [];
  async function repo() {
    const root = await mkdtemp(join(tmpdir(), "lp-r20-"));
    roots.push(root);
    const base = join(root, "main");
    execFileSync("git", ["init", "-q", "-b", "main", base]);
    await writeFile(join(base, "server.ts"), "line1\nline2\nline3\n");
    git(base, "add", "-A"); git(base, "commit", "-qm", "base");
    const worktree = (name: string) => { const path = join(root, name); git(base, "worktree", "add", "-q", "-b", `bb/${name}`, path, "main"); return path; };
    return { root, base, worktree };
  }
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

  it("[sma:k_v_worktree] two tasks each get their own folder and branch from main's head; one's work is invisible to the other, and a retry of another task does not inherit it", async () => {
    const { root, base } = await repo();
    const head = git(base, "rev-parse", "HEAD").trim();
    const a = await createWorktree({ basePath: base, targetPath: join(root, "wt", "a"), name: "lpattempt_a", taskId: "t1" });
    const b = await createWorktree({ basePath: base, targetPath: join(root, "wt", "b"), name: "lpattempt_b", taskId: "t2" });
    expect([a.status, b.status]).toEqual(["ready", "ready"]);
    expect(a.path).not.toBe(b.path);
    expect([a.branch, b.branch]).toEqual(["lane/lpattempt_a", "lane/lpattempt_b"]);
    expect([a.baseSha, b.baseSha]).toEqual([head, head]);
    await writeFile(join(a.path!, "a-work.txt"), "from a\n");
    git(a.path!, "add", "-A"); git(a.path!, "commit", "-qm", "a work");
    expect(existsSync(join(b.path!, "a-work.txt"))).toBe(false);
    expect(existsSync(join(base, "a-work.txt"))).toBe(false);
    expect(git(b.path!, "status", "--porcelain")).toBe("");
    // The same task asking again gets its own work back; a different task asking for that name gets a fresh copy.
    const same = await createWorktree({ basePath: base, targetPath: join(root, "wt", "a"), name: "lpattempt_a", taskId: "t1" });
    expect(same.status).toBe("ready");
    expect(existsSync(join(same.path!, "a-work.txt"))).toBe(true);
    const other = await createWorktree({ basePath: base, targetPath: join(root, "wt", "a"), name: "lpattempt_a", taskId: "t3" });
    expect(other.status).toBe("ready");
    expect(existsSync(join(other.path!, "a-work.txt"))).toBe(false);
    expect(git(base, "config", "--local", "--get", "branch.lane/lpattempt_a.laneTask").trim()).toBe("t3");
  });

  it("[sma:k_lib_worktree] a copy forks from main's head or from a named commit and reports it; a folder that is no git checkout gets no copy and a reason", async () => {
    const { root, base } = await repo();
    const first = git(base, "rev-parse", "HEAD").trim();
    await writeFile(join(base, "later.txt"), "x\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "later");
    const tip = git(base, "rev-parse", "HEAD").trim();
    const fromTip = await createWorktree({ basePath: base, targetPath: join(root, "wt", "tip"), name: "lpattempt_tip" });
    expect(fromTip).toMatchObject({ status: "ready", baseSha: tip, branch: "lane/lpattempt_tip", reason: null });
    expect(existsSync(join(fromTip.path!, "later.txt"))).toBe(true);
    const fromFirst = await createWorktree({ basePath: base, targetPath: join(root, "wt", "first"), name: "lpattempt_first", commit: first });
    expect(fromFirst).toMatchObject({ status: "ready", baseSha: first });
    expect(existsSync(join(fromFirst.path!, "later.txt"))).toBe(false);
    const nothing = await createWorktree({ basePath: root, targetPath: join(root, "wt", "none"), name: "lpattempt_none" });
    expect(nothing).toMatchObject({ status: "failed", path: null, branch: null, baseSha: null });
    expect(nothing.reason).toMatch(/not a git checkout/);
    expect(existsSync(join(root, "wt", "none"))).toBe(false);
  });

  it("[sma:k_v_merge] writers' finished copies are merged into main one after another, also when started together; a clash is refused with its files and main stays as it was", async () => {
    const { base, worktree } = await repo();
    const a = worktree("a"), b = worktree("b"), c = worktree("c");
    await writeFile(join(a, "a.ts"), "export const a = 1;\n");
    await writeFile(join(b, "b.ts"), "export const b = 1;\n");
    await writeFile(join(c, "server.ts"), "line1 from c\nline2\nline3\n");
    const before = git(base, "rev-parse", "HEAD").trim();
    const [ra, rb] = await Promise.all([
      integrateWorktree({ basePath: base, worktreePath: a, message: "task a", removeWorktree: true }),
      integrateWorktree({ basePath: base, worktreePath: b, message: "task b", removeWorktree: true }),
    ]);
    expect([ra.status, rb.status]).toEqual(["merged", "merged"]);
    expect(await readFile(join(base, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await readFile(join(base, "b.ts"), "utf8")).toBe("export const b = 1;\n");
    // Each merge names what main was and what it changed; together they chain from the old head to the new one.
    const [first, second] = [ra, rb].sort((x, y) => (x.base === before ? -1 : y.base === before ? 1 : 0));
    expect(first!.base).toBe(before);
    expect(second!.base).toBe(first!.commit);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(second!.commit);
    expect(ra.worktreeRemoved && rb.worktreeRemoved).toBe(true);
    expect(existsSync(a) || existsSync(b)).toBe(false);
    // A third writer and main both changed the first line of server.ts: refused.
    await writeFile(join(base, "server.ts"), "line1 from main\nline2\nline3\n");
    git(base, "add", "-A"); git(base, "commit", "-qm", "main edit");
    const tip = git(base, "rev-parse", "HEAD").trim();
    const clash = await integrateWorktree({ basePath: base, worktreePath: c, message: "task c" });
    expect(clash.status).toBe("conflict");
    expect(clash.conflicts).toEqual(["server.ts"]);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(git(base, "status", "--porcelain").trim()).toBe("");
    expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1 from main\nline2\nline3\n");
  });

  it("[sma:k_lib_mergegate] a verified candidate merges only while main is still inside it and it is still the verified commit; otherwise the merge says which moved and main is untouched", async () => {
    const { base, worktree } = await repo();
    const a = worktree("a"), b = worktree("b");
    await writeFile(join(a, "a.ts"), "export const a = 1;\n");
    expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("merged");
    const mainAfterA = git(base, "rev-parse", "HEAD").trim();
    // b was verified before a landed: main is not inside it.
    await writeFile(join(b, "b.ts"), "export const b = 1;\n"); git(b, "add", "-A"); git(b, "commit", "-qm", "b");
    const stale = await integrateWorktree({ basePath: base, worktreePath: b, message: "task b", committedOnly: true, baseInHead: true });
    expect(stale.status).toBe("failed");
    expect(stale.reason).toContain(BASE_MOVED);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(mainAfterA);
    // b takes main in, is verified at that commit, and then it merges.
    expect((await syncWorktree({ basePath: base, worktreePath: b })).status).toBe("synced");
    const verified = git(b, "rev-parse", "HEAD").trim();
    const moved = await integrateWorktree({ basePath: base, worktreePath: b, message: "task b", committedOnly: true, baseInHead: true, expectedHead: "0".repeat(40) });
    expect(moved.status).toBe("failed");
    expect(moved.reason).toContain(HEAD_MOVED);
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(mainAfterA);
    const ok = await integrateWorktree({ basePath: base, worktreePath: b, message: "task b", committedOnly: true, baseInHead: true, expectedHead: verified });
    expect(ok.status).toBe("merged");
    expect(await readFile(join(base, "b.ts"), "utf8")).toBe("export const b = 1;\n");
  });
});
