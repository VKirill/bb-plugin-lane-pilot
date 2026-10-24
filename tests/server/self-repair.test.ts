import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { createSelfRepair, firstSeenOnRunningVersion, isDue, lastPmOwnerMessageAt, logIncidents, parseVerdict, reasonSignature, repairPriority, repairPrompt, repairStatus, VERSION } from "../../src/rooms/self-repair/server/self-repair";
import { createJev } from "@lane-pilot/jev";
import { setJevForTests } from "@lane-pilot/jev";
import type { JevClient } from "@lane-pilot/jev";
import type { ServerCore } from "../../src/rooms/core/server/core";

type HostCall = { method: string; input: Record<string, unknown> };

function setup(threadStatus: Record<string, string> = {}, outputs: Record<string, string> = {}, hostResults: Record<string, unknown> = {}, ownerTurns: Record<string, number | null> = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  const hostCalls: HostCall[] = [];
  const placed: unknown[] = [];
  let next = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_mac", path: "/repo/lane-pilot" }) as never },
      plugins: { callRpc: async (args: { method: string; input: unknown }) => { placed.push([args.method, args.input]); return { ok: true }; } },
      threads: {
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs[threadId] ?? "" }) as never,
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadStatus[threadId] ?? "idle" }) as never,
        events: {
          list: async ({ threadId }: { threadId: string }) => {
            const at = ownerTurns[threadId];
            if (at == null) return [];
            return [{ seq: 1, createdAt: at, data: { initiator: "user" } }];
          },
        },
        spawn: async (input: unknown) => {
          if (hostResults.spawn instanceof Error) throw hostResults.spawn;
          spawns.push(input as Record<string, unknown>);
          return { id: `thr_repair${++next}` } as never;
        },
      },
    } as never,
  });
  const db = openDatabase(bb);
  const host = {
    call: async (method: string, input: Record<string, unknown>) => {
      hostCalls.push({ method, input });
      if (method in hostResults) {
        const result = hostResults[method];
        if (result instanceof Error) throw result;
        return result;
      }
      if (method === "gitCreateWorktree") return { status: "ready", path: `/wt/${String(input.name)}/lane-pilot`, branch: `lane/${String(input.name)}`, reason: null };
      if (method === "gitIntegrate") return { status: "merged", commit: "abcdef1234567890", conflicts: [], reason: null };
      return { ok: true };
    },
  };
  const logs: string[] = [];
  const ctx = { bb, db, host, log: (message: string) => logs.push(message), isDisposed: () => false } as unknown as ServerCore;
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("lprun_a", "proj_real", "thr_pm", "running", now, now);
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("lprun_s", "proj_3tb652jpsi", "thr_pm2", "running", now, now);
  const attempt = (id: string, run: string, state: string, reason: string | null, updatedAt = now, thread = `thr_w_${id}`) =>
    db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,thread_id,state,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, run, `task-${id}`, thread, state, reason, updatedAt, updatedAt);
  const triage = (id: string, project: string, run: string, reason: string, origin = "orchestrator") =>
    db.prepare(`INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,status,failed_at,triaged_at)
      VALUES (?,?,?,?,?,?,?,'ok',?,?)`).run(project, id, run, `task-${id}`, "x", reason, origin, now, now);
  return { ctx, db, spawns, placed, attempt, triage, now, hostCalls, logs };
}

