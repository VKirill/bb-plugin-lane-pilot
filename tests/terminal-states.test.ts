import { describe, expect, it } from "vitest";
import { ATTEMPT_STATES, FAILED_ATTEMPT_STATES, isFailedAttemptState, OPEN_ATTEMPT_STATES } from "../src/rooms/contracts/state-machine";
import { CARD_STAGE_ORDER, CHECK_STAGE_IDS, PLAN_STAGE_IDS, STAGE_IDS } from "@lane-pilot/contracts";

describe("terminal-failure set", () => {
  it("is ATTEMPT_STATES minus the open ones, accepted and canceled — timeout included", () => {
    // Bug fixed: self-repair's hand list omitted 'timeout'; a timed-out attempt filed no fault.
    expect(isFailedAttemptState("timeout")).toBe(true);
    for (const state of ["blocked", "provider_error", "timeout", "empty_output", "validation_failed", "spawn_rejected"]) {
      expect(isFailedAttemptState(state), state).toBe(true);
    }
    for (const state of [...OPEN_ATTEMPT_STATES, "accepted", "canceled"]) {
      expect(isFailedAttemptState(state), state).toBe(false);
    }
    expect(FAILED_ATTEMPT_STATES).toHaveLength(ATTEMPT_STATES.length - OPEN_ATTEMPT_STATES.length - 2);
  });

  it("keeps no dead state names", () => {
    for (const state of FAILED_ATTEMPT_STATES) expect(ATTEMPT_STATES).toContain(state);
  });
});

describe("stage subsets", () => {
  it("check stages are every card stage after the writer, plan stages every one before it", () => {
    const writerAt = CARD_STAGE_ORDER.indexOf("writer-agent");
    expect(writerAt).toBeGreaterThan(0);
    for (const id of CARD_STAGE_ORDER.slice(0, writerAt)) expect(PLAN_STAGE_IDS.has(id)).toBe(true);
    for (const id of CARD_STAGE_ORDER.slice(writerAt + 1)) expect(CHECK_STAGE_IDS.has(id)).toBe(true);
    expect(PLAN_STAGE_IDS.has("writer-agent")).toBe(false);
    expect(CHECK_STAGE_IDS.has("writer-agent")).toBe(false);
  });

  it("card order is a subsequence of STAGE_IDS", () => {
    let at = 0;
    for (const id of CARD_STAGE_ORDER) { const found = STAGE_IDS.indexOf(id, at); expect(found, id).toBeGreaterThanOrEqual(at); at = found + 1; }
  });
});
