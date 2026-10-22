import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../server";
import type { EventLike, ThreadLike } from "../src/rooms/anamnesis";
import { SEED_ENTRIES } from "../src/rooms/deferral/seed";
import { createDeferrals, runDeferralCli } from "../src/rooms/deferral/server";
import { parseOwnerRef, sha256Text, verifyOwnerMessage, type OwnerMessagePort } from "../src/rooms/deferral/verify";
import { migrations, openDatabase } from "../src/rooms/storage/database";

// SMA rule 5: a deferral's term is the owner's date, read from a real message of the owner; an agent cannot make one up or move one.
const T0 = Date.parse("2026-10-22T10:00:00Z");
const DAY = 86_400_000;

type Msg = { seq: number; text: string; at?: number; data?: Record<string, unknown> };
/** One top-level thread of the owner with the given requests, and one agent thread, one plugin thread. */
function fakePort(extra: { threads?: Record<string, Partial<ThreadLike>>; events?: Record<string, EventLike[]> } = {}): OwnerMessagePort & { reads: number } {
  const owner = (text: string, seq: number, at = T0, data: Record<string, unknown> = {}): EventLike => ({
    seq, type: "client/turn/requested", createdAt: at, data: { initiator: "user", inputGroups: [[{ type: "text", text }]], ...data },
  });
  const threads: Record<string, ThreadLike> = {
    thr_owner: { id: "thr_owner", projectId: "proj_a", createdAt: T0 - DAY },
    thr_plugin: { id: "thr_plugin", projectId: "proj_a", createdAt: T0 - DAY, originPluginId: "lane-pilot" },
    thr_child: { id: "thr_child", projectId: "proj_a", createdAt: T0 - DAY, parentThreadId: "thr_owner" },
    ...Object.fromEntries(Object.entries(extra.threads ?? {}).map(([id, patch]) => [id, { id, projectId: "proj_a", createdAt: T0 - DAY, ...patch }])),
  };
  const events: Record<string, EventLike[]> = {
    thr_owner: [
      owner("отложим до 5 ноября, это не горит", 3),
      owner("да, отложи", 4),
      owner("либо 5 ноября, либо 20 ноября", 5),
      owner("нужен новый срок: до 2026-12-01", 9, T0 + 5 * DAY),
      { seq: 6, type: "client/turn/requested", createdAt: T0, data: { initiator: "agent", senderThreadId: "thr_pm", inputGroups: [[{ type: "text", text: "owner said: до 5 ноября" }]] } },
      owner("[bb message from thread:thr_pm] до 5 ноября", 7),
      owner("system notice до 5 ноября", 8, T0, { systemMessageKind: "relay" }),
      owner("повтор до 5 ноября", 10, T0, { retryOfRequestId: "req_1" }),
    ],
    thr_plugin: [owner("до 5 ноября", 1)],
    thr_child: [owner("до 5 ноября", 1)],
    ...(extra.events ?? {}),
  };
  const port = {
    reads: 0,
    getThread: async (id: string) => threads[id] ?? null,
    listEvents: async ({ threadId, afterSeq, limit }: { threadId: string; afterSeq: number; limit: number }) => {
      port.reads += 1;
      return (events[threadId] ?? []).filter((event) => event.seq > afterSeq).sort((a, b) => a.seq - b.seq).slice(0, limit);
    },
  };
  return port;
}

function register(clock = { now: T0 + 1000 }) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const port = fakePort();
  const api = createDeferrals({ db, port, now: () => clock.now });
  return { api, db, port, clock };
}

