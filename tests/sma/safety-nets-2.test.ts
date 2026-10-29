import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDrill } from "../../src/rooms/checkers/drill";
import { plantDefect } from "../../src/rooms/checkers/mutators";
import type { PlantInput } from "../../src/rooms/checkers/types";
import { answerPermit } from "../../src/rooms/host-worker/host-handlers";
import { PRICE_LIST, priceOf, rowUsd } from "../../src/rooms/money/logic";
import { POLICY, classifyChange } from "../../src/rooms/policy";

describe("safety nets", () => {
  it("[sma:k_lib_pricing] one price list prices a named model, a provider default, and a subscription at zero", () => {
    expect(priceOf("anthropic", "claude-haiku-4-5")).toEqual(PRICE_LIST.anthropic!["claude-haiku"]);
    expect(priceOf("anthropic", "claude-unknown")).toEqual(PRICE_LIST.anthropic!.default);
    expect(priceOf("claude-code", "claude-haiku")).toBeNull();
    const row = { day: "2026-10-02", providerId: "anthropic", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
    expect(rowUsd(row)).toBe(0.8);
    expect(rowUsd({ ...row, providerId: "claude-code" })).toBe(0);
  });

  it("[sma:k_st_ladder] the tracked policy file decides the tier, and the most restrictive match wins", () => {
    expect(POLICY.version).toBe(4);
    expect(classifyChange({ kind: "data_delete" })).toBe("owner_only");
    expect(classifyChange({ kind: "lp_fault_repair", attrs: { bench_subset_passed: true, auto_revertible: true } })).toBe("night_decides");
    expect(classifyChange({ kind: "not-a-kind" })).toBe("night_proposes");
    expect(classifyChange({ kind: "data_delete", files: ["docs/readme.md"] })).toBe("owner_only");
  });

  it("[sma:k_lib_tooldecision] an answer is allow or deny with why, and a missing ticket is not written", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-permit-"));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      mkdirSync(join(home, ".agents", "permits", "sess1"), { recursive: true });
      writeFileSync(join(home, ".agents", "permits", "sess1", "a1b2c3d4e5f60718.ticket.json"), JSON.stringify({ category: "delete", command: "rm build", cwd: "/w", at: 1 }));
      expect((await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "a1b2c3d4e5f60718", decision: "deny", why: "not this task" } as never, {} as never)).written).toBe(true);
      const stored = JSON.parse(readFileSync(join(home, ".agents", "permits", "sess1", "a1b2c3d4e5f60718.answer.json"), "utf8"));
      expect(stored).toMatchObject({ decision: "deny", why: "not this task" });
      expect((await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "ffffffffffffffff", decision: "allow", why: "no ticket" } as never, {} as never)).written).toBe(false);
    } finally { process.env.HOME = before; }
  });

  it("[sma:k_v_canary] a planted boundary change is a real edit, and the drill counts which checker caught it", async () => {
    const input = { taskId: "t", source: "sma", contract: { project_cwd: "/r", owns_paths: ["src/**"], never_touch: [], verification: [], acceptance: ["the bound holds"] },
      changes: [{ path: "src/a.ts", before: null, after: "if (i < n) return i;\n" }] } as unknown as PlantInput;
    const planted = plantDefect(input, "off_by_one");
    expect(planted?.changes[0]?.after).toContain("<=");
    expect(planted?.defect.expected).toEqual(["verification"]);
    const drill = await runDrill();
    const row = drill.checked.find((item) => item.defectClass === "off_by_one");
    expect(row?.planted).toBeGreaterThan(0);
    expect(row?.caughtBy).toContain("verification");
  }, 60_000);
});
