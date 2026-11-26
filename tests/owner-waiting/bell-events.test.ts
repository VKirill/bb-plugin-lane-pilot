import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { WorkflowEngine, hasParkedWorkflowWait, parseWorkflow } from "@lane-pilot/workflow-engine";
import { readFileSync } from "node:fs";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { openDatabase } from "../../src/rooms/plugin-db";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import {
  bellPushedToday,
  mountOwnerBell,
  OWNER_BELL_DAILY_CAP,
  quietHoursEnd,
} from "../../src/rooms/owner-waiting/server";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import type { Services } from "../../src/rooms/services";
import type { StoredWorkflow, WorkflowStore } from "../../src/rooms/storage";

const bellWorkflow = parseWorkflow(
  JSON.parse(readFileSync(new URL("../../workflows/lp.owner-bell.json", import.meta.url), "utf8")),
);

const storedBell: StoredWorkflow = {
  workflow: bellWorkflow,
  origin: "builtin",
  source: "workflows/lp.owner-bell.json",
  sha256: "test-owner-bell",
  warnings: [],
};

const storeOf = (item: StoredWorkflow): WorkflowStore => ({
  list: () => [item],
  get: (id) => (id === item.workflow.id ? item : null),
  resolve: (id) => (id === item.workflow.id ? item.workflow : null),
  problems: [],
});

async function flushAsync(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeHarness(initialNow: number) {
  let clock = initialNow;
  const sent: Array<{ title: string; text: string }> = [];
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      plugins: {
        callRpc: vi.fn(async ({ method, input }: { pluginId: string; method: string; input?: unknown }) => {
          if (method === "notifications.send") sent.push(input as { title: string; text: string });
          return { ok: true };
        }),
      },
    },
  });
  const db = openDatabase(bb);

  const logs: string[] = [];
  function boot(sharedDb = db) {
    const engine = new WorkflowEngine({ db: sharedDb, harnessVersion: "1.0.0", now: () => clock });
    const ctx = {
      bb,
      db: sharedDb,
      isDisposed: () => false,
      effectiveProjectSettings: async () => ({ values: {} }),
      log: (msg: string) => logs.push(msg),
    } as unknown as ServerCore;
    const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
      loadStore: async () => ({ store: storeOf(storedBell), project: "ok" }),
    });
    const unsub = mountOwnerBell(ctx, [], { engine, emitEvent: triggers.emitEvent });
    return { engine, ctx, triggers, unsub };
  }

  return {
    db,
    sent,
    logs,
    getNow: () => clock,
    setNow: (ms: number) => {
      clock = ms;
    },
    boot,
  };
}

function addWakeItem(db: ReturnType<typeof openDatabase>, key: string, what: string, now: number) {
  return postOwnerItem(
    db,
    { key, source: "night", kind: "decision", what, why: "нужен ответ владельца", reason: "decision", wake: true },
    now,
  );
}

