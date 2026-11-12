import { describe, expect, it } from "vitest";
import { failureIntervention, MAST_OF_FAILURE } from "../src/rooms/contracts/failure-class";

describe("failure interventions by class (C6)", () => {
  it("maps each class to a different action instead of the same retry", () => {
    expect(failureIntervention("provider", 1)).toBe("next_writer");
    expect(failureIntervention("limit", 1)).toBe("next_writer");
    expect(failureIntervention("merge", 1)).toBe("free_redo");
    expect(failureIntervention("infra", 3)).toBe("park");
    expect(failureIntervention("harness", 1)).toBe("park");
    expect(failureIntervention("contract", 1)).toBe("park");
    expect(failureIntervention("task", 1)).toBe("same_retry_remark");
    expect(failureIntervention("task", 2)).toBe("narrow_brief");
    expect(failureIntervention("task", 4)).toBe("narrow_brief");
    expect(failureIntervention("verification_timeout", 1)).toBe("same_retry_remark");
  });

  it("gives every class a MAST-14 bucket for the receipts", () => {
    for (const cls of ["task", "provider", "harness", "infra", "merge", "contract", "dirty_base", "judgment", "budget", "limit", "reassign", "verification_timeout"]) {
      expect(MAST_OF_FAILURE[cls]).toMatch(/^(specification|misalignment|verification|external):/);
    }
    expect(MAST_OF_FAILURE.task).toBe("verification:incomplete_work");
    expect(MAST_OF_FAILURE.merge).toBe("misalignment:base_moved");
  });
});

