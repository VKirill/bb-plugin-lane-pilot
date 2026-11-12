import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "../../src/rooms/migrations";
import {
  checkPassportMarketRail,
  getPassport,
  listVerbatim,
  projectPassportBlock,
} from "../../src/rooms/passport";
import { listProjectArtifacts } from "../../src/rooms/storage";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { getBuiltinStore, setupLiveSpecialistEnv } from "../specialist/live-e2e-harness";

describe("project-passport workflow — sim matrix & live end-to-end execution (US/EN SaaS + Specialist OS feedback loop)", () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("passes all 4 simulation cases (deep_grill, express, partial, cancelled) through runDraftTest", async () => {
    const store = await getBuiltinStore();
    const wf = builtinWorkflow("project-passport")!;
    expect(wf).toBeDefined();
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations);
    try {
      const cases = testCasesOf(wf);
      expect(cases.length).toBe(4);
      for (const tc of cases) {
        const res = await runDraftTest({ db, harnessVersion: "test", resolveWorkflow: store.resolve, timeoutMs: 8000 }, wf, tc);
        expect(res.green, `${res.caseId}: ${res.failures.join("; ")}`).toBe(true);
      }
    } finally {
      harness.lifecycle.dispose();
    }
  });

  it("executes project-passport live end-to-end with real Python grill engine, writes .agents/passport/*, feeds mkt-project-intake & syncs charter/experiment feedback", async () => {
    const round1Patch = {
      identity: {
        project_name: { value: "PulseForge Dental", status: "confirmed" },
        one_liner: { value: "2-way SMS recall & waitlist backfill for US private dental clinics", status: "confirmed" },
        stage: { value: "mvp_pre_revenue", status: "confirmed" },
        product_kind: { value: "saas", status: "confirmed" },
        primary_url: { value: "https://pulseforge.dental", status: "confirmed" },
      },
      market_rails: {
        ui_locales: { value: ["en-US"], status: "confirmed" },
        content_locales: { value: ["en-US"], status: "confirmed" },
        primary_countries: { value: ["US"], status: "confirmed" },
        excluded_countries: { value: ["RU"], status: "taboo" },
        currency: { value: "USD", status: "confirmed" },
        payment_rails: { value: ["Stripe"], status: "confirmed" },
        compliance_regimes: { value: ["HIPAA", "TCPA"], status: "confirmed" },
        forbidden_channels: { value: ["yandex_direct", "vk_ads"], status: "taboo" },
      },
      positioning: {
        best_fit_icp: { value: "2-6 chair independent US dental practices on OpenDental", status: "confirmed" },
        status_quo_alternatives: { value: ["Manual front-desk phone calls", "Weave"], status: "confirmed" },
        unique_attributes: { value: ["10-minute OpenDental sync + automatic hygiene slot backfill"], status: "confirmed" },
        core_value: { value: "Recovers $2,500+/mo in cancelled hygiene chair time", status: "confirmed" },
      },
    };

    const round2Patch = {
      audience_jtbd: {
        trigger_event: { value: "Three hygiene cancellations on Monday morning leave $900 of empty chair time", status: "confirmed" },
        four_forces: {
          push: { value: "Receptionist spends 2 hours calling patients who don't pick up", status: "confirmed" },
          pull: { value: "Text-to-confirm fills the slot in 6 minutes", status: "confirmed" },
          anxiety: { value: "HIPAA BAA compliance and annoying loyal patients", status: "confirmed" },
          habit: { value: "Paper cancellation sticky notes at the front desk", status: "confirmed" },
        },
        awareness_level: { value: "problem_aware", status: "confirmed" },
      },
      messaging_voice: {
        grunt_test: { value: "Fill cancelled dental chairs automatically — synced with OpenDental in 10 minutes.", status: "confirmed" },
        tone_of_voice: { value: "Calm, clinical, trustworthy US healthcare SaaS", status: "confirmed" },
        owner_lexicon: { value: ["hygiene recall", "chair-time", "OpenDental sync"], status: "confirmed" },
        banned_words: { value: ["erid", "ИНН", "Яндекс", "magic AI"], status: "taboo" },
      },
      economics_funnel: {
        pricing_model: { value: "Flat monthly per clinic", status: "confirmed" },
        price_point: { value: "$199/mo", status: "confirmed" },
        maturity_window_days: { value: 14, status: "confirmed" },
      },
      proof_brandcore: {
        pre_launch_zero_proof: { value: true, status: "confirmed" },
        verified_facts: { value: ["Signed HIPAA BAA included on day one", "Read/write OpenDental appointment sync"], status: "confirmed" },
        forbidden_claims: { value: ["Never fabricate clinic case studies or claim ADA endorsement"], status: "taboo" },
      },
      product_design_rails: {
        core_jobs: { value: ["Connect OpenDental PMS", "Auto-text hygiene waitlist", "Book confirmed slot"], status: "confirmed" },
        devices: { value: ["Desktop receptionist monitor", "Mobile SMS"], status: "confirmed" },
        visual_references: { value: ["Stripe", "OneMedical"], status: "confirmed" },
        anti_references: { value: ["Dark neon crypto UI"], status: "taboo" },
      },
    };

    const t = await setupLiveSpecialistEnv(
      {
        round_1_questions: {
          interview_prompt: "1) Какой именно сегмент клиник в США ваш ICP и чем они пользуются сейчас? 2) Какие рынки и каналы строго исключаем?",
          focus_areas: ["positioning.best_fit_icp", "market_rails.excluded_countries"],
        },
        extract_round_1: {
          patch_json: JSON.stringify(round1Patch),
          extracted_notes: "Extracted US dental ICP, Stripe USD rails, and strict RU exclusion.",
        },
        round_2_questions: {
          interview_prompt: "1) Что является триггером покупки и чего боится владелец клиники (HIPAA)? 2) Какие заявления под запретом на пре-лонче?",
          focus_areas: ["audience_jtbd.trigger_event", "proof_brandcore.forbidden_claims"],
        },
        extract_round_2: {
          patch_json: JSON.stringify(round2Patch),
          extracted_notes: "Extracted JTBD 4 forces, HIPAA proof facts, and pre-launch taboo claims.",
        },
        synthesize: {
          briefing_md: "PulseForge Dental Passport v2 ready: US-only EN B2B SaaS ($199/mo Stripe), RU/Yandex strictly excluded.",
          recommended_workflows: ["research-dossier", "seo-project-intake", "mkt-project-intake"],
        },
      },
      {
        owner_round_1: {
          choice: "answered",
          text: "Делаем PulseForge Dental строго под рынок США на английском языке, частные стоматологии на 2-6 кресел с OpenDental. Оплата в долларах через Stripe, $199/мес. Россию и Яндекс полностью исключаем.",
        },
        owner_round_2: {
          choice: "answered",
          text: "Триггер — когда с утра отменяются 3 пациента на гигиену и кресло простаивает по $250/час. Боятся нарушить HIPAA и заспамить пациентов. Мы ещё до публичного лонча, поэтому никаких выдуманных кейсов или фейковых отзывов!",
        },
      },
    );
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("project-passport", {
      mode: "deep_grill",
      target_domain: "",
      seed_brief: "US dental recall SaaS, English-only, $199/mo",
      scope_key: "",
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(2);
    expect(summary.output).toMatchObject({
      status: "done",
      version: 2,
      passport_path: ".agents/passport/PASSPORT.json",
      brandcore_projection_path: ".agents/passport/BRANDCORE.projection.md",
      recommended_workflows: ["research-dossier", "seo-project-intake", "mkt-project-intake"],
    });
    expect(Number((summary.output as { completeness_score: number }).completeness_score)).toBeGreaterThanOrEqual(62);

    // Verify checkout artifacts on disk
    const passportJsonFile = join(t.checkout, ".agents/passport/PASSPORT.json");
    const passportMdFile = join(t.checkout, ".agents/passport/PASSPORT.md");
    const verbatimFile = join(t.checkout, ".agents/passport/VERBATIM.jsonl");
    const brandcoreFile = join(t.checkout, ".agents/passport/BRANDCORE.projection.md");
    const canonicalBrandcoreFile = join(t.checkout, ".agents/passport/BRANDCORE.md");
    const manifestFile = join(t.checkout, ".agents/manifest.json");
    const auditReportFile = join(t.checkout, ".agents/passport/reports/project-passport-grill_audit.json");

    expect(existsSync(passportJsonFile)).toBe(true);
    expect(existsSync(passportMdFile)).toBe(true);
    expect(existsSync(verbatimFile)).toBe(true);
    expect(existsSync(brandcoreFile)).toBe(true);
    expect(existsSync(canonicalBrandcoreFile)).toBe(true);
    expect(existsSync(manifestFile)).toBe(true);
    expect(existsSync(auditReportFile)).toBe(true);
    expect(listProjectArtifacts(t.db, t.projectId, { domain: "passport" }).length).toBeGreaterThanOrEqual(4);

    const auditReport = JSON.parse(readFileSync(auditReportFile, "utf8"));
    expect(auditReport.ok).toBe(true);
    expect(auditReport.verdict).toBe("ready");
    expect(auditReport.contradictions).toEqual([]);

    // Verify both raw Russian founder quotes were stored verbatim while the passport enforces en-US product rails
    const verbatims = listVerbatim(t.db, t.projectId);
    expect(verbatims.length).toBe(2);
    expect(verbatims.map((v) => v.owner_verbatim).join(" ")).toContain("OpenDental");
    expect(verbatims.map((v) => v.owner_verbatim).join(" ")).toContain("HIPAA");

    // Verify Market-Rail Gate blocks Yandex.Direct & Kontur.Elba on this US-only project
    expect(checkPassportMarketRail(t.db, t.projectId, "mkt-direct-search-campaign").ok).toBe(false);
    expect(checkPassportMarketRail(t.db, t.projectId, "invoice-send").ok).toBe(false);
    expect(checkPassportMarketRail(t.db, t.projectId, "mkt-landing-cro-audit").ok).toBe(true);

    // Verify all downstream lenses carry US/EN/HIPAA/OpenDental context
    const writerLens = projectPassportBlock(t.db, { projectId: t.projectId, role: "writer" });
    expect(writerLens).toContain("PulseForge Dental");
    expect(writerLens).toContain("en-US");
    expect(writerLens).toContain("RU");

    // Verify Specialist OS bidirectional feedback: running mkt-project-intake reads brandcore_json & market_rails_json from Passport
    // AND approving a charter syncs max_cac & maturity_window_days back into the Living Project Passport!
    let capturedLoadStateBrandcore = "";
    t.spawned.length = 0;
    const tMkt = await setupLiveSpecialistEnv(
      {
        discover: () => {
          const rel = ".agents/marketing/intake/brief.json";
          tMkt.writeCheckoutJson(rel, { product: "PulseForge Dental", arpu_eur: 199, gross_margin: 0.85 });
          return {
            brief_path: rel,
            funnel_steps: ["visit", "demo", "opendental_sync", "stripe_subscribe"],
            counters_found: ["ga4:G-US999"],
            payment_source: "stripe_webhook",
            facts_missing: [],
          };
        },
        baseline: {
          baseline_path: ".agents/marketing/intake/baseline.json",
          priors_json: JSON.stringify({ cpc_eur: 4.2, cr_demo: 0.06 }),
        },
        charter: {
          charter_draft_json: JSON.stringify({
            north_star: { metric_id: "active_clinics", target: 25 },
            guardrails: { max_cac: 380, maturity_window_days: 28 },
            markets: ["US"],
          }),
          tracking_ok: true,
          first_graph: "mkt-landing-cro-audit",
          orders: [],
          owner_questions: [],
          needs_owner_go: true,
        },
        audit: { status: "pass", findings: [], reasons: "Charter aligns with US Stripe SaaS unit economics." },
      },
      {
        owner_go: { choice: "approve", text: "approve" },
      },
    );
    try {
      // Seed the passport into tMkt's DB first (simulating same project moving from project-passport -> mkt-project-intake)
      const savedPassport = getPassport(t.db, t.projectId)!;
      tMkt.writeCheckoutJson(".agents/passport/PASSPORT.json", savedPassport.passport);
      const { passportV1Schema, upsertPassport: upsert } = await import("../../src/rooms/passport");
      upsert(tMkt.db, { projectId: tMkt.projectId, passport: passportV1Schema.parse(savedPassport.passport), updatedBy: "seed" });

      const mktRun = await tMkt.runWorkflowLive("mkt-project-intake", {
        project_url: "https://pulseforge.dental",
        product_kind: "saas",
        has_paid_traffic: false,
        analytics_stack: "ga4",
        budget_monthly_eur: 3000,
      });
      expect(mktRun.summary.status).toBe("succeeded");
      const discoverSpawn = tMkt.spawned.find((s) => String((s.pluginMetadata as { lanePilotWorkflowNode?: string })?.lanePilotWorkflowNode) === "discover");
      capturedLoadStateBrandcore = String(discoverSpawn?.prompt ?? "");
      expect(capturedLoadStateBrandcore).toContain("HIPAA BAA");

      // Charter approval synced max_cac = 380 and maturity_window_days = 28 back into the Living Project Passport!
      const updatedAfterCharter = getPassport(tMkt.db, tMkt.projectId)!;
      expect(updatedAfterCharter.passport.economics_funnel.max_cac.value).toBe("380");
      expect(updatedAfterCharter.passport.economics_funnel.maturity_window_days.value).toBe(28);
    } finally {
      tMkt.dispose();
    }
  });
});