describe("the owner's message that gives a term", () => {
  it("reads <thread>#<seq>, :index and the collector's own message id", () => {
    expect(parseOwnerRef("thr_a#12")).toEqual({ threadId: "thr_a", seq: 12, index: 0 });
    expect(parseOwnerRef("thr_a#12:1")).toEqual({ threadId: "thr_a", seq: 12, index: 1 });
    expect(parseOwnerRef("thr_a:12:0")).toEqual({ threadId: "thr_a", seq: 12, index: 0 });
    expect(parseOwnerRef("nonsense")).toBeNull();
  });

  it("accepts a request the user made in his own thread and keeps the text's hash", async () => {
    const checked = await verifyOwnerMessage(fakePort(), "thr_owner#3");
    expect(checked).toMatchObject({ ok: true, message: { threadId: "thr_owner", seq: 3, messageId: "thr_owner:3:0", at: T0, text: "отложим до 5 ноября, это не горит" } });
    expect(checked.ok && checked.message.sha256).toBe(sha256Text("отложим до 5 ноября, это не горит"));
  });

  it.each([
    ["thr_owner#6", /initiator is «agent»/],
    ["thr_owner#7", /not a message the owner wrote/],
    ["thr_owner#8", /system message/],
    ["thr_owner#10", /retry/],
    ["thr_plugin#1", /made by the plugin lane-pilot/],
    ["thr_child#1", /child thread/],
  ])("refuses %s: not the owner's own message", async (ref, why) => {
    const checked = await verifyOwnerMessage(fakePort(), ref);
    expect(checked.ok).toBe(false);
    expect(!checked.ok && checked.error).toMatch(why);
  });

  it("refuses a thread or an event that is not there", async () => {
    expect(await verifyOwnerMessage(fakePort(), "thr_none#1")).toMatchObject({ ok: false, error: expect.stringMatching(/was not found/) });
    expect(await verifyOwnerMessage(fakePort(), "thr_owner#99")).toMatchObject({ ok: false, error: expect.stringMatching(/no user message at event 99/) });
    expect(await verifyOwnerMessage(fakePort(), "x")).toMatchObject({ ok: false, error: expect.stringMatching(/not a message reference/) });
  });
});

