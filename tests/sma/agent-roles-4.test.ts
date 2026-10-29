import { describe, expect, it } from "vitest";
import { laneSessionOverlayPrompt } from "../../src/rooms/native-agent/native-agent-overlay";

describe("ported specialist sessions", () => {
  it("[sma:k_ag_selector] the selector recommends one option and does not build the feature", () => {
    const text = laneSessionOverlayPrompt("framework-selector");
    expect(text).toContain("Recommend one and say why");
    expect(text).toContain("Do not build the feature");
  });

  it.todo("[sma:k_ag_selector] there is no scored interactive decision matrix"); // deferral:dfr_seed_skip_sma_gaps

  it("[sma:k_ag_advisor] one gray area gets two or three options and a recommendation", () => {
    const text = laneSessionOverlayPrompt("advisor-researcher");
    expect(text).toContain("two or three options");
    expect(text).toContain("your recommendation");
  });
});

describe("lane roles Lane Pilot does not perform", () => {
  it.todo("[sma:k_ag_airesearcher] nothing writes a quick reference into AI-SPEC.md"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_domain] no expert criteria, industry failure modes or regulation are gathered before an eval plan"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_evalplanner] dimensions, rubrics, guardrails and monitoring are not written to AI-SPEC.md"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_codefixer] fixes from REVIEW.md are not applied, and not as one commit each"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_debugmgr] no isolated multi-cycle debug session spawns debuggers or returns a compact summary"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_nyquist] the session is told not to write the tests the phase is missing"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_evalauditor] an evaluation plan is not marked covered, partial or missing per dimension"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_uiresearcher] UI-SPEC.md is not written, and unanswered points are not the only questions"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_docwriter] documents are not created or updated by assignment"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_classifier] a document is not classed ADR, PRD, SPEC, DOC or unknown, one at a time"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_docsynth] documents are not merged by precedence and INGEST-CONFLICTS.md is not written"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_mapper] the orientation session is told not to write the map"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_curator] ship time does not write a session diary or mirror it into an external graph"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_pattern] no role finds the closest existing analog for each new file of a plan"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_assumptions] phase code is not read for assumptions with evidence"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_projres] stack, features, architecture and pitfalls are not researched before a roadmap"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_synth] parallel research is not merged into SUMMARY.md"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:k_ag_roadmapper] phases are not mapped to requirements with coverage checks"); // deferral:dfr_seed_skip_sma_gaps
});
