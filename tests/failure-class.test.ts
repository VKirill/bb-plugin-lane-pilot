import { describe, expect, it } from "vitest";
import { FREE_CLASSES, failureClass, repeatedFailureReason, taskFamily } from "../src/failure-class";
import { providerLimitNotice } from "../src/server/writer-task";

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

  // content-factory editor-policy-ui(.2), 2026-10-06: acp-cursor/grok-4.6 answered only this, twice per task.
  it("reads a provider's plan or quota notice as a limit: uncharged, never a repeated task failure", () => {
    const notice = providerLimitNotice("\n\nUpgrade your plan to continue\n");
    expect(notice).toBe("Upgrade your plan to continue");
    const reason = `writer_provider_limit: ${notice}`;
    expect(failureClass("provider_error", reason)).toBe("limit");
    expect(FREE_CLASSES.has("limit")).toBe(true);
    expect(repeatedFailureReason({ state:"provider_error", reason }, { state:"provider_error", reason })).toBeNull();
    expect(failureClass("spawn_rejected", "writer_provider_unavailable:breaker_open:acp-cursor/grok-4.6: 1 provider failures in 10 min")).toBe("limit");
    for (const text of ["You've hit your usage limit. Try again in 3 hours.", "Error: quota exceeded for this month", "429 Too Many Requests",
      "You are out of credits.", "Your credit balance is too low to access the API"]) expect(providerLimitNotice(text)).not.toBeNull();
  });

  it("keeps a real writer report about rate limits a report", () => {
    expect(providerLimitNotice("Added a token bucket to api/limiter.ts.")).toBeNull();
    expect(providerLimitNotice(`Changed api/limiter.ts: requests over the rate limit reached now get 429.\n${"Checks: npm test passed. ".repeat(20)}`)).toBeNull();
    expect(providerLimitNotice("")).toBeNull();
  });
});
