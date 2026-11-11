import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { type CfBatch, cfBatchSchema, validateCfBatchPreFlight } from "../../src/rooms/specialist";
import { checkLockCollisions, recordCfFeedback, stageAndDispatchCfBatch } from "../../src/rooms/specialist/server";

function freshDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("Content Factory Bridge v1 (lp.cf-batch/1, SEO G-1..G-W, Organic G-O1..G-O5, Canary G-15)", () => {
  it("validates SEO BOFU pre-flight gates (SERP overlap, >=3 verified facts, sibling cosine <0.72, draft-only, wave cap)", () => {
    const badBatch = cfBatchSchema.parse({
      schema: "lp.cf-batch/1",
      batch_id: "cfb_seo_bad_1",
      domain: "seo",
      batch_kind: "seo_bofu",
      wave: "canary_10",
      cf_group_slug: "bofu-comparisons",
      scenario_id: "bofu-publish-live",
      scenario_has_publish_step: true,
      seo_items: [
        {
          id: "p1",
          slug: "a-vs-b",
          target_url: "https://example.ru/compare/a-vs-b",
          primary_query: "a или b сравнение",
          cluster: "comparisons",
          page_type: "comparison",
          information_gain_proof: {
            serp_overlap: 0.55, // >= 0.40 -> G-4
            unique_verified_facts: 2, // < 3 -> G-5
            fact_sources: ["brandcore"],
            cosine_max_sibling: 0.81, // >= 0.72 -> G-6
          },
        },
      ],
    });

    const res = validateCfBatchPreFlight(badBatch);
    expect(res.ok).toBe(false);
    const gateCodes = res.failed_gates.map((g) => g.gate);
    expect(gateCodes).toEqual(
      expect.arrayContaining([
        "G-2_draft_only_scenario",
        "G-4_serp_overlap",
        "G-5_verified_facts",
        "G-6_sibling_cosine",
      ]),
    );
  });

  it("enforces G-15 canary progression (canary_10 -> wave_50 -> full), freezes when 14d indexation < 0.65, and acquires G-09 locks", () => {
    const db = freshDb();
    const now = 1_760_000_000_000;

    const makeSeoBatch = (batchId: string, wave: "canary_10" | "wave_50" | "full", slugSuffix: string): CfBatch =>
      cfBatchSchema.parse({
        schema: "lp.cf-batch/1",
        batch_id: batchId,
        domain: "seo",
        batch_kind: "seo_bofu",
        wave,
        cf_group_slug: "bofu-comparisons",
        scenario_id: "draft-review-only",
        scenario_has_publish_step: false,
        seo_items: [
          {
            id: `seo_${slugSuffix}`,
            slug: `crm-vs-erp-${slugSuffix}`,
            target_url: `https://example.ru/compare/crm-vs-erp-${slugSuffix}`,
            primary_query: `crm или erp ${slugSuffix}`,
            cluster: "bofu",
            page_type: "comparison",
            information_gain_proof: {
              serp_overlap: 0.2,
              unique_verified_facts: 5,
              fact_sources: ["pricing_table", "api_docs", "sla_contract"],
              cosine_max_sibling: 0.42,
            },
          },
        ],
      });

    // Attempting wave_50 before canary_10 completes is blocked by G-15
    const prematureWave50 = stageAndDispatchCfBatch(db, {
      projectId: "p1",
      rawBatch: makeSeoBatch("cfb_premature_50", "wave_50", "w50a"),
      nowMs: now,
    });
    expect(prematureWave50.ok).toBe(false);
    expect(prematureWave50.failedGates.some((g) => g.gate === "G-15_canary_prerequisite")).toBe(true);

    // Stage canary_10 with mock CLI runner -> canary_running, and verify idempotent replay
    const canary = stageAndDispatchCfBatch(db, {
      projectId: "p1",
      rawBatch: makeSeoBatch("cfb_canary_1", "canary_10", "c1"),
      executeCli: (args) => {
        if (args[1] === "scenario") return { exitCode: 0, stdout: '{"steps":[{"kind":"draft"}]}', stderr: "" };
        return { exitCode: 0, stdout: "Started run cfr_live_001", stderr: "" };
      },
      nowMs: now + 1_000,
    });
    expect(canary).toMatchObject({ ok: true, replayed: false, status: "canary_running", cfRunId: "cfr_live_001" });

    const replay = stageAndDispatchCfBatch(db, {
      projectId: "p1",
      rawBatch: makeSeoBatch("cfb_canary_1", "canary_10", "c1"),
      nowMs: now + 2_000,
    });
    expect(replay).toMatchObject({ ok: true, replayed: true, batchId: "cfb_canary_1", cfRunId: "cfr_live_001" });

    // Record low indexation (< 0.65) -> freezes canary and blocks wave_50
    const lowFb = recordCfFeedback(db, {
      projectId: "p1",
      batchId: "cfb_canary_1",
      status: "completed",
      indexationRate14d: 0.45,
      publishedUrls: ["https://example.ru/compare/crm-vs-erp-c1"],
      lockDays: 28,
      nowMs: now + 3_000,
    });
    expect(lowFb).toEqual({ updated: true, locksAcquired: 1, frozen: true });
    expect(checkLockCollisions(db, { projectId: "p1", scopeType: "url", scopeValue: "https://example.ru/compare/crm-vs-erp-c1", nowMs: now + 4_000 })).toHaveLength(1);

    // Healthy canary_10 with 0.80 indexation unlocks wave_50
    stageAndDispatchCfBatch(db, {
      projectId: "p1",
      rawBatch: makeSeoBatch("cfb_canary_2", "canary_10", "c2"),
      nowMs: now + 5_000,
    });
    recordCfFeedback(db, {
      projectId: "p1",
      batchId: "cfb_canary_2",
      status: "completed",
      indexationRate14d: 0.8,
      nowMs: now + 6_000,
    });

    const unlockedWave50 = stageAndDispatchCfBatch(db, {
      projectId: "p1",
      rawBatch: makeSeoBatch("cfb_wave_50_ok", "wave_50", "w50b"),
      nowMs: now + 7_000,
    });
    expect(unlockedWave50.ok).toBe(true);
    expect(unlockedWave50.status).toBe("staged");
  });

  it("runs the real Python audit_organic_pack.py linter (G-O5) on multi-channel organic packs: passes clean packs and blocks clickbait", () => {
    const db = freshDb();

    const cleanOrganicBatch = {
      schema: "lp.cf-batch/1",
      batch_id: "cfb_org_clean_1",
      domain: "marketing",
      batch_kind: "organic_multi",
      wave: "canary_10",
      cf_group_slug: "organic-spring26",
      scenario_id: "organic-drafts",
      scenario_has_publish_step: false,
      organic_items: [
        {
          id: "dz-1",
          kind: "organic",
          channel: "dzen_article",
          slug: "rassada-svet-i-teplo",
          title: "Почему рассада вытягивается на подоконнике и как это исправить за неделю",
          utm_campaign: "spring26",
          payload: {
            lead:
              "Рассада томатов вытягивается не из-за сорта, а из-за света и тепла. Я три сезона теряла по половине ящиков, пока не замерила освещённость люксметром. Ниже простая схема, которая исправляет вытягивание за неделю.",
            body:
              "## Где ошибка\n" +
              "Свет и тепло работают в паре. ".repeat(40) +
              "\n\n## Что сделать за неделю\n" +
              "Снизьте температуру ночью. ".repeat(40) +
              "\n\nПодробная таблица в канале: https://t.me/ogorod_channel",
          },
        },
        {
          id: "pin-1",
          kind: "organic",
          channel: "pinterest_pin",
          slug: "pin-rassada-podsvetka",
          title: "Рассада томатов: схема подсветки на подоконнике",
          target_url: "https://ogorod.example/rassada?utm_source=pinterest&utm_medium=organic&utm_campaign=spring26",
          utm_campaign: "spring26",
          payload: {
            keywords: ["рассада томатов", "подсветка рассады"],
            overlay_text: "Рассада не вытянется",
            description:
              "Рассада томатов без вытягивания: подсветка рассады 14 часов, ночная температура 16 градусов и полив по сухому верхнему слою. Схема для подоконника и балкона.",
            image: { width: 1000, height: 1500 },
            board: { name: "Рассада томатов и перцев", keywords: ["рассада"] },
            publish_date: "2026-03-02",
          },
        },
        {
          id: "rl-1",
          kind: "organic",
          channel: "reels_script",
          slug: "reels-rassada-svet",
          title: "Рассада вытягивается не от сорта",
          utm_campaign: "spring26",
          payload: {
            duration_sec: 17,
            hook: "Рассада вытягивается не от сорта. Почему?",
            script:
              "Рассада вытягивается не от сорта. Почему? Ей не хватает света, а тепла слишком много. Поставьте лампу на двадцать сантиметров выше листьев и опустите ночью температуру до шестнадцати градусов. Через неделю рассада перестанет вытягиваться и станет крепкой. Подпишитесь, здесь про огород без ошибок.",
          },
        },
        {
          id: "bf-1",
          kind: "organic",
          channel: "blog_funnel_post",
          slug: "case-40-kustov",
          title: "Кейс: 40 крепких кустов без вытягивания",
          utm_campaign: "spring26",
          payload: {
            funnel: { step: "convert", bridge: { type: "codeword", target: "РАССАДА" } },
            text:
              "Клиентка пришла с проблемой: рассада падала каждый год. Мы с ней разобрали свет и полив, настроили лампу. Результат: 40 крепких кустов. Хотите так же — напишите в директ кодовое слово РАССАДА.",
          },
        },
      ],
    };

    const okRes = stageAndDispatchCfBatch(db, { projectId: "p1", rawBatch: cleanOrganicBatch });
    expect(okRes.ok).toBe(true);
    expect(okRes.organicAuditScore).toBeGreaterThanOrEqual(80);
    const storedUnits = db.prepare("SELECT channel, status FROM lane_pilot_sp_organic_unit WHERE batch_id = ?").all("cfb_org_clean_1");
    expect(storedUnits).toHaveLength(4);

    // Dirty Dzen clickbait article ("ШОК! Вы не поверите!") is blocked by audit_organic_pack.py (G-O5_dz_clickbait_ban)
    const clickbaitBatch = {
      ...cleanOrganicBatch,
      batch_id: "cfb_org_clickbait_1",
      organic_items: [
        {
          ...cleanOrganicBatch.organic_items[0]!,
          slug: "clickbait-dzen",
          title: "ШОК! Вы не поверите, врачи молчат про эту рассаду только сегодня",
        },
      ],
    };
    const badRes = stageAndDispatchCfBatch(db, { projectId: "p1", rawBatch: clickbaitBatch });
    expect(badRes.ok).toBe(false);
    expect(badRes.status).toBe("blocked");
    expect(badRes.failedGates.some((g) => g.gate === "G-O5_dz_clickbait_ban")).toBe(true);
  });
});
