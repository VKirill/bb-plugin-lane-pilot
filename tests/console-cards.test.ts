import { defineRpcContract } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcConsole } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { rpcContract } from "../src/rooms/core/server/plugin-contracts";
import { registerRpc } from "../src/rooms/core/server/rpc";
import { cardsRpc, setCard, verifyCard } from "../src/rooms/memory/server";
import { openDatabase } from "../src/rooms/plugin-db";
import type { Services } from "../src/rooms/services";

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function fakeServices(): Services {
  return new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => undefined }) }) as unknown as Services;
}

describe("memory_cards_list", () => {
  it("excludes superseded cards, marks past-TTL cards stale, tracks versions, and returns empty for unknown project with no logs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const oldCard = setCard(ctx, {
      projectId: "proj-1",
      kind: "brand",
      key: "voice",
      content: "Old brand voice",
      source: { kind: "owner", ref: "doc/v1.md" },
      ttlDays: 30,
      now: T0,
    });
    // Supersede oldCard directly so only two card rows exist in the DB (one superseded, one past TTL).
    db.prepare("UPDATE lane_pilot_memory SET status='superseded', superseded_by='next' WHERE id=?").run(oldCard.id);

    const expiredCard = setCard(ctx, {
      projectId: "proj-1",
      kind: "platform",
      key: "telegram",
      content: "Telegram limit 4096 chars.\nDetails below.",
      source: { kind: "url", ref: "https://core.telegram.org/bots/api" },
      ttlDays: 5,
      now: T0,
    });

    const infoSpy = vi.spyOn(bb.log, "info");
    const warnSpy = vi.spyOn(bb.log, "warn");
    const debugSpy = vi.spyOn(bb.log, "debug");

    const nowAfterTtl = T0 + 10 * DAY_MS;
    const rpc = cardsRpc(ctx, { now: () => nowAfterTtl });

    const out = await rpc.memory_cards_list({ projectId: "proj-1" });
    expect(rpcConsole.memory_cards_list.output.safeParse(out).success).toBe(true);
    expect(out.cards).toEqual([
      {
        id: expiredCard.id,
        kind: "platform",
        title: "Telegram limit 4096 chars.",
        concepts: ["card:platform:telegram", "card"],
        verifiedAt: T0,
        ttlDays: 5,
        stale: true,
        ref: "https://core.telegram.org/bots/api",
        version: 1,
      },
    ]);

    // Unknown project returns empty list and never logs on reads.
    const unknownOut = await rpc.memory_cards_list({ projectId: "unknown-proj" });
    expect(unknownOut).toEqual({ cards: [] });
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("includes section-scoped cards for the project, filters by kind, updates version/stale on verify, and wires into registerRpc", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const nicheCard = setCard(ctx, {
      projectId: "proj-2",
      kind: "niche",
      key: "dach",
      content: "DACH enterprise compliance",
      source: { kind: "file", ref: "docs/dach.md" },
      ttlDays: 10,
      now: T0,
    });
    // Tag the card row with a section scope to confirm project scope chain includes section cards.
    db.prepare("UPDATE lane_pilot_memory SET scope_json=? WHERE id=?").run(JSON.stringify(["section:sec-1"]), nicheCard.id);

    const brandCard = setCard(ctx, {
      projectId: "proj-2",
      kind: "brand",
      key: "tone",
      content: "Calm and factual",
      source: { kind: "owner", ref: "" },
      ttlDays: 30,
      now: T0,
    });

    verifyCard(ctx, {
      cardId: nicheCard.id,
      by: "owner",
      ttlDays: 30,
      now: T0 + 11 * DAY_MS,
    });

    // Global card must stay excluded from project-scoped listing.
    setCard(ctx, {
      projectId: null,
      kind: "contact",
      key: "ops",
      content: "Ops email ops@example.com",
      source: { kind: "owner", ref: "handbook" },
      now: T0,
    });

    const rpc = cardsRpc(ctx, { now: () => T0 + 12 * DAY_MS });
    const allProject = await rpc.memory_cards_list({ projectId: "proj-2" });
    expect(allProject.cards).toHaveLength(2);
    expect(allProject.cards.find((c) => c.id === nicheCard.id)).toMatchObject({
      kind: "niche",
      stale: false,
      version: 2,
      ttlDays: 30,
      ref: "docs/dach.md",
    });
    expect(allProject.cards.find((c) => c.id === brandCard.id)).toMatchObject({
      kind: "brand",
      stale: false,
      version: 1,
      ttlDays: 30,
      ref: null,
    });

    const onlyNiche = await rpc.memory_cards_list({ projectId: "proj-2", kind: "niche" });
    expect(onlyNiche.cards.map((c) => c.id)).toEqual([nicheCard.id]);

    // Verify registerRpc wires memory_cards_list through src/rooms/core/server/rpc.ts.
    const contractWithCards = defineRpcContract({
      ...rpcContract,
      memory_cards_list: rpcConsole.memory_cards_list,
    });
    registerRpc(ctx, fakeServices(), contractWithCards as never);
    const viaHost = (await harness.behavior.callRpc("memory_cards_list", { projectId: "proj-2", kind: "brand" })) as {
      cards: Array<{ id: string }>;
    };
    expect(viaHost.cards.map((c) => c.id)).toEqual([brandCard.id]);
  });
});
