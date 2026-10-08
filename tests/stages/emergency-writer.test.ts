import { describe, expect, it } from "vitest";
import { emergencyFallbackDecision, sameWriterSelection } from "../../src/stages/emergency-writer";

describe("bounded emergency writer policy", () => {
  it("suppresses fallback after success and ambiguous or canceled outcomes", () => {
    for (const state of ["accepted", "spawn_unknown", "spawn_requested", "canceled", "blocked", "validation_failed"]) {
      expect(emergencyFallbackDecision({state}).run).toBe(false);
    }
  });

  it("allows one fallback only after a terminal provider/empty failure or confirmed stop", () => {
    expect(emergencyFallbackDecision({state:"provider_error"})).toEqual({run:true,reason:"primary_provider_error"});
    expect(emergencyFallbackDecision({state:"empty_output"})).toEqual({run:true,reason:"primary_empty_output"});
    expect(emergencyFallbackDecision({state:"timeout",stopConfirmed:false}).run).toBe(false);
    expect(emergencyFallbackDecision({state:"timeout",stopConfirmed:true})).toEqual({run:true,reason:"primary_timeout_stopped"});
    expect(emergencyFallbackDecision({state:"spawn_rejected",reason:"writer_provider_unavailable:codex"}).run).toBe(true);
    expect(emergencyFallbackDecision({state:"spawn_rejected",reason:"execution_packet_failed:missing"}).run).toBe(false);
  });

  it("distinguishes a configured emergency provider/model from the failed primary", () => {
    expect(sameWriterSelection({providerId:"codex",model:"gpt-6-luna"},{providerId:"router",model:"gpt-6-flash"})).toBe(false);
    expect(sameWriterSelection({providerId:"codex",model:"gpt-6-luna"},{providerId:"codex",model:"gpt-6-luna"})).toBe(true);
  });
});
