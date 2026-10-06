import { describe, expect, it } from "vitest";
import { breakerKey, classifyFailure, createProviderBreaker, createRunBudget, parseRunBudgetLimits, tokenUsageFromEvent } from "../src/index";

describe("classifyFailure", () => {
  it("separates provider trouble from poor work", () => {
    expect(classifyFailure("provider_error:rate limit exceeded")).toBe("transient");
    expect(classifyFailure("system_error:ECONNRESET")).toBe("transient");
    expect(classifyFailure("provider_error:model not available")).toBe("failure");
    expect(classifyFailure("acceptance rejected: note.txt missing")).toBe("product");
    expect(classifyFailure(null)).toBe("product");
  });
});

describe("provider breaker", () => {
  const key = breakerKey("codex", "gpt-6-luna");

  it("opens after the threshold inside the window and closes on success after the cooldown", () => {
    const breaker = createProviderBreaker({ failureThreshold: 2, windowMs: 1000, cooldownMs: 500 });
    breaker.record(key, "transient", 0);
    expect(breaker.decide(key, 10)).toEqual({ allow: true, state: "closed" });
    breaker.record(key, "failure", 20);
    const open = breaker.decide(key, 30);
    expect(open.allow).toBe(false);
    expect(open.state).toBe("open");
    const trial = breaker.decide(key, 600);
    expect(trial).toEqual({ allow: true, state: "half_open" });
    expect(breaker.decide(key, 610).allow).toBe(false);
    breaker.record(key, "ok", 700);
    expect(breaker.decide(key, 710)).toEqual({ allow: true, state: "closed" });
  });

  it("opens at once when the provider refuses for the plan or quota", () => {
    const breaker = createProviderBreaker();
    expect(classifyFailure("provider_error:writer_provider_limit: Upgrade your plan to continue")).toBe("exhausted");
    breaker.record("acp-cursor/grok-4.6", "exhausted", 0);
    expect(breaker.decide("acp-cursor/grok-4.6", 1)).toMatchObject({ allow:false, state:"open" });
  });

  it("re-opens at once when the trial call fails", () => {
    const breaker = createProviderBreaker({ failureThreshold: 1, windowMs: 1000, cooldownMs: 100 });
    breaker.record(key, "failure", 0);
    expect(breaker.decide(key, 150).state).toBe("half_open");
    breaker.record(key, "transient", 160);
    expect(breaker.decide(key, 170).state).toBe("open");
  });

  it("ignores product failures and forgets old ones", () => {
    const breaker = createProviderBreaker({ failureThreshold: 2, windowMs: 100, cooldownMs: 100 });
    breaker.record(key, "product", 0);
    breaker.record(key, "product", 1);
    expect(breaker.decide(key, 2).allow).toBe(true);
    breaker.record(key, "failure", 10);
    breaker.record(key, "failure", 500);
    expect(breaker.decide(key, 501).allow).toBe(true);
    expect(breaker.snapshot(501)[0]?.failures).toBe(1);
  });
});

describe("run budget", () => {
  it("names the first exceeded limit", () => {
    const budget = createRunBudget({ maxAttempts: 2, maxTokens: 1000, maxWallMs: 10_000 }, 0);
    budget.noteAttempt();
    budget.noteAttempt();
    expect(budget.check(5)).toEqual({ ok: true });
    budget.noteTokens("t1", 600);
    budget.noteTokens("t2", 300);
    budget.noteTokens("t1", 650);
    expect(budget.snapshot(5).tokens).toBe(950);
    budget.noteTokens("t2", 400);
    const check = budget.check(5);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.exceeded).toBe("maxTokens");
    expect(createRunBudget({ maxWallMs: 10 }, 0).check(11).ok).toBe(false);
  });

  it("reads BB usage events and settings", () => {
    expect(tokenUsageFromEvent({ type: "thread/tokenUsage/updated", data: { threadId: "t", tokenUsage: { total: { totalTokens: 42 } } } })).toEqual({ threadId: "t", totalTokens: 42 });
    expect(tokenUsageFromEvent({ type: "turn/completed" })).toBeNull();
    expect(parseRunBudgetLimits({ "run.max_tokens": "5000", "run.max_wall_minutes": 2, "run.max_attempts": "" })).toEqual({ maxTokens: 5000, maxWallMs: 120_000 });
    expect(() => parseRunBudgetLimits({ "run.max_children": "many" })).toThrow();
  });
});