describe("writing a term", () => {
  it("opens an entry with the date the owner named and records the message, its hash and the quote", async () => {
    const { api, db } = register();
    const { entry, created } = await api.defer({ what: "second drill scenario: reload", kind: "drill_scenario", area: "drill", ownerMsg: "thr_owner#3" });
    expect(created).toBe(true);
    expect(entry).toMatchObject({ state: "open", kind: "drill_scenario", due: "2026-11-05", dueSource: "explicit", ownerMsg: "thr_owner#3", projectId: null });
    expect(entry.ownerQuote).toContain("до 5 ноября");
    const row = db.prepare("SELECT * FROM lane_pilot_deferral WHERE id=?").get(entry.id) as { owner_ref: string; due_at: number; closed_by: string | null };
    expect(JSON.parse(row.owner_ref)).toMatchObject({ threadId: "thr_owner", seq: 3, index: 0, sha256: sha256Text("отложим до 5 ноября, это не горит"), at: T0 });
    expect(row.due_at).toBe(Date.parse("2026-11-05T23:59:59.999Z"));
  });

  it("a decision without a date gets the message time plus 14 days, marked default_14d", async () => {
    const { api } = register();
    const { entry } = await api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#4" });
    expect(entry).toMatchObject({ due: "2026-11-05", dueSource: "default_14d" });
  });

  it("refuses a date the message does not name, an ambiguous message without --due, and a message from an agent", async () => {
    const { api } = register();
    await expect(api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#3", due: "2026-12-24" })).rejects.toThrow(/does not name 2026-12-24; it names 2026-11-05/);
    await expect(api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#5" })).rejects.toThrow(/names several dates/);
    expect((await api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#5", due: "2026-11-20" })).entry.due).toBe("2026-11-20");
    await expect(api.defer({ what: "y", kind: "gate", ownerMsg: "thr_owner#6" })).rejects.toThrow(/not a message the owner wrote/);
    await expect(api.defer({ what: "y", kind: "nope", ownerMsg: "thr_owner#3" })).rejects.toThrow(/--kind must be one of/);
    expect(api.list().entries.filter((item) => item.what === "y")).toEqual([]);
  });

  it("moving a term needs a NEWER owner message; the old one, an agent's text and a closed entry are refused", async () => {
    const { api } = register();
    const { entry } = await api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#3" });
    await expect(api.defer({ what: entry.id, ownerMsg: "thr_owner#3", due: "2026-11-05" })).rejects.toThrow(/needs a NEWER message/);
    await expect(api.defer({ what: entry.id, ownerMsg: "thr_owner#4" })).rejects.toThrow(/needs a NEWER message/);
    await expect(api.defer({ what: entry.id, ownerMsg: "thr_owner#6" })).rejects.toThrow(/not a message the owner wrote/);
    const moved = await api.defer({ what: entry.id, ownerMsg: "thr_owner#9" });
    expect(moved).toMatchObject({ created: false, entry: { id: entry.id, due: "2026-12-01", ownerMsg: "thr_owner#9", state: "open" } });
    await expect(api.defer({ what: "dfr_nothing", ownerMsg: "thr_owner#9" })).rejects.toThrow(/no deferral/);
    api.close({ id: entry.id, evidence: "commit abc1234 runs the scenario" });
    await expect(api.defer({ what: entry.id, ownerMsg: "thr_owner#9" })).rejects.toThrow(/is closed/);
  });

  it("keeps the earlier term in the history of the entry", async () => {
    const { api, db } = register();
    const { entry } = await api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#3" });
    await api.defer({ what: entry.id, ownerMsg: "thr_owner#9" });
    const row = db.prepare("SELECT history_json FROM lane_pilot_deferral WHERE id=?").get(entry.id) as { history_json: string };
    expect(JSON.parse(row.history_json)).toEqual([expect.objectContaining({ dueSource: "explicit", ownerRef: expect.objectContaining({ seq: 3 }) })]);
  });
});

describe("the term passes and the entry is closed", () => {
  it("turns overdue by the clock, and closing with evidence turns it off", async () => {
    const { api, clock } = register();
    const { entry } = await api.defer({ what: "reload drill", kind: "drill_scenario", ownerMsg: "thr_owner#3" });
    expect(api.list().overdue).toEqual([]);
    clock.now = Date.parse("2026-11-06T00:00:01Z");
    const late = api.list();
    expect(late.overdue.map((item) => item.id)).toEqual([entry.id]);
    expect(late.counts).toMatchObject({ overdue: 1, open: 0 });
    expect(() => api.close({ id: entry.id, evidence: "ok" })).toThrow(/must say what closes it/);
    const closed = api.close({ id: entry.id, evidence: "run lprun_1 passed the reload scenario" });
    expect(closed).toMatchObject({ state: "closed", closedBy: "run lprun_1 passed the reload scenario" });
    expect(api.list().overdue).toEqual([]);
    expect(() => api.close({ id: entry.id, evidence: "once more, please" })).toThrow(/already closed/);
  });

  it("a new owner message after the term brings a late entry back to open", async () => {
    const { api, clock } = register();
    const { entry } = await api.defer({ what: "x", kind: "gate", ownerMsg: "thr_owner#3" });
    clock.now = Date.parse("2026-11-20T00:00:00Z");
    expect(api.list().overdue).toHaveLength(1);
    clock.now = Date.parse("2026-11-26T00:00:00Z");
    await api.defer({ what: entry.id, ownerMsg: "thr_owner#9" });
    expect(api.list().overdue).toHaveLength(0);
  });

  it("a project sees its own entries and the global ones", async () => {
    const { api } = register();
    await api.defer({ what: "mine", kind: "gate", ownerMsg: "thr_owner#3", projectId: "proj_a" });
    await api.defer({ what: "theirs", kind: "gate", ownerMsg: "thr_owner#3", projectId: "proj_b" });
    await api.defer({ what: "global", kind: "gate", ownerMsg: "thr_owner#3" });
    expect(api.list({ projectId: "proj_a" }).entries.map((item) => item.what).sort()).toEqual(["global", "mine"]);
  });
});

describe("first entries", () => {
  it("are seeded as needs_owner_term, once, and are never counted overdue", () => {
    const { api, clock } = register();
    expect(api.seed()).toBe(SEED_ENTRIES.length);
    expect(api.seed()).toBe(0);
    clock.now = T0 + 400 * DAY;
    const listed = api.list();
    expect(listed.counts).toMatchObject({ needs_owner_term: SEED_ENTRIES.length, overdue: 0, open: 0 });
    expect(listed.overdue).toEqual([]);
    expect(listed.needsOwnerTerm.map((item) => item.id)).toContain("dfr_seed_plan_code_critique_default");
    expect(SEED_ENTRIES.filter((item) => item.kind === "plan_decision")).toHaveLength(5);
  });

  it("a seeded entry gets its term from the owner like any other, and a restart does not reset it", async () => {
    const { api } = register();
    api.seed();
    const moved = await api.defer({ what: "dfr_seed_plan_containment", ownerMsg: "thr_owner#3" });
    expect(moved.entry).toMatchObject({ state: "open", due: "2026-11-05" });
    api.seed();
    expect(api.list({ state: "open" } as never).entries.map((item) => item.id)).toEqual(["dfr_seed_plan_containment"]);
  });

  it("names cited ids the register lacks or holds closed", async () => {
    const { api } = register();
    api.seed();
    api.close({ id: "dfr_seed_skip_guard", evidence: "the upstream fixture is in the repo now" });
    expect(api.list({ refs: ["dfr_seed_skip_pipeline", "dfr_seed_skip_guard", "dfr_000000000000"] }).badRefs)
      .toEqual([{ id: "dfr_seed_skip_guard", problem: "closed" }, { id: "dfr_000000000000", problem: "unknown" }]);
  });
});

describe("the CLI", () => {
  it("defer, deferrals and defer-close, with flags in both forms and the usage on a mistake", async () => {
    const { api } = register();
    const made = await runDeferralCli(api, "defer", ["reload", "drill", "--kind", "drill_scenario", "--owner-msg=thr_owner#3", "--area", "drill"]);
    expect(made.exitCode).toBe(0);
    const id = (JSON.parse(made.stdout!) as { entry: { id: string; what: string } }).entry.id;
    expect(JSON.parse(made.stdout!).entry.what).toBe("reload drill");
    const listed = JSON.parse((await runDeferralCli(api, "deferrals", [])).stdout!) as { entries: Array<{ id: string }> };
    expect(listed.entries.map((item) => item.id)).toEqual([id]);
    expect((await runDeferralCli(api, "defer", ["x", "--kind", "gate"])).stderr).toMatch(/comes from the owner's message/);
    expect((await runDeferralCli(api, "defer", ["x", "--kind", "gate", "--owner-msg", "thr_owner#6"])).stderr).toMatch(/not a message the owner wrote/);
    expect((await runDeferralCli(api, "defer", ["x", "--bogus", "1"])).stderr).toMatch(/unknown flag --bogus/);
    expect((await runDeferralCli(api, "defer-close", [id])).exitCode).toBe(1);
    expect(JSON.parse((await runDeferralCli(api, "defer-close", [id, "--evidence", "commit 1234567 adds it"])).stdout!)).toMatchObject({ id, state: "closed" });
  });
});

describe("the plugin", () => {
  it("keeps the register migrations last, seeds on start and serves the three RPCs through the SDK", async () => {
    // The register's two statements sit together at the end; the bench's tables (src/rooms/bench) come after them.
    const at = migrations.findIndex((statement) => /CREATE TABLE lane_pilot_deferral/.test(statement));
    expect(at).toBeGreaterThan(0);
    expect(migrations[at + 1]).toMatch(/CREATE INDEX lane_pilot_deferral_state/);
    expect(migrations.slice(at + 2).every((statement) => /lane_pilot_bench_/.test(statement))).toBe(true);

    const threadEvents: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_a", createdAt: T0 - DAY }) as never,
          events: {
            list: async (query: Record<string, unknown>) => {
              threadEvents.push(query);
              return [{ seq: 12, type: "client/turn/requested", createdAt: T0, data: { initiator: "user", inputGroups: [[{ type: "text", text: "это откладываем до 7 ноября" }]] } }] as never;
            },
          },
        },
      } as never,
    });
    await plugin(bb);
    const before = await harness.behavior.callRpc("deferral_list", {}) as { counts: { needs_owner_term: number } };
    expect(before.counts.needs_owner_term).toBe(SEED_ENTRIES.length);

    const made = await harness.behavior.callRpc("deferral_defer", { what: "flaky gate", kind: "gate", ownerMsg: "thr_x#12", due: "2026-11-07" }) as { entry: { id: string; due: string } };
    expect(made.entry.due).toBe("2026-11-07");
    expect(threadEvents[0]).toMatchObject({ threadId: "thr_x", types: ["client/turn/requested"], afterSeq: "11", order: "asc" });
    await expect(harness.behavior.callRpc("deferral_defer", { what: "flaky gate 2", kind: "gate", ownerMsg: "thr_x#12", due: "2026-11-30" })).rejects.toThrow(/does not name 2026-11-30/);
    const closed = await harness.behavior.callRpc("deferral_close", { id: made.entry.id, evidence: "gate rewritten in commit 7654321" }) as { state: string };
    expect(closed.state).toBe("closed");
    await harness.lifecycle.dispose();
  });
});
