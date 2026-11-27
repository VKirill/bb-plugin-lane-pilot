import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CARD_LIMITS, cardConcept } from "../../packages/contracts/src";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { getCard, listCards, setCard, verifyCard } from "../../src/rooms/memory/server";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/services";
import { registerCli } from "../../src/rooms/tools/server";

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const infos: string[] = [];
  const warns: string[] = [];
  const ctx = {
    db,
    bb: {
      ...bb,
      log: {
        ...bb.log,
        info: (msg: string) => {
          infos.push(msg);
        },
        warn: (msg: string) => {
          warns.push(msg);
        },
      },
    },
  };
  return { db, bb, ctx, infos, warns };
}

describe("knowledge cards in hub memory", () => {
  const disposes: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (disposes.length) await disposes.pop()?.();
  });

  it("sets a card as a typed memory note and retrieves verifiedAt, validUntil, source, and trust", () => {
    const { db, ctx, infos } = setup();
    const content = "B2B SaaS buyers in DACH value ISO-27001 compliance over price.";
    const created = setCard(ctx, {
      projectId: "proj-1",
      kind: "niche",
      key: "DACH-SaaS",
      content,
      source: { kind: "owner", ref: "interview-2026" },
      now: T0,
    });

    expect(created).toMatchObject({
      projectId: "proj-1",
      kind: "niche",
      key: "dach-saas",
      content,
      verifiedAt: T0,
      source: { kind: "owner", ref: "interview-2026" },
      validUntil: T0 + CARD_LIMITS.defaultTtlDays.niche * DAY_MS,
      trust: "confirmed",
      stale: false,
    });

    const fetched = getCard(ctx, { projectId: "proj-1", kind: "niche", key: "dach-saas", now: T0 + 1000 });
    expect(fetched).toEqual(created);

    const byId = getCard(ctx, { cardId: created.id, now: T0 + 1000 });
    expect(byId).toEqual(created);

    const row = db
      .prepare("SELECT kind, concepts_json, trust, origin, valid_until, verification_json FROM lane_pilot_memory WHERE id=?")
      .get(created.id) as {
      kind: string;
      concepts_json: string;
      trust: string;
      origin: string;
      valid_until: number;
      verification_json: string;
    };
    expect(row.kind).toBe("note");
    expect(JSON.parse(row.concepts_json)).toEqual([cardConcept("niche", "dach-saas"), "card"]);
    expect(row.trust).toBe("confirmed");
    expect(row.origin).toBe("card");
    expect(row.valid_until).toBe(T0 + 90 * DAY_MS);
    const verification = JSON.parse(row.verification_json) as Array<{ by: string; sha: string; at: number; ref?: string }>;
    expect(verification).toHaveLength(1);
    expect(verification[0]).toMatchObject({ by: "owner", at: T0, ref: "interview-2026" });

    expect(infos).toContain("card set kind=niche key=dach-saas project=proj-1 trust=confirmed");
    expect(infos.join("\n")).not.toContain("ISO-27001");
  });

  it("supersedes an existing card with the same concept on a second set (including observed sources and identical content)", () => {
    const { db, ctx } = setup();
    const first = setCard(ctx, {
      projectId: "proj-1",
      kind: "brand",
      key: "voice",
      content: "Direct, calm, zero hype.",
      source: { kind: "url", ref: "https://example.com/brand-v1" },
      now: T0,
    });
    expect(first.trust).toBe("observed");

    const second = setCard(ctx, {
      projectId: "proj-1",
      kind: "brand",
      key: "voice",
      content: "Direct, calm, zero hype and concrete numbers.",
      source: { kind: "url", ref: "https://example.com/brand-v2" },
      now: T0 + 5_000,
    });

    const firstRow = db
      .prepare("SELECT status, superseded_by FROM lane_pilot_memory WHERE id=?")
      .get(first.id) as { status: string; superseded_by: string | null };
    expect(firstRow).toEqual({ status: "superseded", superseded_by: second.id });
    expect(db.prepare("SELECT id FROM lane_pilot_memory_fts WHERE id=?").get(first.id)).toBeUndefined();
    expect(getCard(ctx, { cardId: first.id })).toBeNull();
    expect(getCard(ctx, { projectId: "proj-1", kind: "brand", key: "voice" })?.id).toBe(second.id);

    const third = setCard(ctx, {
      projectId: "proj-1",
      kind: "brand",
      key: "voice",
      content: "Direct, calm, zero hype and concrete numbers.",
      source: { kind: "owner", ref: "owner-confirm" },
      now: T0 + 10_000,
    });
    expect(third.id).not.toBe(second.id);
    expect(third.trust).toBe("confirmed");
    expect(listCards(ctx, { projectId: "proj-1", kind: "brand" }).map((c) => c.id)).toEqual([third.id]);
  });

  it("marks URL and run sources as observed, and promotes to confirmed only on owner verify while extending validity", () => {
    const { db, ctx } = setup();
    const fromUrl = setCard(ctx, {
      projectId: "proj-1",
      kind: "platform",
      key: "instagram",
      content: "Reels under 45s perform best with captions.",
      source: { kind: "url", ref: "https://help.instagram.com/reels" },
      now: T0,
    });
    expect(fromUrl.trust).toBe("observed");

    const fromRun = setCard(ctx, {
      projectId: "proj-1",
      kind: "contact",
      key: "support",
      content: "Support replies within 24h at support@example.com.",
      source: { kind: "run", ref: "wfrun_123" },
      now: T0,
    });
    expect(fromRun.trust).toBe("observed");

    // Non-owner verify appends entry and extends validity, but never promotes observed -> confirmed.
    const runVerified = verifyCard(ctx, { cardId: fromUrl.id, by: "run", now: T0 + 2 * DAY_MS });
    expect(runVerified.trust).toBe("observed");
    expect(runVerified.verifiedAt).toBe(T0 + 2 * DAY_MS);
    expect(runVerified.validUntil).toBeGreaterThan(fromUrl.validUntil);

    // Owner verify extends validity and promotes observed -> confirmed.
    const ownerVerified = verifyCard(ctx, { cardId: fromUrl.id, by: "owner", now: T0 + 3 * DAY_MS });
    expect(ownerVerified.trust).toBe("confirmed");
    expect(ownerVerified.verifiedAt).toBe(T0 + 3 * DAY_MS);
    expect(ownerVerified.validUntil).toBeGreaterThan(runVerified.validUntil);
    expect(ownerVerified.source).toEqual({ kind: "url", ref: "https://help.instagram.com/reels" });

    const row = db
      .prepare("SELECT verification_json FROM lane_pilot_memory WHERE id=?")
      .get(fromUrl.id) as { verification_json: string };
    expect(JSON.parse(row.verification_json)).toHaveLength(3);
  });

  it("supports global cards, project scoping, and surfaces expired cards as stale until verified", () => {
    const { ctx } = setup();
    const globalCard = setCard(ctx, {
      projectId: null,
      kind: "platform",
      key: "telegram",
      content: "Telegram channel posts support up to 4096 chars.",
      source: { kind: "owner", ref: "manual" },
      ttlDays: 10,
      now: T0,
    });
    const projectCard = setCard(ctx, {
      projectId: "proj-a",
      kind: "niche",
      key: "legal",
      content: "Contract review requires jurisdiction tag.",
      source: { kind: "file", ref: "docs/legal.md" },
      now: T0,
    });

    expect(globalCard.projectId).toBeNull();
    expect(listCards(ctx, { projectId: null, now: T0 })).toEqual([globalCard]);
    expect(listCards(ctx, { projectId: "proj-a", now: T0 })).toEqual([projectCard]);
    expect(listCards(ctx, { projectId: "proj-a", includeGlobal: true, now: T0 }).map((c) => c.id).sort()).toEqual(
      [globalCard.id, projectCard.id].sort(),
    );

    const afterExpiry = T0 + 11 * DAY_MS;
    const stale = getCard(ctx, { projectId: null, kind: "platform", key: "telegram", now: afterExpiry });
    expect(stale?.stale).toBe(true);
    expect(listCards(ctx, { projectId: null, now: afterExpiry })[0]?.stale).toBe(true);

    const renewed = verifyCard(ctx, { cardId: globalCard.id, by: "owner", ttlDays: 30, now: afterExpiry });
    expect(renewed.stale).toBe(false);
    expect(renewed.validUntil).toBe(afterExpiry + 30 * DAY_MS);
  });

  it("refuses unknown kind, empty content, oversized content, and secrets without logging content", () => {
    const { ctx, warns } = setup();

    expect(() =>
      setCard(ctx, {
        projectId: "proj-1",
        kind: "bogus" as never,
        key: "k",
        content: "hello",
        source: { kind: "owner", ref: "test" },
      }),
    ).toThrow(/unknown kind/);

    expect(() =>
      setCard(ctx, {
        projectId: "proj-1",
        kind: "brand",
        key: "k",
        content: "   ",
        source: { kind: "owner", ref: "test" },
      }),
    ).toThrow(/empty content/);

    const huge = "x".repeat(CARD_LIMITS.chars * 4 + 1);
    expect(() =>
      setCard(ctx, {
        projectId: "proj-1",
        kind: "brand",
        key: "k",
        content: huge,
        source: { kind: "owner", ref: "test" },
      }),
    ).toThrow(/exceeds/);

    const secretText = "token ghp_" + "a".repeat(30);
    expect(() =>
      setCard(ctx, {
        projectId: "proj-1",
        kind: "brand",
        key: "k",
        content: secretText,
        source: { kind: "owner", ref: "test" },
      }),
    ).toThrow(/credential/);

    expect(warns.some((w) => w.startsWith("card refused:"))).toBe(true);
    expect(warns.join("\n")).not.toContain("ghp_");
    expect(warns.join("\n")).not.toContain("xxxx");
  });

  it("exposes PM tool lane_pilot_card and CLI bb lane-pilot card", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    disposes.push(() => harness.lifecycle.dispose());

    const pmCtx = { threadId: "pm-1", projectId: "proj-tool" };
    const setRes = JSON.parse(
      String(
        await harness.behavior.callAgentTool(
          "lane_pilot_card",
          {
            action: "set",
            kind: "brand",
            key: "acme",
            content: "Acme builds telemetry probes.",
            sourceKind: "url",
            sourceRef: "https://acme.example/about",
          },
          pmCtx,
        ),
      ),
    ) as { id: string; trust: string; kind: string; key: string };
    expect(setRes).toMatchObject({ kind: "brand", key: "acme", trust: "observed" });

    const getRes = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_card", { action: "get", kind: "brand", key: "acme" }, pmCtx)),
    ) as { card: { id: string } };
    expect(getRes.card.id).toBe(setRes.id);

    const verifyRes = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_card", { action: "verify", cardId: setRes.id }, pmCtx)),
    ) as { trust: string };
    expect(verifyRes.trust).toBe("confirmed");

    const listRes = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_card", { action: "list", kind: "brand" }, pmCtx)),
    ) as { cards: Array<{ id: string }> };
    expect(listRes.cards.map((c) => c.id)).toEqual([setRes.id]);

    // CLI verb on a fresh core instance
    const cliHost = createFakePluginHost({ pluginId: "lane-pilot" });
    const cliDb = openDatabase(cliHost.bb);
    registerCli(createCore(cliHost.bb, cliDb), {} as Services, migrations);

    const filePath = "/notes/platform.txt";
    const refused = await cliHost.harness.behavior.runCli(["card", "set", "platform", "appstore", "--file", filePath, "--project", "proj-cli"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("--text");

    const setCli = await cliHost.harness.behavior.runCli([
      "card",
      "set",
      "platform",
      "appstore",
      "--text",
      "App Store Connect rejects placeholder screenshots.",
      "--ref",
      filePath,
      "--project",
      "proj-cli",
      "--ttl-days",
      "45",
    ]);
    expect(setCli.exitCode).toBe(0);
    const cliCard = JSON.parse(setCli.stdout!) as { id: string; trust: string; source: { kind: string } };
    expect(cliCard.trust).toBe("observed");
    expect(cliCard.source.kind).toBe("file");

    const listCli = await cliHost.harness.behavior.runCli(["card", "list", "--project", "proj-cli"]);
    expect(listCli.exitCode).toBe(0);
    expect((JSON.parse(listCli.stdout!) as { cards: Array<{ id: string }> }).cards.map((c) => c.id)).toEqual([cliCard.id]);

    const verifyCli = await cliHost.harness.behavior.runCli(["card", "verify", cliCard.id]);
    expect(verifyCli.exitCode).toBe(0);
    expect((JSON.parse(verifyCli.stdout!) as { trust: string }).trust).toBe("confirmed");

    const textCli = await cliHost.harness.behavior.runCli([
      "card",
      "set",
      "contact",
      "billing",
      "--text",
      "Billing desk: billing@example.com",
      "--project",
      "proj-cli",
    ]);
    expect(textCli.exitCode).toBe(0);
    expect((JSON.parse(textCli.stdout!) as { trust: string }).trust).toBe("confirmed");
  });
});
