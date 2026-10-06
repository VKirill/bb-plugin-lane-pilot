import { describe, expect, it } from "vitest";
import { failureClass, repeatedFailureReason, taskFamily } from "../src/failure-class";

describe("failure classes", () => {
  it("keeps provider, limit and catalog faults on the provider path for the writer chain", () => {
    expect(failureClass("provider_error", "thread status error")).toBe("provider");
    expect(failureClass("spawn_rejected", "writer_provider_unavailable: catalog down")).toBe("provider");
    expect(failureClass("timeout", null)).toBe("provider");
    expect(failureClass("empty_output", "writer returned no output")).toBe("provider");
  });

  it("reads an empty_output with a writer answer as the task's failure, not the model's", () => {
    expect(failureClass("empty_output", "writer answered but changed no files")).toBe("task");
    expect(failureClass("empty_output", "writer changed no files")).toBe("task");
    // A contract-named reason keeps its class, and a provider fault never turns into a task failure.
    expect(failureClass("empty_output", "missing expected_outputs: src/a.ts")).toBe("contract");
    expect(failureClass("validation_failed", "writer answered but changed no files")).toBe("task");
  });
});

describe("repeated failures", () => {
  it("blocks two consecutive attempts that failed the same way", () => {
    const first = { state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345 in thr_abc at line 12" };
    const again = { state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345 in thr_def at line 13" };
    expect(repeatedFailureReason(first, again)).toMatch(/^repeated_failure: verification failed \(npm run typecheck\)/);
    expect(repeatedFailureReason(again, first)).toMatch(/^repeated_failure: /);
  });

  it("lets different reasons, classes and first attempts through", () => {
    expect(repeatedFailureReason(null, { state:"validation_failed", reason:"x" })).toBeNull();
    expect(repeatedFailureReason(undefined, { state:"provider_error", reason:"thread status error" })).toBeNull();
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"verification failed (npm run typecheck): a" },
      { state:"validation_failed", reason:"verification failed (npm run vitest): b" },
    )).toBeNull();
    // An answered empty_output is a task failure; a silent one is the provider's — never the same failure.
    expect(repeatedFailureReason(
      { state:"empty_output", reason:"writer returned no output" },
      { state:"empty_output", reason:"writer answered but changed no files" },
    )).toBeNull();
    expect(repeatedFailureReason(
      { state:"empty_output", reason:"writer answered but changed no files" },
      { state:"empty_output", reason:"writer answered but changed no files" },
    )).toMatch(/^repeated_failure: /);
    // A contract failure repeats too: a contract no attempt can meet fails the same way twice and then stops.
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"missing expected_outputs: src/a.ts" },
      { state:"validation_failed", reason:"missing expected_outputs: src/a.ts" },
    )).toMatch(/^repeated_failure: missing expected_outputs/);
    // Free classes keep their own parks and caps.
    expect(repeatedFailureReason(
      { state:"validation_failed", reason:"merge_conflict: main changed since this attempt started: src/a.ts" },
      { state:"validation_failed", reason:"merge_conflict: main changed since this attempt started: src/a.ts" },
    )).toBeNull();
  });
});

describe("task families", () => {
  it("groups a task with its redispatches and mainfixes", () => {
    expect(taskFamily("P1")).toBe("P1");
    expect(taskFamily("P1.2")).toBe("P1");
    expect(taskFamily("P1.2.3")).toBe("P1");
    expect(taskFamily("x-mainfix")).toBe("x");
    expect(taskFamily("x-mainfix.2")).toBe("x");
    expect(taskFamily("lptask_abc")).toBe("lptask_abc");
  });
});
