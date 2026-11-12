import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  PERSONAL_ANAMNESIS_WORKFLOWS,
  appendVerbatim,
  checkPassportMarketRail,
  computePassportMetrics,
  createEmptyPassport,
  decidePendingPassportDelta,
  detectPassportContradictions,
  detectPassportFluff,
  getPassport,
  listPendingPassportDeltas,
  listVerbatim,
  mergePassportPatch,
  passportExcludesRu,
  passportLensFor,
  patchPassportHypothesis,
  projectPassportBlock,
  reconcileDiskPassportWithDb,
  renderBrandcoreProjection,
  renderCharterDefaults,
  runProjectPassportCli,
  selectNextPassportQuestions,
  upsertPassport,
} from "../../src/rooms/passport";
import {
  extractExplicitPassportSignals,
  ingestOwnerMessageIntoPassport,
  writePassportCheckoutArtifacts,
} from "../../src/rooms/passport/server";
import { createCore } from "../../src/rooms/core/server/core";
import { getProjectArtifact, writeCasCheckoutFile } from "../../src/rooms/storage";

function makeDb() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  return { db, dispose: () => harness.lifecycle.dispose() };
}

describe("Living Project Passport — schema, fluff/contradiction detectors, lenses, CLI & live observer", () => {
  it("computes epistemic metrics, catches vague fluff, detects contradictions, and skips confirmed questions", () => {
    const empty = createEmptyPassport();
    const coldMetrics = computePassportMetrics(empty);
    expect(coldMetrics.completeness_score).toBe(0);
    expect(coldMetrics.unknown_count).toBeGreaterThanOrEqual(25);

    // Fluff & contradiction test case: US market excluding RU, yet mentioning erid/Yandex + vague 'для всех'
    const fluffy = mergePassportPatch(empty, {
      identity: {
        project_name: { value: "CloudDent", status: "confirmed" },
        one_liner: { value: "Качественный продукт для всех и каждого во всех странах", status: "confirmed" },
        stage: { value: "idea_zero", status: "confirmed" },
      },
      market_rails: {
        primary_countries: { value: ["US"], status: "confirmed" },
        excluded_countries: { value: ["RU"], status: "taboo" },
        ui_locales: { value: ["en-US"], status: "confirmed" },
        content_locales: { value: ["en-US"], status: "confirmed" },
        currency: { value: "USD", status: "confirmed" },
        payment_rails: { value: ["Stripe"], status: "confirmed" },
        allowed_channels: { value: ["yandex_direct", "google_ads"], status: "hypothesis" },
      },
      positioning: {
        best_fit_icp: { value: "для всех компаний", status: "hypothesis" },
      },
      proof_brandcore: {
        pre_launch_zero_proof: { value: true, status: "confirmed" },
        case_patterns: { value: ["500+ happy enterprise customers"], status: "hypothesis" },
      },
    });

    expect(passportExcludesRu(fluffy)).toBe(true);

    const fluffWarnings = detectPassportFluff(fluffy);
    expect(fluffWarnings.length).toBeGreaterThanOrEqual(2);
    expect(fluffWarnings.map((w) => w.field_path).join(" ")).toContain("positioning.best_fit_icp");

    const contradictions = detectPassportContradictions(fluffy);
    expect(contradictions.length).toBeGreaterThanOrEqual(2);
    const codes = contradictions.map((c) => c.code);
    expect(codes.some((c) => /RU|MARKET|ZERO_PROOF|PROOF/i.test(c))).toBe(true);

    // Confirmed market_rails & project_name should NOT be re-asked first; missing JTBD / positioning alternatives should rank at the top
    const nextQs = selectNextPassportQuestions(fluffy, { mode: "deep_grill", maxQuestions: 5 });
    expect(nextQs.length).toBeGreaterThan(0);
    for (const q of nextQs) {
      expect(q.field_path).not.toBe("identity.project_name");
      expect(q.field_path).not.toBe("market_rails.primary_countries");
    }
  });

  it("renders bounded role lenses across all 8 roles, isolates personal workflows, and blocks RU-only graphs on US-only projects", () => {
    const { db, dispose } = makeDb();
    try {
      const projectId = "proj-us-dental";
      const patched = mergePassportPatch(createEmptyPassport(), {
        identity: {
          project_name: { value: "PulseForge", status: "confirmed" },
          one_liner: { value: "Automated recall & chair-fill SaaS for US independent dental practices", status: "confirmed" },
          stage: { value: "mvp_pre_revenue", status: "confirmed" },
          product_kind: { value: "saas", status: "confirmed" },
          primary_url: { value: "https://pulseforge.dental", status: "confirmed" },
        },
        market_rails: {
          ui_locales: { value: ["en-US"], status: "confirmed" },
          content_locales: { value: ["en-US"], status: "confirmed" },
          primary_countries: { value: ["US"], status: "confirmed" },
          excluded_countries: { value: ["RU", "BY"], status: "taboo" },
          currency: { value: "USD", status: "confirmed" },
          payment_rails: { value: ["Stripe"], status: "confirmed" },
          compliance_regimes: { value: ["HIPAA", "TCPA"], status: "confirmed" },
          forbidden_channels: { value: ["yandex_direct", "vk_ads"], status: "taboo" },
        },
        positioning: {
          best_fit_icp: { value: "2-6 chair private US dental clinic owners using OpenDental", status: "confirmed" },
          status_quo_alternatives: { value: ["Front-desk manual phone calls", "Weave"], status: "confirmed" },
          unique_attributes: { value: ["2-way SMS hygiene recall synced with OpenDental in 10 minutes"], status: "confirmed" },
          core_value: { value: "Fills 8-12 cancelled hygiene slots per month without extra front-desk hours", status: "hypothesis" },
        },
        audience_jtbd: {
          trigger_event: { value: "Hygiene schedule drops below 75% occupancy after seasonal cancellations", status: "confirmed" },
          four_forces: {
            push: { value: "Empty chair costs $250/hour while front desk is stuck on hold", status: "confirmed" },
            pull: { value: "Automatic waitlist backfill via compliant SMS", status: "confirmed" },
            anxiety: { value: "HIPAA BAA liability and spamming longtime patients", status: "confirmed" },
            habit: { value: "Sticky notes and manual call lists at 8am", status: "confirmed" },
          },
          awareness_level: { value: "problem_aware", status: "confirmed" },
        },
        messaging_voice: {
          grunt_test: { value: "Fill cancelled dental chairs automatically — synced with OpenDental.", status: "confirmed" },
          tone_of_voice: { value: "Calm, clinical, trustworthy American B2B operator tone", status: "confirmed" },
          owner_lexicon: { value: ["hygiene recall", "chair-time", "no-show backfill"], status: "confirmed" },
          banned_words: { value: ["revolutionary AI", "synergy", "erid", "ИНН"], status: "taboo" },
        },
        economics_funnel: {
          pricing_model: { value: "Monthly per-location SaaS", status: "confirmed" },
          price_point: { value: "$199/mo", status: "confirmed" },
          max_cac: { value: "$450", status: "hypothesis" },
          maturity_window_days: { value: 21, status: "confirmed" },
        },
        proof_brandcore: {
          pre_launch_zero_proof: { value: true, status: "confirmed" },
          verified_facts: { value: ["Direct OpenDental API integration", "Signed HIPAA BAA included"], status: "confirmed" },
          forbidden_claims: { value: ["Never claim ADA endorsement or invent clinic testimonials"], status: "taboo" },
        },
        product_design_rails: {
          devices: { value: ["Desktop receptionist monitor (1440p)", "Mobile SMS view"], status: "confirmed" },
          visual_references: { value: ["Linear", "Stripe Billing", "OneMedical"], status: "confirmed" },
          anti_references: { value: ["Dark crypto neon", "Cluttered legacy dental Windows 98 UI"], status: "taboo" },
        },
      });

      upsertPassport(db, { projectId, passport: patched, updatedBy: "test" });
      appendVerbatim(db, {
        projectId,
        source: "founder-interview",
        questionAsked: "Who is the product for and what markets are excluded?",
        ownerVerbatim: "Делаем строго под частные стоматологии в США на английском языке, никакой России, Яндекса или рублёвых реалий.",
        extractedPaths: ["market_rails.primary_countries", "market_rails.excluded_countries"],
      });

      const roles = [
        "pm",
        "writer",
        "specialist:copy-lead",
        "specialist:design-lead",
        "specialist:seo-specialist",
        "specialist:growth-marketer",
        "council",
        "lead",
      ] as const;

      for (const role of roles) {
        const block = projectPassportBlock(db, { projectId, role, maxChars: 1800 });
        expect(block, `lens for ${role}`).toContain("<project_passport");
        expect(block).toContain("PulseForge");
        expect(block).toContain("US");
        expect(block.length).toBeLessThanOrEqual(1900);
      }

      // Copy lens carries lexicon & banned words; Design lens carries visual references; SEO lens carries BrandCore zero-proof rule
      expect(projectPassportBlock(db, { projectId, role: "specialist:copy-lead" })).toContain("hygiene recall");
      expect(projectPassportBlock(db, { projectId, role: "specialist:design-lead" })).toContain("OneMedical");
      expect(projectPassportBlock(db, { projectId, role: "specialist:seo-specialist" })).toContain("HIPAA BAA");

      // Personal owner workflows NEVER receive project passport pollution
      for (const personalWf of PERSONAL_ANAMNESIS_WORKFLOWS) {
        expect(projectPassportBlock(db, { projectId, role: "pm", workflowId: personalWf })).toBe("");
      }

      // Market-rail gate refuses RU-only workflows on US-only project unless allowCrossMarket is explicitly set
      const directGate = checkPassportMarketRail(db, projectId, "mkt-direct-search-campaign");
      expect(directGate.ok).toBe(false);
      if (!directGate.ok) {
        expect(directGate.reason).toContain("mkt-direct-search-campaign");
      }

      const elbaGate = checkPassportMarketRail(db, projectId, "invoice-send");
      expect(elbaGate.ok).toBe(false);

      expect(checkPassportMarketRail(db, projectId, "mkt-direct-search-campaign", { allowCrossMarket: true }).ok).toBe(true);
      expect(checkPassportMarketRail(db, projectId, "seo-project-intake").ok).toBe(true);
      expect(checkPassportMarketRail(db, projectId, "mkt-landing-cro-audit").ok).toBe(true);

      // BrandCore & Charter projections
      const stored = getPassport(db, projectId)!;
      const bc = renderBrandcoreProjection(stored.passport);
      expect(bc.json.pre_launch_zero_proof).toBe(true);
      expect((bc.json.forbidden_claims as string[])[0]).toContain("ADA endorsement");

      const charterDefs = renderCharterDefaults(stored.passport);
      expect(charterDefs.currency).toBe("USD");
      expect(charterDefs.maturity_window_days).toBe(21);
    } finally {
      dispose();
    }
  });

  it("supports CLI commands (set, show, probe, verbatim) and protects confirmed claims against silent chat overwrites", () => {
    const { db, dispose } = makeDb();
    try {
      const projectId = "proj-cli-observer";

      // 1. Live chat observer on cold passport auto-fills unknown market rails from explicit owner declaration
      const firstIngest = ingestOwnerMessageIntoPassport(db, {
        id: "msg-1",
        projectId,
        threadId: "thr-pm-1",
        at: Date.now(),
        text: "Делаем продукт под рынок США без РФ, подписка через Stripe, цена будет $49/mo.",
      });
      expect(firstIngest.capturedVerbatim).toBe(true);
      expect(firstIngest.updatedFields).toEqual(
        expect.arrayContaining([
          "market_rails.primary_countries",
          "market_rails.excluded_countries",
          "market_rails.payment_rails",
          "economics_funnel.price_point",
        ]),
      );
      expect(firstIngest.pendingIds).toEqual([]);
      expect(getPassport(db, projectId)?.passport.market_rails.primary_countries.value).toEqual(["US"]);
      expect(getPassport(db, projectId)?.passport.economics_funnel.price_point.value).toBe("$49/mo");
      expect(listVerbatim(db, projectId).length).toBe(1);

      // 2. Conflicting update on an ALREADY CONFIRMED claim queues a pending owner confirmation card instead of overwriting!
      const conflictRes = patchPassportHypothesis(db, {
        projectId,
        fieldPath: "economics_funnel.price_point",
        nextStatus: "confirmed",
        value: "$299/mo",
        evidenceRef: "chat:later",
        note: "Owner mentioned a higher enterprise tier in passing",
      });
      expect(conflictRes.applied).toBe(false);
      expect(conflictRes.queuedPending).toBeDefined();
      expect(getPassport(db, projectId)?.passport.economics_funnel.price_point.value).toBe("$49/mo");

      const pendings = listPendingPassportDeltas(db, projectId, { onlyPending: true });
      expect(pendings.length).toBe(1);

      // Decide via CLI (`decide --decision accept`) -> promotes to $299/mo
      const cliDecide = runProjectPassportCli(db, [
        "decide",
        "--project",
        projectId,
        "--id",
        pendings[0]!.id,
        "--decision",
        "accept",
      ]);
      expect(cliDecide.exitCode).toBe(0);
      expect(getPassport(db, projectId)?.passport.economics_funnel.price_point.value).toBe("$299/mo");

      // CLI set, show --json, show --role, probe
      const cliSet = runProjectPassportCli(db, [
        "set",
        "--project",
        projectId,
        "--field",
        "identity.project_name",
        "--value",
        "LedgerBeam",
        "--status",
        "confirmed",
        "--verbatim",
        "Назовём продукт LedgerBeam.",
      ]);
      expect(cliSet.exitCode).toBe(0);

      const cliLens = runProjectPassportCli(db, ["show", "--project", projectId, "--role", "writer"]);
      expect(cliLens.exitCode).toBe(0);
      expect(cliLens.stdout).toContain("LedgerBeam");

      const cliProbe = runProjectPassportCli(db, ["probe", "--project", projectId]);
      expect(cliProbe.exitCode).toBe(0);
      expect(JSON.parse(cliProbe.stdout!).exists).toBe(true);

      // Rejecting a second pending delta leaves confirmed value untouched
      const conflict2 = patchPassportHypothesis(db, {
        projectId,
        fieldPath: "identity.project_name",
        nextStatus: "confirmed",
        value: "WrongName",
        evidenceRef: "agent:guess",
      });
      expect(conflict2.applied).toBe(false);
      decidePendingPassportDelta(db, { projectId, deltaId: conflict2.queuedPending!.id, decision: "reject" });
      expect(getPassport(db, projectId)?.passport.identity.project_name.value).toBe("LedgerBeam");

      // Carbon BUG-5: listPendingPassportDeltas with onlyPending: false accurately maps accepted/rejected states
      const allDeltas = listPendingPassportDeltas(db, projectId, { onlyPending: false });
      expect(allDeltas.map((d) => d.state)).toEqual(expect.arrayContaining(["accepted", "rejected"]));
    } finally {
      dispose();
    }
  });

  it("closes ASTRA-F-001, F-002, and F-012: CAS conflict guard, disk-to-DB reconciliation with confirmed claims, and negation-aware live observer", async () => {
    // ASTRA-F-012: clause-level negation & epistemic grading
    expect(extractExplicitPassportSignals("Не используем Stripe для оплаты")).toEqual([]);

    const splitClause = extractExplicitPassportSignals("Не делаем проект для США, делаем для России");
    expect(splitClause).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldPath: "market_rails.excluded_countries", value: ["US"], status: "taboo" }),
        expect.objectContaining({ fieldPath: "market_rails.primary_countries", value: ["RU"], status: "confirmed" }),
      ]),
    );
    expect(splitClause.find((s) => s.fieldPath === "market_rails.primary_countries")?.value).not.toContain("US");

    const euSignals = extractExplicitPassportSignals("Делаем продукт для Европы");
    expect(euSignals).toEqual([
      expect.objectContaining({ fieldPath: "market_rails.primary_countries", value: ["EU"], status: "hypothesis" }),
    ]);

    // ASTRA-F-002: reconcileDiskPassportWithDb merges unconfirmed disk edits and queues pending deltas on confirmed conflicts
    const { db, dispose } = makeDb();
    try {
      const projectId = "proj-disk-reconcile";
      const seeded = mergePassportPatch(createEmptyPassport(), {
        identity: {
          project_name: { value: "AnchorSaaS", status: "confirmed" },
        },
        positioning: {
          core_value: { value: "Initial draft value", status: "hypothesis" },
        },
      });
      upsertPassport(db, { projectId, passport: seeded, updatedBy: "owner" });

      const editedOnDisk = mergePassportPatch(seeded, {
        identity: {
          project_name: { value: "HijackedName", status: "confirmed" },
          one_liner: { value: "B2B treasury automation", status: "confirmed" },
        },
        positioning: {
          core_value: { value: "Automated cash-flow sweeps in 5 minutes", status: "confirmed" },
        },
      });
      const rec = reconcileDiskPassportWithDb(db, { projectId, diskPassport: editedOnDisk });
      expect(rec.updatedPaths).toEqual(expect.arrayContaining(["identity.one_liner", "positioning.core_value"]));
      expect(rec.queuedDeltas).toHaveLength(1);
      expect(rec.queuedDeltas[0]?.field_path).toBe("identity.project_name");
      expect(getPassport(db, projectId)?.passport.identity.project_name.value).toBe("AnchorSaaS");
      expect(getPassport(db, projectId)?.passport.identity.one_liner.value).toBe("B2B treasury automation");
      expect(getPassport(db, projectId)?.passport.positioning.core_value.value).toBe("Automated cash-flow sweeps in 5 minutes");

      // ASTRA-R2-004: rejecting a pending delta must NOT resurrect on subsequent disk reconcile
      const rejectedId = rec.queuedDeltas[0]!.id;
      expect(decidePendingPassportDelta(db, { projectId, deltaId: rejectedId, decision: "reject" }).ok).toBe(true);
      const recRepeat = reconcileDiskPassportWithDb(db, { projectId, diskPassport: editedOnDisk });
      expect(recRepeat.queuedDeltas).toHaveLength(0);
      expect(listPendingPassportDeltas(db, projectId)).toHaveLength(0);

      // ASTRA-F-002 (Round 2): confirmed -> hypothesis downgrade on same value must NOT overwrite confirmed status
      const downgradedDisk = mergePassportPatch(getPassport(db, projectId)!.passport, {
        identity: { project_name: { value: "AnchorSaaS", status: "hypothesis" } },
      });
      const recDowngrade = reconcileDiskPassportWithDb(db, { projectId, diskPassport: downgradedDisk });
      expect(recDowngrade.updatedPaths).toHaveLength(0);
      expect(recDowngrade.queuedDeltas).toHaveLength(1);
      expect(getPassport(db, projectId)?.passport.identity.project_name.status).toBe("confirmed");

      // ASTRA-R3-001: Additive array fields (e.g. banned_words) locked as confirmed/taboo must NEVER downgrade via patchPassportHypothesis -> disk hijack
      const seededArr = mergePassportPatch(getPassport(db, projectId)!.passport, {
        messaging_voice: { banned_words: { value: ["AnchorWord"], status: "confirmed" } },
      });
      upsertPassport(db, { projectId, passport: seededArr, updatedBy: "owner" });
      const r3Attempt = patchPassportHypothesis(db, {
        projectId,
        fieldPath: "messaging_voice.banned_words",
        nextStatus: "hypothesis",
        value: ["AnchorWord"],
        evidenceRef: "agent:downgrade",
        allowOverrideConfirmed: false,
      });
      expect(r3Attempt.applied).toBe(false);
      expect(r3Attempt.queuedPending).toBeDefined();
      const hijackArrDisk = mergePassportPatch(getPassport(db, projectId)!.passport, {
        messaging_voice: { banned_words: { value: ["HijackedWord"], status: "hypothesis" } },
      });
      reconcileDiskPassportWithDb(db, { projectId, diskPassport: hijackArrDisk });
      expect(getPassport(db, projectId)?.passport.messaging_voice.banned_words.value).toEqual(["AnchorWord"]);
      expect(getPassport(db, projectId)?.passport.messaging_voice.banned_words.status).toBe("confirmed");

      // ASTRA-F-001: CAS write conflict prevents lane_pilot_artifact SHA256 drift
      const { bb: conflictBb, harness: conflictHarness } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: {
          files: {
            read: async () => ({ content: "{}", sha256: "a".repeat(64) }) as never,
            write: async () => ({ outcome: "conflict", currentSha256: "b".repeat(64) }) as never,
          },
        },
      });
      try {
        const conflictDb = openDatabase(conflictBb);
        upsertPassport(conflictDb, { projectId, passport: seeded, updatedBy: "owner" });
        const conflictCtx = createCore(conflictBb, conflictDb);
        const casDirect = await writeCasCheckoutFile(conflictBb.sdk.files as never, {
          hostId: "local",
          rootPath: "/tmp/fake-checkout",
          relPath: ".agents/passport/PASSPORT.json",
          content: "{}",
        });
        expect(casDirect.ok).toBe(false);
        expect(casDirect.outcome).toBe("conflict");
        await writePassportCheckoutArtifacts(conflictCtx, { hostId: "local", path: "/tmp/fake-checkout" }, projectId);
        expect(getProjectArtifact(conflictDb, projectId, "passport.main")).toBeNull();
        expect(getProjectArtifact(conflictDb, projectId, "passport.brandcore")).toBeNull();
      } finally {
        conflictHarness.lifecycle.dispose();
      }
    } finally {
      dispose();
    }
  });
});
