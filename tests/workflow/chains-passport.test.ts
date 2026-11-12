import { describe, expect, it } from "vitest";
import { out, pathOf } from "./chain-helpers";
import { runSim } from "./chain-harness";

describe("project-passport", () => {
  const baseStubs = {
    probe: {
      has_passport: false,
      completeness_score: 0,
      confirmed_count: 0,
      unknown_count: 32,
      passport_json: "{}",
      recon_summary: "",
      contradictions_json: "[]",
      fluff_warnings_json: "[]",
      next_questions_json: '[{"id":"Q_MARKET_RAILS"}]',
      should_continue: true,
    },
    grill_plan: {
      completeness_score: 0,
      verdict: "needs_discovery",
      contradictions_count: 0,
      fluff_count: 0,
      next_questions_json: '[{"id":"Q_MARKET_RAILS"},{"id":"Q_ICP_ALTERNATIVE"}]',
      report_path: ".agents/passport/reports/project-passport-grill_plan.json",
    },
    round_1_questions: {
      interview_prompt: "1) Who in the US dental clinic signs off on $199/mo, and what do they use today instead? 2) What trigger makes them switch?",
      focus_areas: ["positioning.best_fit_icp", "positioning.status_quo_alternatives", "audience_jtbd.trigger_event"],
    },
    extract_round_1: {
      patch_json:
        '{"identity":{"project_name":{"value":"PulseForge","status":"confirmed"}},"market_rails":{"primary_countries":{"value":["US"],"status":"confirmed"},"excluded_countries":{"value":["RU"],"status":"taboo"}}}',
      extracted_notes: "US dental clinics confirmed; RU explicitly excluded.",
    },
    commit_round_1: {
      version: 1,
      completeness_score: 56,
      passport_json: '{"version":1}',
      passport_path: ".agents/passport/PASSPORT.json",
      brandcore_projection_path: ".agents/passport/BRANDCORE.projection.md",
      contradictions_json: "[]",
      fluff_warnings_json: "[]",
      next_questions_json: '[{"id":"Q_PROOF_FACTS"}]',
      ready_to_finish: false,
    },
    round_2_questions: {
      interview_prompt: "1) What anxieties stop a clinic owner from connecting PMS data? 2) What verified proof exists today vs taboo claims?",
      focus_areas: ["audience_jtbd.four_forces.anxiety", "proof_brandcore.verified_facts", "proof_brandcore.forbidden_claims"],
    },
    extract_round_2: {
      patch_json: '{"proof_brandcore":{"forbidden_claims":{"value":["Never invent HIPAA certifications"],"status":"taboo"}}}',
      extracted_notes: "HIPAA anxieties and zero-fabrication guardrails recorded.",
    },
    commit_round_2: {
      version: 2,
      completeness_score: 84,
      passport_json: '{"version":2}',
      passport_path: ".agents/passport/PASSPORT.json",
      brandcore_projection_path: ".agents/passport/BRANDCORE.projection.md",
      contradictions_json: "[]",
      fluff_warnings_json: "[]",
      next_questions_json: "[]",
    },
    grill_audit: {
      completeness_score: 84,
      verdict: "ready",
      contradictions_count: 0,
      fluff_count: 0,
      report_path: ".agents/passport/reports/project-passport-grill_audit.json",
    },
    synthesize: {
      briefing_md: "Passport v2 ready (84%): US-only EN B2B SaaS, Stripe USD, RU/Yandex strictly excluded.",
      recommended_workflows: ["research-dossier", "seo-project-intake", "mkt-project-intake"],
    },
  };

  it("runs two adaptive founder discovery rounds and emits PassportV1 + BrandCore projection", async () => {
    const r = await runSim("project-passport", {
      input: {
        mode: "deep_grill",
        target_domain: "",
        seed_brief: "We are launching PulseForge, an English-only B2B SaaS for US independent dental clinics ($199/mo via Stripe), strictly not for Russia.",
        scope_key: "",
      },
      stubs: baseStubs,
      humans: {
        owner_round_1: { answer: "Practice owners with 2-8 chairs using paper spreadsheets", answer_kind: "answered" },
        owner_round_2: { answer: "HIPAA fear; zero reviews yet", answer_kind: "answered" },
      },
    });
    expect(pathOf(r)).toBe(
      "probe grill_plan round_1_questions owner_round_1 extract_round_1 commit_round_1 round_2_questions owner_round_2 extract_round_2 commit_round_2 grill_audit synthesize done",
    );
    expect(out(r)).toMatchObject({
      status: "done",
      version: 2,
      completeness_score: 84,
      passport_path: ".agents/passport/PASSPORT.json",
      brandcore_projection_path: ".agents/passport/BRANDCORE.projection.md",
    });
  });

  it("cancels cleanly when owner cancels round 1 without seed brief", async () => {
    const r = await runSim("project-passport", {
      input: { mode: "deep_grill", seed_brief: "" },
      stubs: baseStubs,
      humans: { owner_round_1: { answer: "", answer_kind: "cancel" } },
    });
    expect(pathOf(r)).toBe("probe grill_plan round_1_questions owner_round_1 cancelled");
    expect(out(r)).toMatchObject({ status: "cancelled" });
  });
});