describe("self-repair", () => {
  it("one problem in many tasks is one signature", () => {
    const a = reasonSignature("blocked", "internal_error: another writer integration holds the base checkout lpattempt_1a2b3c at /home/x/repo 12");
    const b = reasonSignature("blocked", "retry limit 3 exhausted: internal_error: another writer integration holds the base checkout lpattempt_9f9f9f at /tmp/other 40");
    expect(a).toBe(b);
    expect(reasonSignature("blocked", "merge_failed: conflict")).not.toBe(a);
    expect(reasonSignature("triage", "writer changed paths outside owns_paths: apps/bot/src/__tests__/a.test.ts"))
      .toBe(reasonSignature("triage", "writer changed paths outside owns_paths: packages/infra/b.test.ts"));
  });

  it("starts one Opus high repair thread in the Lane Pilot section for Lane Pilot's own fault, not for others", async () => {
    const { ctx, spawns, placed, attempt, triage } = setup();
    attempt("lpattempt_1", "lprun_a", "validation_failed", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_1", "proj_real", "lprun_a", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_2", "proj_real", "lprun_a", "tests failed in apps/web", "writer");
    attempt("lpattempt_3", "lprun_a", "blocked", "acceptance unmet: button missing");
    triage("lpattempt_4", "proj_3tb652jpsi", "lprun_s", "internal_error: sandbox drill");
    triage("lpattempt_5", "proj_real", "lprun_a", "depends_on gc-s7-checkout: that task ended blocked");
    const repair = createSelfRepair(ctx);
    const result = await repair.tick({ since: 0 });
    expect(result.incidents).toBe(1);
    expect(result.spawned).toBe("thr_repair1");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      projectId: "proj_ejbam66722",
      environment: { type: "host", hostId: "host_mac", workspace: { type: "unmanaged", path: expect.stringMatching(/^\/wt\/self-repair-[0-9a-f]{8}-[a-z0-9]+\/lane-pilot$/) } },
      providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default", permissionMode: "full",
    });
    expect(String(spawns[0]!.prompt)).toContain("@thread:thr_pm");
    expect(placed).toEqual([["thread_place", { threadId: "thr_repair1", projectId: "proj_ejbam66722", folderId: "9b66deb6-0e31-42d3-840f-19fa9601380c" }]]);
    expect(String(spawns[0]!.prompt)).toContain("host plugin calls are unavailable");
  });

  it("a reason listing thousands of files does not overflow the stored state", async () => {
    const { ctx, attempt } = setup({ thr_repair1: "running" });
    const huge = `writer changed paths outside owns_paths or inside never_touch: ${Array.from({ length: 50_000 }, (_, i) => `docs/folder/file-${i}.md`).join(", ")}`;
    for (const id of ["lpattempt_1", "lpattempt_2", "lpattempt_3"]) attempt(id, "lprun_a", "validation_failed", huge);
    const repair = createSelfRepair(ctx);
    const result = await repair.tick({ since: 0 });
    expect(result.incidents).toBe(3);
    const state = await repair.state();
    expect(state.lastTickAt).not.toBeNull();
    expect(JSON.stringify(state).length).toBeLessThan(256 * 1024);
  });

  it("a state past its budget forgets the kinds seen longest ago, never repaired first", async () => {
    const { ctx, logs, now } = setup();
    const signatures: Record<string, unknown> = {};
    for (let i = 0; i < 190; i++) {
      const sample = { signature: `s${i}`, kind: "repeat", projectId: "p", runId: "r", taskId: "t", attemptId: `a${i}`, pmThreadId: null, writerThreadId: null, reason: "y".repeat(1000), at: i };
      signatures[`s${i}`] = { firstAt: now - 190 + i, lastAt: now - 190 + i, count: 1, threadId: i === 0 ? "thr_old_repair" : null, spawnedAt: i === 0 ? 1 : null, verdict: i === 0 ? "fixed" : null, samples: [sample] };
    }
    await ctx.bb.storage.kv.set("self-repair:state", { cursor: 0, lastTickAt: 0, signatures, spawned: [] } as never);
    const repair = createSelfRepair(ctx);
    await repair.tick({ since: 0 });
    const kept = Object.keys((await repair.state()).signatures);
    expect(JSON.stringify(await repair.state()).length).toBeLessThan(200 * 1024);
    expect(kept).toContain("s0");
    expect(kept).toContain("s189");
    expect(kept).not.toContain("s1");
    expect(logs.some((line) => /forgot \d+ old kind/.test(line))).toBe(true);
  });

  it("samples stored with longer reasons are cut down when the state is read", async () => {
    const { ctx } = setup();
    const sample = { signature: "s", kind: "repeat", projectId: "p", runId: "r", taskId: "t", attemptId: "a", pmThreadId: null, writerThreadId: null, reason: "x".repeat(4000), at: 1 };
    await ctx.bb.storage.kv.set("self-repair:state", { cursor: 0, lastTickAt: 0, signatures: { s: { firstAt: 1, lastAt: 1, count: 1, threadId: null, spawnedAt: null, samples: [sample] } }, spawned: [] } as never);
    expect((await createSelfRepair(ctx).state()).signatures.s!.samples[0]!.reason).toHaveLength(1000);
  });

  it("does not repeat a known problem, waits while a repair runs, and respects the daily limit", async () => {
    const env = setup({ thr_repair1: "running" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    expect((await repair.tick({ since: 0 })).reason).toBe("nothing new");
    env.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    expect((await repair.tick({ since: 0 })).reason).toBe("a repair thread is still working");
    await repair.setConfig({ maxPerDay: 1 });
    const idle = setup();
    await idle.ctx.bb.storage.kv.set("self-repair:state", (await repair.state()) as never);
    await idle.ctx.bb.storage.kv.set("self-repair:config", { maxPerDay: 1 } as never);
    idle.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    expect((await createSelfRepair(idle.ctx).tick({ since: 0 })).reason).toBe("daily limit 1 reached");
    expect(idle.spawns).toHaveLength(0);
  });

  it("a problem that waited for a busy repair is taken on a later pass, even after the cursor moved", async () => {
    const busy: Record<string, string> = { thr_repair1: "running" };
    const env = setup(busy);
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    env.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    expect((await repair.tick()).reason).toBe("a repair thread is still working");
    busy.thr_repair1 = "idle";
    const later = await repair.tick();
    expect(later.spawned).toBe("thr_repair2");
    expect(String(env.spawns[1]!.prompt)).toContain("spawn failed for writer");
    expect((await repair.tick()).reason).toBe("nothing new");
  });

  it("dry run says what it would start and changes nothing", async () => {
    const env = setup();
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0, dryRun: true })).reason).toMatch(/^would start a repair for blocked:/);
    expect(env.spawns).toHaveLength(0);
    expect((await repair.state()).signatures).toEqual({});
  });

  it("sees an attempt left «running» after its writer went idle", async () => {
    const { ctx, attempt, now } = setup();
    attempt("lpattempt_s", "lprun_a", "running", null, now - 60 * 60_000);
    attempt("lpattempt_r", "lprun_a", "running", null, now - 5 * 60_000);
    const incidents = await createSelfRepair(ctx).collect(0, { ...(await createSelfRepair(ctx).config()) });
    expect(incidents.map((row) => [row.kind, row.attemptId])).toEqual([["stuck", "lpattempt_s"]]);
  });

  it("reads Lane Pilot's own failures from the plugin log, not machine outages or its own lines", () => {
    const line = (ts: number, message: string) => JSON.stringify({ ts, level: "warn", message });
    const text = [
      line(100, "Lane Pilot docs resume failed for /home/u/a docs: plugin \"lane-pilot\" used a stale API handle"),
      line(200, "Lane Pilot docs resume failed for /home/u/b docs: plugin \"lane-pilot\" used a stale API handle"),
      line(300, "Lane Pilot nightly docs failed for /Users/x: Host is not connected"),
      line(400, "self-repair: started @thread:thr_x for blocked:1:spawn failed"),
      line(500, "writer a waits for b: their owns_paths overlap"),
      line(600, "Lane Pilot writer attempt lpattempt_1 failed: another writer integration holds the base checkout"),
      line(700, "Lane Pilot browser check gc-qa-free-session.5 adopted after a reload: failed"),
      line(50, "Lane Pilot docs resume failed: old"),
      "not json",
    ].join("\n");
    const rows = logIncidents(text, 60);
    expect(rows.map((row) => row.at)).toEqual([100, 200]);
    expect(rows[0]!.signature).toBe(rows[1]!.signature);
    expect(rows[0]!.kind).toBe("log");
  });

  it("a kind of problem began under the running version only if it was first recorded after this load and all its samples are from it (deploy basis, audit r4 P0-8)", () => {
    const sample = (at: number, version: string | null) => ({ signature: "s", kind: "blocked" as const, projectId: "p", runId: "r", taskId: "t", attemptId: `a${at}`, pmThreadId: null, writerThreadId: null, reason: "x", at, version });
    const record = (firstAt: number, samples: ReturnType<typeof sample>[]) => ({ firstAt, lastAt: firstAt, count: samples.length, threadId: null, spawnedAt: null, samples });
    expect(firstSeenOnRunningVersion(record(1000, [sample(1000, "2.0.0")]), 500, "2.0.0")).toBe(true);
    expect(firstSeenOnRunningVersion(record(1000, [sample(1000, "2.0.0"), sample(1100, "2.0.0")]), 500, "2.0.0")).toBe(true);
    // Already recorded before this load (a reload of the same version, or the previous version).
    expect(firstSeenOnRunningVersion(record(400, [sample(1000, "2.0.0")]), 500, "2.0.0")).toBe(false);
    // A sample from before this load (version unknown) or from another version.
    expect(firstSeenOnRunningVersion(record(1000, [sample(300, null), sample(1000, "2.0.0")]), 500, "2.0.0")).toBe(false);
    expect(firstSeenOnRunningVersion(record(1000, [sample(1000, "1.9.0")]), 500, "2.0.0")).toBe(false);
    expect(firstSeenOnRunningVersion(record(1000, []), 500, "2.0.0")).toBe(false);
  });

  it("a failure from before this release waits to happen again; one under the running version is repaired", () => {
    const sample = (at: number, version: string | null) => ({ signature: "s", kind: "blocked" as const, projectId: "p", runId: "r", taskId: "t", attemptId: `a${at}`, pmThreadId: null, writerThreadId: null, reason: "x", at, version });
    const record = (samples: ReturnType<typeof sample>[], extra = {}) => ({ firstAt: 0, lastAt: 0, count: samples.length, threadId: null, spawnedAt: null, samples, ...extra });
    const now = 10 * 86_400_000;
    expect(isDue(record([sample(100, null)]), now)).toBe(false);
    expect(isDue(record([sample(100, null), sample(200, VERSION)]), now)).toBe(true);
    // After a repair that fixed it: the same version again within a day is the old code, not a failed fix.
    const fixed = { spawnedAt: now - 3_600_000, spawnVersion: "0.0.1", verdict: "fixed" };
    expect(isDue(record([sample(now - 60_000, "0.0.1")], fixed), now, "0.0.1")).toBe(false);
    expect(isDue(record([sample(now - 60_000, "0.0.2")], fixed), now, "0.0.2")).toBe(true);
    // Not Lane Pilot's: quiet for a week even if it keeps happening.
    const notOurs = { spawnedAt: now - 2 * 86_400_000, spawnVersion: VERSION, verdict: "not-lane-pilot" };
    expect(isDue(record([sample(now - 60_000, VERSION)], notOurs), now)).toBe(false);
    expect(isDue(record([sample(now - 60_000, VERSION)], notOurs), now + 7 * 86_400_000)).toBe(true);
  });

  it("K2: the repair's verdict is one of the unified statuses: fixed passes, not Lane Pilot's is a rework for the PM, the owner's is a block", async () => {
    expect(["fixed", "already-fixed", "not-lane-pilot", "needs-owner"].map((verdict) => repairStatus(verdict as never))).toEqual(["pass", "pass", "rework", "block"]);
    expect(repairStatus(null)).toBeNull();
    const text = repairPrompt([], "blocked:abc:x", { path: "/wt/r/lane-pilot", branch: "lane/r", basePath: "/repo/lane-pilot" });
    expect(text).toMatch(/fixed and already-fixed are a pass, not-lane-pilot a rework \(the PM changes something\), needs-owner a block/);
    const env = setup({}, { thr_repair1: "Готово.\nSELF-REPAIR-VERDICT: not-lane-pilot" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    await repair.tick({ since: 0 });
    await repair.tick();
    const waiting = ((await repair.status()) as { waiting: Array<{ verdict: string | null; status: string | null }> }).waiting;
    expect(waiting[0]).toMatchObject({ verdict: "not-lane-pilot", status: "rework" });
  });

  it("reads the repair's verdict from its last line and stops repeating a not-ours kind", async () => {
    expect(parseVerdict("отчёт…\nSELF-REPAIR-VERDICT: not-lane-pilot")).toBe("not-lane-pilot");
    expect(parseVerdict("no verdict")).toBeNull();
    const env = setup({}, { thr_repair1: "Готово.\nSELF-REPAIR-VERDICT: already-fixed" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    await repair.tick();
    const record = Object.values((await repair.state()).signatures)[0]!;
    expect(record.verdict).toBe("already-fixed");
    expect(record.spawnVersion).toBe(VERSION);
  });

  it("a repair that ends needs-owner asks the owner in the repair thread, and the answer goes back into it (H8)", async () => {
    const env = setup({}, { thr_repair1: "Нужен выбор: чинить в Lane Stack или в ядре?\nSELF-REPAIR-VERDICT: needs-owner" });
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const form = createFakePluginHost({ pluginId: "lane-pilot" });
    const { createOwnerAsk } = await import("../../src/rooms/relay/server/owner-ask");
    const real = createOwnerAsk(form.bb, () => undefined);
    const sent: Array<[string, string]> = [];
    Object.assign(env.ctx, { ownerAsk: { ...real, sendToThread: async (threadId: string, text: string) => { sent.push([threadId, text]); } } });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    await repair.tick();
    expect(form.harness.pendingInteractions).toHaveLength(1);
    const asked = form.harness.pendingInteractions[0]!;
    expect(asked).toMatchObject({ threadId: "thr_repair1", rendererId: "lane-pilot-ask" });
    expect(asked.title).toContain("Самоисправление");
    expect((asked.payload as { detail: string }).detail).toContain("чинить в Lane Stack или в ядре");
    expect((asked.payload as { detail: string }).detail).not.toContain("SELF-REPAIR-VERDICT");
    form.harness.behavior.submitInteraction(asked.id, { choice: "1", text: "в ядре" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe("thr_repair1");
    expect(sent[0]![1]).toContain("the owner answered");
    expect(sent[0]![1]).toContain("в ядре");
    // The verdict is read once: a later pass does not ask again.
    await repair.tick();
    expect(form.harness.pendingInteractions).toHaveLength(0);
  });

  it("a repair that ends needs-owner uses the English form title when locale is en (H8)", async () => {
    const env = setup({}, { thr_repair1: "Нужен выбор: чинить в Lane Stack или в ядре?\nSELF-REPAIR-VERDICT: needs-owner" });
    await env.ctx.bb.storage.kv.set("preferences:locale", "en");
    const form = createFakePluginHost({ pluginId: "lane-pilot" });
    const { createOwnerAsk } = await import("../../src/rooms/relay/server");
    const real = createOwnerAsk(form.bb, () => undefined);
    Object.assign(env.ctx, { ownerAsk: { ...real, sendToThread: async () => {} } });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    await repair.tick();
    expect(form.harness.pendingInteractions).toHaveLength(1);
    expect(form.harness.pendingInteractions[0]!.title).toContain("Self-repair");
  });

  it("an unfamiliar reason in three tasks within a day is a pattern", async () => {
    const env = setup();
    for (const n of [1, 2, 3]) env.attempt(`lpattempt_${n}`, "lprun_a", "empty_output", `writer changed no files in apps/x${n}`);
    env.attempt("lpattempt_9", "lprun_a", "blocked", "needs_human: which button?");
    const rows = await createSelfRepair(env.ctx).collect(0, (await createSelfRepair(env.ctx).config()));
    expect(rows.filter((row) => row.kind === "repeat").map((row) => row.attemptId).sort()).toEqual(["lpattempt_1", "lpattempt_2", "lpattempt_3"]);
    const two = setup();
    for (const n of [1, 2]) two.attempt(`lpattempt_${n}`, "lprun_a", "empty_output", "writer changed no files");
    expect((await createSelfRepair(two.ctx).collect(0, await createSelfRepair(two.ctx).config())).filter((row) => row.kind === "repeat")).toEqual([]);
  });

  it("a writer pair skipped on its spent usage window in three tasks is not a pattern", async () => {
    const env = setup();
    // proj_acpiaqf4wq 2026-10-11: each skip was followed by an accepted attempt on the next model of the chain.
    const reason = "writer_provider_unavailable:usage_window:acp-cursor/grok-4.6: Plan usage at 100%, resets 2026-10-19T10:30:34.000Z";
    for (const n of [1, 2, 3]) env.attempt(`lpattempt_${n}`, "lprun_a", "blocked", reason, env.now, null as never);
    for (const n of [4, 5, 6]) env.attempt(`lpattempt_${n}`, "lprun_a", "blocked", "writer_provider_unavailable:breaker_open:acp-cursor/grok-4.6 failed 3 times");
    const rows = await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config());
    expect(rows.filter((row) => row.kind === "repeat")).toEqual([]);
  });

  it("a writer's own stray files in three tasks are not a pattern; a gate that rejects owned or bookkeeping files still is", async () => {
    // proj_acpiaqf4wq 2026-10-19/20: three writers edited files outside their owns_paths, each was told and accepted on the redo.
    const cases: Array<[string, string, string[]]> = [
      ["lpattempt_1", "owns_paths rejected apps/site/i18n/locales/areas/home/en.json, apps/site/i18n/locales/areas/home/ru.json",
        ["apps/site/app/pages/share/", "apps/site/i18n/locales/areas/share/", "apps/site/i18n/locales/areas/tools-hubs/"]],
      ["lpattempt_2", "owns_paths rejected apps/site/app/pages/en/ai-cards/[pageSlug].vue, apps/site/app/pages/en/ai-cards/index.vue",
        ["apps/site/app/pages/tools/otkrytki-po-foto/", "apps/site/app/pages/en/tools/", "apps/site/app/components/blocks/cards/"]],
      ["lpattempt_7", "retry limit 2 exhausted: owns_paths rejected scripts/__tests__/release-services.test.mjs, scripts/x.mjs", ["deploy/"]],
      ["lpattempt_3", "owns_paths rejected apps/site/app/content/blocks/14-sticky-cta.html, apps/site/server/__tests__/use-site-login-region.test.ts",
        ["apps/site/app/app.vue", "apps/site/app/layouts/", "apps/site/app/components/", "apps/site/app/composables/", "apps/site/tests/"]],
    ];
    const contract = (owns: string[]) => JSON.stringify({ owns_paths: owns, never_touch: ["apps/marketing/"] });
    const env = setup();
    for (const [id, reason, owns] of cases) {
      env.attempt(id, "lprun_a", "validation_failed", reason);
      env.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES (?,'lprun_a','bb',?,?)").run(`task-${id}`, contract(owns), env.now);
    }
    expect((await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config())).filter((row) => row.kind === "repeat")).toEqual([]);
    // The gate's own fault keeps the pattern: an owned file rejected, bookkeeping only, or a task with no contract to judge by.
    const gate = setup();
    gate.attempt("lpattempt_4", "lprun_a", "validation_failed", "owns_paths rejected src/a.ts, src/b.ts");
    gate.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_4','lprun_a','bb',?,?)").run(contract(["src/"]), gate.now);
    gate.attempt("lpattempt_5", "lprun_a", "validation_failed", "owns_paths rejected .agents/PROGRESS.md, .bb/chats/x.md");
    gate.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_5','lprun_a','bb',?,?)").run(contract(["src/"]), gate.now);
    gate.attempt("lpattempt_6", "lprun_a", "validation_failed", "owns_paths rejected lib/c.ts, lib/d.ts");
    const rows = await createSelfRepair(gate.ctx).collect(0, await createSelfRepair(gate.ctx).config());
    expect(rows.filter((row) => row.kind === "repeat").map((row) => row.attemptId).sort()).toEqual(["lpattempt_4", "lpattempt_5", "lpattempt_6"]);
  });

  it("sees a task queued for hours while nothing runs, and a stage nobody will finish", async () => {
    const env = setup();
    const hours = (n: number) => env.now - n * 3_600_000;
    env.attempt("lpattempt_q", "lprun_a", "queued", null, hours(3));
    env.attempt("lpattempt_done", "lprun_a", "blocked", "acceptance unmet", hours(3));
    env.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_done','lprun_a','bb','{}',?)").run(hours(4));
    env.db.prepare(`INSERT INTO lane_pilot_stage_receipt (run_id, task_id, stage_id, contract_version, state, input_sha256, attempt, updated_at)
      VALUES ('lprun_a','task-lpattempt_done','acceptance-receipt',1,'pending','x',0,?)`).run(hours(2));
    const rows = await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config());
    expect(rows.filter((row) => row.kind === "queued").map((row) => row.attemptId)).toEqual(["lpattempt_q"]);
    expect(rows.filter((row) => row.kind === "stage").map((row) => row.attemptId)).toEqual(["stage:lprun_a:task-lpattempt_done:acceptance-receipt"]);
    const busy = setup();
    busy.attempt("lpattempt_q", "lprun_a", "queued", null, busy.now - 3 * 3_600_000);
    busy.attempt("lpattempt_r", "lprun_a", "running", null, busy.now - 60_000);
    expect((await createSelfRepair(busy.ctx).collect(0, await createSelfRepair(busy.ctx).config())).filter((row) => row.kind === "queued")).toEqual([]);
  });

  it("a queued task is not reported while an attempt of its run is being spawned or canceled", async () => {
    // proj_a35nni238u 2026-10-12: ck-13-deploy-prep-v2 waited on ck-14's owned paths while ck-14 sat 30 min in cancel_requested.
    for (const state of ["spawn_requested", "spawn_unknown", "cancel_requested"]) {
      const env = setup();
      env.attempt("lpattempt_q", "lprun_a", "queued", null, env.now - 156 * 60_000);
      env.attempt("lpattempt_h", "lprun_a", state, null, env.now - 4 * 60_000);
      const rows = await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config());
      expect(rows.filter((row) => row.kind === "queued"), state).toEqual([]);
    }
  });

  it("a queued task waiting for a blocked depends_on is the PM's move until the redo wait has passed", async () => {
    // proj_a35nni238u 2026-10-12: ck-13/ck-05c/ck-14 depend on ck-12-e2e-v2, which blocked at 06:04; the watcher reported
    // them at 06:15, and they ran within a minute of the PM's ck-12-e2e-v2.2 being accepted at 10:57.
    const queuedWith = (blockedAgo: number) => {
      const env = setup();
      env.attempt("lpattempt_dep", "lprun_a", "blocked", "turn limit 5 reached: verification failed", env.now - blockedAgo);
      env.attempt("lpattempt_q", "lprun_a", "queued", null, env.now - 215 * 60_000);
      env.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_q','lprun_a','bb',?,?)")
        .run(JSON.stringify({ depends_on: ["task-lpattempt_dep"] }), env.now - 215 * 60_000);
      return env;
    };
    const fresh = queuedWith(11 * 60_000);
    expect((await createSelfRepair(fresh.ctx).collect(0, await createSelfRepair(fresh.ctx).config())).filter((row) => row.kind === "queued")).toEqual([]);
    // Past the six-hour wait (and a pass of slack) the dependent should have ended blocked itself: still queued is a fault.
    // A chain is reported at its head only: ck-14 waited for ck-05c, itself queued behind the blocked ck-12.
    const chain = queuedWith(11 * 60_000);
    chain.attempt("lpattempt_q2", "lprun_a", "queued", null, chain.now - 124 * 60_000);
    chain.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_q2','lprun_a','bb',?,?)")
      .run(JSON.stringify({ depends_on: ["task-lpattempt_q"] }), chain.now - 124 * 60_000);
    expect((await createSelfRepair(chain.ctx).collect(0, await createSelfRepair(chain.ctx).config())).filter((row) => row.kind === "queued")).toEqual([]);
    const stale = queuedWith(9 * 3_600_000);
    expect((await createSelfRepair(stale.ctx).collect(0, await createSelfRepair(stale.ctx).config())).filter((row) => row.kind === "queued")
      .map((row) => row.attemptId)).toEqual(["lpattempt_q"]);
  });

  it("a stage whose task's attempt is being spawned or canceled is not left open", async () => {
    // proj_a35nni238u 2026-10-12: ck-09 queued 81 min with its stages pending, then went queued → spawn_requested
    // 1.8 s before the watcher's pass, which counted only running/queued as live and reported both stages.
    for (const state of ["spawn_requested", "spawn_unknown", "cancel_requested"]) {
      const env = setup();
      env.attempt("lpattempt_s", "lprun_a", state, null, env.now - 2_000);
      env.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_s','lprun_a','bb','{}',?)").run(env.now - 82 * 60_000);
      for (const stage of ["verification", "acceptance-receipt"]) env.db.prepare(`INSERT INTO lane_pilot_stage_receipt (run_id, task_id, stage_id, contract_version, state, input_sha256, attempt, updated_at)
        VALUES ('lprun_a','task-lpattempt_s',?,1,'pending','x',0,?)`).run(stage, env.now - 81 * 60_000);
      const rows = await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config());
      expect(rows.filter((row) => row.kind === "stage"), state).toEqual([]);
    }
  });

  it("the prompt keeps the repair in its worktree: commit on the branch, never deploy, report to the PM", () => {
    const workspace = { path: "/wt/self-repair-1/lane-pilot", branch: "lane/self-repair-1", basePath: "/repo/lane-pilot" };
    const text = repairPrompt([{ signature: "s", kind: "blocked", projectId: "p", runId: "r", taskId: "t", attemptId: "a", pmThreadId: "thr_pm", writerThreadId: null, reason: "x", at: 0 }], "blocked:abc:x", workspace);
    expect(text).toMatch(/Verify against the real case/);
    expect(text).toContain("/wt/self-repair-1/lane-pilot is your own git worktree on branch lane/self-repair-1");
    expect(text).toMatch(/Do NOT deploy, bump the version, push, merge or create a release/);
    expect(text).not.toMatch(/gh release create|bash \/Users|origin main/);
    expect(text).toMatch(/continue only when it is green/);
    expect(text).toMatch(/<incidents>[\s\S]*1970-01-01T00:00:00.000Z[\s\S]*<\/incidents>/);
    expect(text).toMatch(/never git add -A/);
    expect(text).toMatch(/already fixed/);
    expect(text.trim().split("\n").at(-3)).toMatch(/SELF-REPAIR-VERDICT: fixed \| already-fixed \| not-lane-pilot \| needs-owner/);
    expect(text).toContain("bb thread tell");
    expect(text).toContain("Tell a PM thread only when that PM has to do something now");
    expect(text).toMatch(/Never send an informational note: already-fixed, false alarm, «was not stuck», «for the record»/);
  });

  it("step 6 marks an idle PM do-not-message with hours, and a live PM keeps the tell", () => {
    const workspace = { path: "/wt/r/lane-pilot", branch: "lane/r", basePath: "/repo/lane-pilot" };
    const now = Date.parse("2026-10-15T10:00:00.000Z");
    const sample = (pmThreadId: string) => ({
      signature: "s", kind: "blocked" as const, projectId: "p", runId: "r", taskId: "t", attemptId: `a-${pmThreadId}`,
      pmThreadId, writerThreadId: null, reason: "x", at: 0,
    });
    const idle = repairPrompt([sample("thr_idle")], "blocked:abc:x", workspace, undefined, {
      now, lastOwnerAt: { thr_idle: now - 36 * 3_600_000 },
    });
    expect(idle).toMatch(/@thread:thr_idle — idle \(36 hours since the owner's last message\)/);
    expect(idle).toContain("Do not message it; put what that PM should do into the report for the owner.");
    expect(idle).not.toMatch(/bb thread tell thr_idle/);
    expect(idle).toContain("Never send an informational note");

    const live = repairPrompt([sample("thr_live")], "blocked:abc:x", workspace, undefined, {
      now, lastOwnerAt: { thr_live: now - 3_600_000 },
    });
    expect(live).toContain("@thread:thr_live — live (owner wrote within 24h)");
    expect(live).toContain('bb thread tell thr_live "…"');
    expect(live).not.toContain("Do not message it");

    const unread = repairPrompt([sample("thr_unread")], "blocked:abc:x", workspace, undefined, {
      now, lastOwnerAt: { thr_unread: null },
    });
    expect(unread).toContain("@thread:thr_unread — live (owner wrote within 24h)");
    expect(unread).toContain('bb thread tell thr_unread "…"');
  });

  it("treats a PM as live when the last owner message time cannot be read", async () => {
    expect(await lastPmOwnerMessageAt(async () => { throw new Error("sdk down"); }, "thr_pm")).toBeNull();
    expect(await lastPmOwnerMessageAt(async () => [], "thr_pm")).toBeNull();
    const at = Date.parse("2026-10-14T00:00:00.000Z");
    expect(await lastPmOwnerMessageAt(async () => [
      { seq: 9, createdAt: at + 1, data: { initiator: "agent" } },
      { seq: 8, createdAt: at, data: { initiator: "user" } },
    ], "thr_pm")).toBe(at);
  });

  it("the spawned repair brief uses the PM's last owner turn from the SDK", async () => {
    const env = setup({}, {}, {}, { thr_pm: Date.now() - 40 * 3_600_000 });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    await createSelfRepair(env.ctx).tick({ since: 0 });
    const prompt = String(env.spawns[0]!.prompt);
    expect(prompt).toMatch(/@thread:thr_pm — idle \(40 hours since the owner's last message\)/);
    expect(prompt).toContain("Do not message it");
    expect(prompt).not.toMatch(/bb thread tell thr_pm/);
  });

  it("tells the repair where the hub's run data is from the configuration, with today's values as the default", async () => {
    const workspace = { path: "/wt/r/lane-pilot", branch: "lane/r", basePath: "/repo/lane-pilot" };
    const byDefault = repairPrompt([], "blocked:abc:x", workspace);
    expect(byDefault).toContain("ssh -i ~/.ssh/oracle_bb ubuntu@10.8.0.1, sqlite3 /home/ubuntu/.bb/plugins/lane-pilot/data.db");
    expect(byDefault).toContain("Plugin log: /home/ubuntu/.bb/plugins/lane-pilot/logs/plugin.log on the hub.");
    const env = setup();
    await createSelfRepair(env.ctx).setConfig({ hubSsh: "ssh ops@hub2", hubDb: "/srv/lp/data.db", hubLog: "/srv/lp/plugin.log" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    await createSelfRepair(env.ctx).tick({ since: 0 });
    const prompt = String(env.spawns[0]!.prompt);
    expect(prompt).toContain("on the hub: ssh ops@hub2, sqlite3 /srv/lp/data.db (");
    expect(prompt).toContain("Plugin log: /srv/lp/plugin.log on the hub.");
    expect(prompt).not.toContain("oracle_bb");
  });

  describe("own worktree (E2)", () => {
    const fixed = "Готово.\nSELF-REPAIR-VERDICT: fixed";

    it("each repair gets a Lane Pilot worktree of the configured checkout and the thread works in it", async () => {
      const env = setup();
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
      const created = env.hostCalls.find((call) => call.method === "gitCreateWorktree")!;
      expect(created.input).toMatchObject({ requestedHostId: "host_mac", basePath: "/repo/lane-pilot" });
      expect(String(created.input.name)).toMatch(/^self-repair-[0-9a-f]{8}-[a-z0-9]+$/);
      expect(env.hostCalls.map((call) => call.method)).toEqual(["gitCreateWorktree", "gitPrepareWorktree"]);
      const record = Object.values((await repair.state()).signatures)[0]!;
      expect(record.worktree).toMatchObject({ hostId: "host_mac", basePath: "/repo/lane-pilot", branch: `lane/${String(created.input.name)}` });
      const prompt = String(env.spawns[0]!.prompt);
      expect(prompt).toContain(`/wt/${String(created.input.name)}/lane-pilot is your own git worktree on branch lane/${String(created.input.name)}`);
      expect(prompt).toContain("Do NOT deploy");
      expect(env.spawns[0]!.pluginMetadata).toMatchObject({ role: "self-repair", repairBranch: `lane/${String(created.input.name)}` });
    });

    it("no worktree, no repair: the shared checkout is not a fallback and the kind stays due", async () => {
      const env = setup({}, {}, { gitCreateWorktree: { status: "failed", path: null, branch: null, reason: "disk full" } });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      const result = await repair.tick({ since: 0 });
      expect(result.spawned).toBeNull();
      expect(result.reason).toContain("worktree not created: disk full");
      expect(env.spawns).toHaveLength(0);
      expect(Object.values((await repair.state()).signatures)[0]!.spawnedAt).toBeNull();
    });

    it("a spawn that throws releases the worktree it just made", async () => {
      const env = setup({}, {}, { spawn: new Error("provider down") });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const result = await createSelfRepair(env.ctx).tick({ since: 0 });
      expect(result.reason).toBe("spawn failed: provider down");
      expect(env.hostCalls.map((call) => call.method)).toEqual(["gitCreateWorktree", "gitPrepareWorktree", "gitWorktreeSnapshot", "gitRemoveWorktree"]);
    });

    /** The core has thread keys: a keyed spawn holds its key, and `lose` answers are lost after the thread is made. */
    const keyedCore = (env: ReturnType<typeof setup>, lose: number) => {
      const base = env.ctx.bb as unknown as { sdk: { threads: Record<string, (...args: unknown[]) => Promise<unknown>> } };
      const held = new Map<string, unknown>();
      const core = { down: false };
      const keyedSpawn = async ({ key, ...args }: { key: string } & Record<string, unknown>) => {
        if (core.down) throw new Error("core down");
        if (held.has(key)) return { thread: held.get(key), reused: true };
        const thread = await base.sdk.threads.spawn!(args);
        held.set(key, thread);
        if (lose > 0) { lose -= 1; throw new Error("answer lost"); }
        return { thread, reused: false };
      };
      (env.ctx as unknown as { bb: unknown }).bb = new Proxy(env.ctx.bb as object, { get: (target, name) => name === "vk" ? {}
        : name === "sdk"
          ? new Proxy(base.sdk, { get: (sdk, part) => part === "threads" ? new Proxy(base.sdk.threads, { get: (threads, method) => method === "experimental_vkSpawnKeyed" ? keyedSpawn : method === "experimental_vkFindByKey" ? async () => null : Reflect.get(threads, method) }) : Reflect.get(sdk, part) })
          : Reflect.get(target, name, target) });
      return core;
    };

    it("a spawn whose answer was lost keeps its worktree, and the next pass gets the same repair thread back", async () => {
      const env = setup();
      keyedCore(env, 1);
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      const first = await repair.tick({ since: 0 });
      expect(first.spawned).toBeNull();
      expect(first.reason).toBe("spawn failed: answer lost");
      expect(env.hostCalls.map((call) => call.method)).toEqual(["gitCreateWorktree", "gitPrepareWorktree"]);
      const pending = Object.values((await repair.state()).signatures)[0]!.pending!;
      expect(pending.worktree.path).toContain("/wt/self-repair-");
      const second = await repair.tick();
      expect(second.spawned).toBe("thr_repair1");
      expect(env.spawns).toHaveLength(1);
      expect(env.hostCalls.filter((call) => call.method === "gitCreateWorktree")).toHaveLength(1);
      const record = Object.values((await repair.state()).signatures)[0]!;
      expect(record.worktree).toEqual(pending.worktree);
      expect(record.pending).toBeNull();
      expect(env.hostCalls.map((call) => call.method)).not.toContain("gitRemoveWorktree");
    });

    it("a spawn that stays unsettled for too long releases the worktree", async () => {
      const env = setup();
      const core = keyedCore(env, 1);
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      core.down = true;
      const state = await repair.state();
      Object.values(state.signatures)[0]!.pending!.at -= 31 * 60_000;
      await env.ctx.bb.storage.kv.set("self-repair:state", state as never);
      await repair.tick();
      expect(env.hostCalls.map((call) => call.method)).toEqual(["gitCreateWorktree", "gitPrepareWorktree", "gitWorktreeSnapshot", "gitRemoveWorktree"]);
      expect(Object.values((await repair.state()).signatures)[0]!.pending).toBeNull();
    });

    it("gives the repair spawn a stable id", async () => {
      const env = setup();
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      await createSelfRepair(env.ctx).tick({ since: 0 });
      expect(env.spawns[0]!.pluginMetadata).toMatchObject({ role: "self-repair", spawnId: expect.stringMatching(/^blocked:.*:0$/) });
    });

    it("a fixed repair is merged like a writer's work, its worktree is removed, and nothing deploys", async () => {
      const env = setup({}, { thr_repair1: fixed });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      const worktree = (Object.values((await repair.state()).signatures)[0]!).worktree!;
      env.hostCalls.length = 0;
      await repair.tick();
      expect(env.hostCalls).toHaveLength(1);
      expect(env.hostCalls[0]).toMatchObject({ method: "gitIntegrate", input: { basePath: "/repo/lane-pilot", worktreePath: worktree.path, removeWorktree: true } });
      expect(String(env.hostCalls[0]!.input.message)).toMatch(/^self-repair: /);
      const record = Object.values((await repair.state()).signatures)[0]!;
      expect(record.verdict).toBe("fixed");
      expect(record.worktree).toBeNull();
      expect(record.outcome).toBe("merged abcdef123456");
      expect(env.logs.some((line) => line.startsWith("self-repair: merged abcdef123456") && !/failed/i.test(line))).toBe(true);
      env.hostCalls.length = 0;
      await repair.tick();
      expect(env.hostCalls).toEqual([]);
    });

    it("a conflict is retried on later passes, then the work is saved as a patch and the branch released — nobody is waited for", async () => {
      const env = setup({}, { thr_repair1: fixed }, { gitIntegrate: { status: "conflict", commit: null, conflicts: ["a.ts"], reason: "CONFLICT in a.ts" } });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      for (let pass = 0; pass < 6; pass++) await repair.tick();
      expect(env.hostCalls.filter((call) => call.method === "gitIntegrate")).toHaveLength(4);
      expect(env.hostCalls.map((call) => call.method)).toContain("gitWorktreeSnapshot");
      const record = Object.values((await repair.state()).signatures)[0]!;
      expect(record.worktree).toBeNull();
      expect(record.outcome).toBe("released after 4 failed merges: conflict: CONFLICT in a.ts");
      expect(env.logs.some((line) => line.includes("for the owner"))).toBe(false);
    });

    it("a busy base checkout is not a failed try", async () => {
      const env = setup({}, { thr_repair1: fixed }, { gitIntegrate: { status: "busy", commit: null, conflicts: [], reason: "merge lock held", holder: "x" } });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      for (let pass = 0; pass < 6; pass++) await repair.tick();
      expect(Object.values((await repair.state()).signatures)[0]!.worktree?.mergeTries ?? 0).toBe(0);
    });

    it("any other verdict saves the worktree as a patch and releases it without merging", async () => {
      const env = setup({}, { thr_repair1: "Не наша.\nSELF-REPAIR-VERDICT: not-lane-pilot" });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      env.hostCalls.length = 0;
      await repair.tick();
      expect(env.hostCalls.map((call) => call.method)).toEqual(["gitWorktreeSnapshot", "gitRemoveWorktree"]);
      const record = Object.values((await repair.state()).signatures)[0]!;
      expect(record.worktree).toBeNull();
      expect(record.outcome).toBe("released: not-lane-pilot");
    });

    it("a repair that ends without a verdict keeps its worktree for a day, then it is released", async () => {
      const env = setup({}, { thr_repair1: "no verdict here" });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      env.hostCalls.length = 0;
      await repair.tick();
      expect(env.hostCalls).toEqual([]);
      const state = await repair.state();
      Object.values(state.signatures)[0]!.spawnedAt = Date.now() - 25 * 3_600_000;
      await env.ctx.bb.storage.kv.set("self-repair:state", state as never);
      await repair.tick();
      // The day-old kind is due again, so a new repair follows the release.
      expect(env.hostCalls.map((call) => call.method).slice(0, 2)).toEqual(["gitWorktreeSnapshot", "gitRemoveWorktree"]);
      expect(env.spawns).toHaveLength(2);
    });

    it("a dry run touches no worktree", async () => {
      const env = setup({}, { thr_repair1: fixed });
      env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
      const repair = createSelfRepair(env.ctx);
      await repair.tick({ since: 0 });
      env.hostCalls.length = 0;
      await repair.tick({ dryRun: true });
      expect(env.hostCalls).toEqual([]);
    });
  });
});

describe("which due problem is repaired first (audit round 2, #20)", () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const record = (over: Partial<{ count: number; lastAt: number; projects: string[] }> = {}) => ({
    count: over.count ?? 1, lastAt: over.lastAt ?? now,
    samples: (over.projects ?? ["proj_real"]).map((projectId, index) => ({ signature: "x", kind: "blocked" as const, projectId, runId: "r", taskId: "t", attemptId: `a${index}`, pmThreadId: null, writerThreadId: null, reason: "x", at: now })),
  });
  const ignored = new Set(["proj_3tb652jpsi"]);

  it("puts a fresh failure in a real project before an older drill artifact", () => {
    const real = repairPriority("blocked:aaaa:internal_error", record(), now, ignored);
    const drill = repairPriority("drill:bbbb:parked-restart", record({ projects: ["-"], count: 9, lastAt: now - 3 * 86_400_000 }), now, ignored);
    expect(real).toBeGreaterThan(drill);
  });

  it("weighs frequency, recency, the number of real projects and the kind", () => {
    const base = repairPriority("blocked:a:x", record(), now, ignored);
    expect(repairPriority("blocked:a:x", record({ count: 16 }), now, ignored)).toBeGreaterThan(base);
    expect(repairPriority("blocked:a:x", record({ lastAt: now - 2 * 86_400_000 }), now, ignored)).toBeLessThan(base);
    expect(repairPriority("blocked:a:x", record({ projects: ["proj_a", "proj_b"] }), now, ignored)).toBeGreaterThan(base);
    expect(repairPriority("blocked:a:x", record({ projects: ["proj_3tb652jpsi"] }), now, ignored)).toBeLessThan(base);
    expect(repairPriority("breaker:a:x", record(), now, ignored)).toBeGreaterThan(base);
    expect(repairPriority("log:a:x", record(), now, ignored)).toBeLessThan(base);
  });

  it("starts the highest priority repair, not the oldest signature", async () => {
    const env = setup();
    const repair = createSelfRepair(env.ctx);
    const old = reasonSignature("log", "Lane Pilot something failed in the log");
    const urgent = reasonSignature("blocked", "internal_error: merge queue stuck");
    const longAgo = Date.now() - 40 * 86_400_000;
    const sample = (signature: string, kind: "log" | "blocked", projectId: string) => ({ signature, kind, projectId, runId: "-", taskId: "-", attemptId: `s-${kind}`, pmThreadId: null, writerThreadId: null, reason: "x", at: Date.now(), version: VERSION });
    await env.ctx.bb.storage.kv.set("self-repair:state", { cursor: Date.now(), lastTickAt: null, spawned: [], aliases: {}, signatures: {
      [old]: { firstAt: longAgo, lastAt: Date.now(), count: 1, threadId: null, spawnedAt: null, samples: [sample(old, "log", "-")] },
      [urgent]: { firstAt: Date.now() - 3600_000, lastAt: Date.now(), count: 5, threadId: null, spawnedAt: null, samples: [sample(urgent, "blocked", "proj_real")] },
    } } as never);
    const result = await repair.tick({ since: Date.now() });
    expect(result.spawned).toBe("thr_repair1");
    expect(String(env.spawns[0]!.prompt)).toContain("merge queue stuck");
    expect((await repair.status()).waiting.find((row) => row.signature.startsWith("blocked:"))?.priority).toBeGreaterThan(0);
  });
});

describe("J-10: a new wording of a known problem (selfrepair.group)", () => {
  function scriptedJev(db: ReturnType<typeof openDatabase>, pickKnown: boolean) {
    const requests: Array<{ state: unknown; options: string[] }> = [];
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request) {
        const [id, question] = Object.entries(request.questions)[0]!;
        const options = Object.keys((question as { criteria: Record<string, unknown> }).criteria);
        requests.push({ state: request.state, options });
        const probabilities = pickKnown ? { g0: 0.93, new_problem: 0.07 } : { g0: 0.1, new_problem: 0.9 };
        return { ok: true, model: "jev-test", usage: { input_tokens: 300, output_tokens: 20 }, latencyMs: 90, attempts: 1,
          answers: { [id]: { type: "choice", choice: pickKnown ? "g0" : "new_problem", probabilities, confidence: 0.8 } } };
      },
    };
    setJevForTests(createJev({ client, db }));
    return requests;
  }

  async function twoWordings(mode: "shadow" | "active", pickKnown: boolean) {
    const env = setup({ thr_repair1: "running" });
    (env.ctx as unknown as { effectiveProjectSettings: unknown }).effectiveProjectSettings = async () => ({ values: { "jev.modes": `selfrepair.group=${mode}` } });
    const requests = scriptedJev(env.db, pickKnown);
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    await repair.tick({ since: 0 });
    env.attempt("lpattempt_2", "lprun_a", "blocked", "merge_failed: unable to write new index file");
    const second = await repair.tick({ since: 0 });
    return { env, repair, requests, second, state: await repair.state() };
  }

  it("shadow (the default): asks, records a receipt and changes nothing", async () => {
    const { env, requests, state } = await twoWordings("shadow", true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options).toEqual(["g0", "new_problem"]);
    expect(Object.keys(state.signatures)).toHaveLength(2);
    expect(state.aliases).toEqual({});
    const receipt = env.db.prepare("SELECT judgment, mode, decided_by, decision FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(receipt).toMatchObject({ judgment: "selfrepair.group", mode: "shadow", decided_by: "fallback" });
  });

  it("active: a clear pick files the new wording under the known group and remembers it", async () => {
    const { requests, state, second, repair } = await twoWordings("active", true);
    expect(requests).toHaveLength(1);
    expect(Object.keys(state.signatures)).toHaveLength(1);
    expect(second.signatures).toHaveLength(1);
    const [known] = Object.keys(state.signatures);
    expect(state.signatures[known!]!.count).toBe(2);
    expect(Object.values(state.aliases)).toEqual([known]);
    // The next sighting of that wording goes to the group without asking again.
    await repair.tick({ since: 0 });
    expect(requests).toHaveLength(1);
  });

  it("active, but Jev says it is a different problem: a group of its own, as before", async () => {
    const { state } = await twoWordings("active", false);
    expect(Object.keys(state.signatures)).toHaveLength(2);
    expect(state.aliases).toEqual({});
  });

  it("no Jev (not installed): nothing is asked and nothing changes", async () => {
    setJevForTests(null);
    const env = setup({ thr_repair1: "running" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    await repair.tick({ since: 0 });
    env.attempt("lpattempt_2", "lprun_a", "blocked", "merge_failed: unable to write new index file");
    await repair.tick({ since: 0 });
    expect(Object.keys((await repair.state()).signatures)).toHaveLength(2);
  });
});

describe("J-11: an output the guard withheld becomes a self-repair incident", () => {
  it("raises one incident for it, in the project it came from, and starts a repair", async () => {
    const env = setup();
    await env.ctx.bb.storage.kv.set("output-guard:blocked", [{ at: Date.now(), kind: "errand", reason: "secret", projectId: "proj_real", runId: "lprun_a", subject: "thr_errand" }] as never);
    const repair = createSelfRepair(env.ctx);
    const result = await repair.tick({ since: 0 });
    expect(result.incidents).toBe(1);
    expect(result.signatures[0]).toMatch(/^guard:/);
    expect(result.spawned).toBe("thr_repair1");
    expect(String(env.spawns[0]!.prompt)).toContain("withheld by the output guard");
  });

  it("ignores a block in the sandbox project", async () => {
    const env = setup();
    await env.ctx.bb.storage.kv.set("output-guard:blocked", [{ at: Date.now(), kind: "writer", reason: "injection", projectId: "proj_3tb652jpsi", runId: null, subject: null }] as never);
    expect((await createSelfRepair(env.ctx).tick({ since: 0 })).incidents).toBe(0);
  });
});