describe("owner bell event graph (lp.owner-bell)", () => {
  it("triggers on lp.owner.item-created for new wake items and seeds startup items without bursting or spending today's cap", async () => {
    const t0 = Date.parse("2026-11-24T10:00:00.000Z"); // 11:00 Europe/Madrid (outside quiet hours)
    const h = makeHarness(t0);
    // Pre-existing open wake item before startup
    addWakeItem(h.db, "pre-existing-1", "Старый вопрос до запуска", t0 - 60_000);

    const { unsub } = h.boot();
    expect(h.sent).toHaveLength(0);
    expect(bellPushedToday(h.db, t0, "Europe/Madrid")).toBe(0);

    // Posting a brand-new wake item fires LP_EVENTS.OWNER_ITEM_CREATED -> lp.owner-bell sends immediately
    expect(LP_EVENTS.OWNER_ITEM_CREATED).toBe("lp.owner.item-created");
    const created = addWakeItem(h.db, "fresh-1", "Новый вопрос 1", t0);
    expect(created.created).toBe(true);
    await flushAsync();

    expect(h.sent).toEqual([
      { title: "Lane Pilot: ждёт решения — 1", text: "1 — на экране «Ждут владельца»." },
    ]);
    expect(bellPushedToday(h.db, t0, "Europe/Madrid")).toBe(1);

    // Re-posting the same open key does not create a change or re-notify
    const dup = addWakeItem(h.db, "fresh-1", "Новый вопрос 1", t0 + 1_000);
    expect(dup.created).toBe(false);
    await flushAsync();
    expect(h.sent).toHaveLength(1);
    unsub();
  });

  it("parks on durable builtin:wait during quiet hours and delivers across a hub restart", async () => {
    const night = Date.parse("2026-11-24T22:30:00.000Z"); // 23:30 Europe/Madrid (quiet 23:00-08:00)
    const h = makeHarness(night);
    const boot1 = h.boot();

    addWakeItem(h.db, "night-1", "Ночной вопрос 1", night);
    await flushAsync();
    expect(h.sent).toHaveLength(0);
    expect(hasParkedWorkflowWait(h.db, "lp.owner-bell")).toBe(true);

    // Second night item arrives while parked: does not send and does not open another wait run
    const night2 = night + 30 * 60_000;
    h.setNow(night2);
    addWakeItem(h.db, "night-2", "Ночной вопрос 2", night2);
    await flushAsync();
    const parkedRuns = h.db
      .prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run WHERE workflow_id='lp.owner-bell' AND status IN ('running','waiting')")
      .get() as { n: number };
    expect(parkedRuns.n).toBe(1);
    expect(h.sent).toHaveLength(0);

    // Simulate hub restart with a fresh engine on the same SQLite DB after quiet hours end (08:01 Madrid = 07:01Z)
    boot1.unsub();
    const wakeAt = quietHoursEnd(night, "23:00-08:00", "Europe/Madrid")!;
    h.setNow(wakeAt + 60_000);
    const boot2 = h.boot(h.db);
    await boot2.engine.resume();
    await flushAsync();

    expect(h.sent).toEqual([
      { title: "Lane Pilot: ждёт решения — 2", text: "2 — на экране «Ждут владельца»." },
    ]);
    expect(hasParkedWorkflowWait(h.db, "lp.owner-bell")).toBe(false);
    boot2.unsub();
  });

  it("enforces OWNER_BELL_DAILY_CAP = 5 and folds overflow items into one digest at the next digest window", async () => {
    const start = Date.parse("2026-11-24T09:30:00.000Z"); // 10:30 Europe/Madrid
    const h = makeHarness(start);
    const { engine, unsub } = h.boot();

    for (let i = 1; i <= OWNER_BELL_DAILY_CAP; i += 1) {
      const ts = start + i * 60_000;
      h.setNow(ts);
      addWakeItem(h.db, `cap-${i}`, `Вопрос ${i}`, ts);
      await flushAsync();
    }
    expect(h.sent).toHaveLength(OWNER_BELL_DAILY_CAP);
    expect(bellPushedToday(h.db, h.getNow(), "Europe/Madrid")).toBe(OWNER_BELL_DAILY_CAP);

    // Items 6, 7, 8 exceed the daily cap -> deferred cleanly behind a single parked wait
    for (let i = 6; i <= 8; i += 1) {
      const ts = start + i * 60_000;
      h.setNow(ts);
      addWakeItem(h.db, `cap-${i}`, `Сверхурочный вопрос ${i}`, ts);
      await flushAsync();
    }
    expect(h.sent).toHaveLength(OWNER_BELL_DAILY_CAP);
    expect(hasParkedWorkflowWait(h.db, "lp.owner-bell")).toBe(true);

    // Advance to next morning digest window (09:01 Madrid = 08:01Z on 2026-11-25) -> 1 digest notification for all 3 overflow items
    const nextDigest = Date.parse("2026-11-25T08:01:00.000Z");
    h.setNow(nextDigest);
    await engine.resume();
    await flushAsync();

    expect(h.sent).toHaveLength(OWNER_BELL_DAILY_CAP + 1);
    expect(h.sent.at(-1)).toEqual({
      title: "Lane Pilot: ждёт решения — 3",
      text: "3 — на экране «Ждут владельца».",
    });
    expect(hasParkedWorkflowWait(h.db, "lp.owner-bell")).toBe(false);
    unsub();
  });
});
