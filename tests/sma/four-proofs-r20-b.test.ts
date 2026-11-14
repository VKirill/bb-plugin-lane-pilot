// Region 20 · Terminal coordination, batch b (n1549 … n1559): the outward webhook, the Today digest, the machine name, the window's
// lease, its claims and the record a release leaves. Each test checks the stored or sent result, not that a function ran.
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createAttempt, createRun, createTask, migrations, openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { listEvidence } from "../../src/rooms/storage";
import type { Services } from "../../server";
import { GUEST_TTL_MS, claimScope, listClaims, noteCheckoutGuest } from "../../src/rooms/verification/server";
import { postEvent } from "../../src/rooms/relay/server/outbound";
import { cockpitToday } from "../../src/rooms/cockpit/server";
import { findingId } from "../../src/rooms/critique/code-critique";

const PATH = "/repo/plugin";
const KEY = "checkout-guests:/repo/plugin";
const NINE = ["event", "projectId", "runId", "taskId", "title", "kind", "state", "attempt", "at"];

function open() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async () => null,
    get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "P" }),
  } } as never });
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo/pm", writerWorkspacePath: PATH, pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
  return { bb, harness, db, kv: bb.storage.kv };
}

describe("region 20 batch b: what leaves, what is shown, how a window is remembered", () => {
  it("[sma:k_lib_notify] postEvent sends one https POST with exactly the nine fields, the project of the call and the caller's time; an http, an unset or a failing address is silent or logged, never thrown", async () => {
    const { db } = open();
    const calls: Array<{ url: string; method?: string; type?: string; body: Record<string, unknown> }> = [];
    const real = globalThis.fetch;
    let fail = false;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method, type: (init.headers as Record<string, string>)["content-type"], body: JSON.parse(String(init.body)) });
      if (fail) throw new Error("boom");
      return new Response("ok");
    }) as never;
    try {
      expect(await postEvent(db, "Q", { event: "owner.waiting" })).toBe(false);
      saveProjectSetting(db, "P", "events.webhook_url", "http://hook.example/x");
      expect(await postEvent(db, "P", { event: "owner.waiting" })).toBe(false);
      expect(calls).toEqual([]);
      saveProjectSetting(db, "P", "events.webhook_url", "https://hook.example/x");
      expect(await postEvent(db, "P", { event: "owner.waiting", state: "waiting", kind: "wall", title: "needs you", at: 123, projectId: "EVIL", contract: { secret: 1 }, output: "leak" })).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ url: "https://hook.example/x", method: "POST", type: "application/json" });
      expect(Object.keys(calls[0]!.body)).toEqual(NINE);
      expect(calls[0]!.body).toEqual({ event: "owner.waiting", projectId: "P", runId: null, taskId: null, title: "needs you", kind: "wall", state: "waiting", attempt: null, at: 123 });
      // Without a time of its own the post carries the time it was sent.
      const before = Date.now();
      await postEvent(db, "P", { event: "pulse" });
      expect(calls[1]!.body.event).toBe("pulse");
      expect(Number(calls[1]!.body.at)).toBeGreaterThanOrEqual(before);
      // A webhook that fails is logged with its address and does not fail the caller.
      fail = true;
      const logs: string[] = [];
      expect(await postEvent(db, "P", { event: "owner.waiting" }, (line) => logs.push(line))).toBe(true);
      expect(logs).toEqual(["outbound: https://hook.example/x: boom"]);
    } finally { globalThis.fetch = real; }
  });

  it("[sma:k_lib_digest] the Today digest counts what each source returned, a source that fails is named in `partial` and the others stay, and protection.rearm does not change the digest", async () => {
    const { db } = open();
    const now = Date.now();
    createRun(db, "r1", "p");
    const attempts: Array<[string, string, number]> = [["t1", "accepted", now - 1_000], ["t2", "accepted", now - 2_000], ["t3", "blocked", now - 3_000], ["t4", "running", now - 4_000], ["t5", "accepted", now - 2 * 86_400_000]];
    for (const [id, state, at] of attempts) {
      createTask(db, { id, runId: "r1", kind: "bb", contract: { display_title: `title ${id}` } as never });
      createAttempt(db, { id: `a_${id}`, runId: "r1", taskId: id });
      db.prepare("UPDATE lane_pilot_attempt SET state=?, updated_at=?, reason=? WHERE id=?").run(state, at, state === "blocked" ? "needs the owner" : null, `a_${id}`);
    }
    db.prepare("INSERT INTO lane_pilot_token_daily (day, project_id, provider_id, model, total_tokens) VALUES (?,?,?,?,?)").run(new Date().toISOString().slice(0, 10), "p", "claude-code", "m", 1234);
    const logs: string[] = [];
    const ctx = { db, log: (line: string) => logs.push(line) } as never;
    const front = { actions: async () => [{ at: now - 10 }, { at: now - 20 }, { at: now - 3 * 86_400_000 }] } as Pick<Services, "front">["front"];
    const out = await cockpitToday(ctx, { front }, "p");
    const feed = out.feed as Array<{ kind: string; taskId?: string; title?: string | null; text: string }>;
    expect(out.partial).toEqual([]);
    expect(out.kpi).toEqual({ accepted: 2, blocked: 1, running: 1, tokens: 1234, actions: 2 });
    expect(feed.map((row) => [row.kind, row.taskId, row.title ?? null])).toEqual([["task_accepted", "t1", "title t1"], ["task_accepted", "t2", "title t2"], ["task_blocked", "t3", null], ["task_running", "t4", null]]);
    expect(feed.find((row) => row.taskId === "t3")!.text).toBe("t3 — needs the owner");
    // The setting protection.rearm belongs to the Rules screen: the digest is the same with it on.
    saveProjectSetting(db, "p", "protection.rearm", "on");
    expect(await cockpitToday(ctx, { front }, "p")).toEqual(out);
    // The actions source is down: the other three answer, the screen is told which one did not.
    const down = await cockpitToday(ctx, { front: { actions: async () => { throw new Error("front down"); } } as never }, "p");
    expect(down.partial).toEqual(["actions"]);
    expect(down.kpi).toEqual({ accepted: 2, blocked: 1, running: 1, tokens: 1234, actions: 0 });
    expect(down.feed).toHaveLength(4);
    expect(logs).toEqual(["Lane Pilot cockpit_today: source actions failed: front down"]);
  });

  it("[sma:k_lib_translit] a finding's machine name: the given id wins, an English criterion is slugged and cut at 48, a Russian one takes the first six hex digits of its hash, and no file gives `finding`", () => {
    const row = (over: Record<string, unknown>) => ({ file: "src/a.ts", evidence: "e", severity: "high", ...over }) as never;
    const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 6);
    expect(findingId(row({ id: "F-7", criterion: "anything" }))).toBe("F-7");
    expect(findingId(row({ criterion: "Missing Null Check!" }))).toBe("src/a.ts:missing-null-check");
    expect(findingId(row({ criterion: "x".repeat(60) }))).toBe(`src/a.ts:${"x".repeat(48)}`);
    const russian = findingId(row({ criterion: "нет проверки пустого ввода" }));
    expect(russian).toBe(`src/a.ts:${hash("нет проверки пустого ввода")}`);
    expect(russian).toMatch(/^src\/a\.ts:[0-9a-f]{6}$/);
    expect(findingId(row({ criterion: "нет проверки границ" }))).not.toBe(russian);
    expect(findingId(row({ file: "", criterion: "Slow Path" }))).toBe("finding:slow-path");
  });

  it("[sma:k_st_sessions] the lease entry of a chat keeps its provider, label and live claims across messages, takes a new heartbeat, and starts empty once the lease ran out", async () => {
    const { bb, db, kv } = open();
    const hour = 3_600_000;
    await noteCheckoutGuest(bb, db, "thr_a", PATH, { providerId: "claude-code", label: "mine" });
    await noteCheckoutGuest(bb, db, "thr_b", PATH);
    const first = (await kv.get(KEY)) as Array<Record<string, unknown>>;
    expect(first.find((row) => row.threadId === "thr_a")).toMatchObject({ threadId: "thr_a", providerId: "claude-code", label: "mine" });
    expect(first.find((row) => row.threadId === "thr_b")).toEqual({ threadId: "thr_b", at: expect.any(Number) });
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
    // Ten minutes later thr_a writes again, naming nothing: provider, label and claim are what the entry held, the time is new.
    const stored = (await kv.get(KEY)) as Array<{ threadId: string; at: number }>;
    await kv.set(KEY, stored.map((row) => ({ ...row, at: row.at - 10 * 60_000 })) as never);
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    const second = ((await kv.get(KEY)) as Array<Record<string, any>>).find((row) => row.threadId === "thr_a")!;
    expect(second.providerId).toBe("claude-code");
    expect(second.label).toBe("mine");
    expect(second.claims.map((claim: { name: string }) => claim.name)).toEqual(["ui"]);
    expect(second.at).toBeGreaterThan(Date.now() - 60_000);
    // A lease that ran out for 7 hours holds no claim when the chat comes back; its provider is still known.
    const aged = (await kv.get(KEY)) as Array<{ threadId: string; at: number }>;
    await kv.set(KEY, aged.map((row) => ({ ...row, at: row.at - 7 * hour })) as never);
    await noteCheckoutGuest(bb, db, "thr_a", PATH);
    const third = ((await kv.get(KEY)) as Array<Record<string, any>>).find((row) => row.threadId === "thr_a")!;
    expect(third.providerId).toBe("claude-code");
    expect(third.claims).toBeUndefined();
  });

  it("[sma:k_st_claims] a claim keeps its name, globs, a description cut at 300, its base, holder and time inside the holder's lease, and an expired lease takes its old claims with it", async () => {
    const { kv } = open();
    const at = Date.now();
    const long = "d".repeat(400);
    const made = await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: [" src/** ", "docs/**"], description: long, base: "deadbeef", now: at });
    expect(made).toEqual({ ok: true, claim: { name: "ui", globs: ["src/**", "docs/**"], description: "d".repeat(300), base: "deadbeef", threadId: "thr_a", at } });
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "bare", globs: ["lib/**"], now: at });
    const entry = ((await kv.get(KEY)) as Array<{ threadId: string; claims: unknown[] }>);
    expect(entry.map((row) => row.threadId)).toEqual(["thr_a"]);
    expect(entry[0]!.claims).toEqual([
      { name: "ui", globs: ["src/**", "docs/**"], description: "d".repeat(300), base: "deadbeef", threadId: "thr_a", at },
      { name: "bare", globs: ["lib/**"], description: "", base: null, threadId: "thr_a", at },
    ]);
    // The lease is over: the claims are not listed, and a new claim of the same chat does not bring them back.
    expect(await listClaims(kv as never, PATH, at + GUEST_TTL_MS + 1)).toEqual([]);
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "fresh", globs: ["x/**"], now: at + GUEST_TTL_MS + 1 });
    expect((await listClaims(kv as never, PATH, at + GUEST_TTL_MS + 2)).map((claim) => claim.name)).toEqual(["fresh"]);
  });

  it("[sma:k_st_attempts] releasing a claim leaves exactly one record under the holder's name with the base, the files and the outcome in that order, `unknown` and `none` when the claim had neither", async () => {
    const { harness, kv, bb } = open();
    bb.hosts.experimental_client = (() => ({ call: async (_method: string, input: { command?: string }) => {
      const command = input.command ?? "";
      if (command.startsWith("git diff")) return { exitCode: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    } })) as never;
    registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
    await claimScope(kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"], base: "ba5e123" });
    await claimScope(kv as never, { path: PATH, threadId: "thr_b", name: "bare", globs: ["docs/**"] });
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_a", "ui"])).stdout).toContain("released ui (committed)");
    expect((await harness.behavior.runCli(["window", "release", "P", "thr_b", "bare", "--outcome", "handed_off"])).exitCode).toBe(0);
    const records = await listEvidence(kv as never, "P", { op: "window" });
    expect(records).toHaveLength(2);
    const trail = (target: string) => records.filter((row) => row.target === target).map((row) => ({ by: row.by, why: row.why, checks: row.checks.map((check) => [check.name, check.ok, check.detail]) }));
    expect(trail("ui")).toEqual([{ by: "thr_a", why: "released by thr_a", checks: [["base", true, "ba5e123"], ["files", true, "src/a.ts, src/b.ts"], ["outcome", true, "committed"]] }]);
    expect(trail("bare")).toEqual([{ by: "thr_b", why: "released by thr_b", checks: [["base", true, "unknown"], ["files", true, "none"], ["outcome", true, "handed_off"]] }]);
    expect(await listClaims(kv as never, PATH)).toEqual([]);
  });
});
