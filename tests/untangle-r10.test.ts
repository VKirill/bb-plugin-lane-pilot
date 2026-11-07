import { describe, expect, it } from "vitest";
import { brokenProof, proofDrift } from "../src/rooms/sma-map";
import { exportedOf, relocateAnchor } from "../src/rooms/sma-map/exports";
import { clockForColumns, darkClockExpr } from "../src/rooms/sma-map/live";
import { failureClass } from "../src/rooms/platform/server/failure-class";
import { stageTransition } from "../src/rooms/tasks";
import { attemptPercent } from "../src/rooms/world/server/signals";

const roots = { lanePilot: process.cwd() };

describe("sma-map proofs name declared units, not source text", () => {
  it("a declared symbol resolves — exported or not", () => {
    expect(brokenProof("src/rooms/sma-map/entries.ts#SMA_ENTRIES", roots)).toBeNull();
    expect(brokenProof("src/rooms/sma-map/model.ts#smaRows", roots)).toBeNull();
    // percent is module-private in model.ts: a private declaration is still the unit a proof may name.
    expect(brokenProof("src/rooms/sma-map/model.ts#percent", roots)).toBeNull();
  });

  it("a declaration-style anchor resolves to the unit it names", () => {
    expect(brokenProof("src/rooms/sma-map/entries.ts#export const SMA_ENTRIES", roots)).toBeNull();
    expect(brokenProof("src/rooms/sma-map/model.ts#export function smaRows(", roots)).toBeNull();
  });

  it("body text, prose and mere usages are not proofs in a module", () => {
    expect(brokenProof("src/rooms/sma-map/entries.ts#this text is not an export q7z", roots)).toMatch(/not declared/);
    expect(brokenProof("src/rooms/sma-map/entries.ts#export", roots)).toMatch(/not declared/);
    // SMA_ENTRIES is imported into model.ts, never declared there: the unit lives in entries.ts.
    expect(brokenProof("src/rooms/sma-map/model.ts#SMA_ENTRIES", roots)).toMatch(/not declared/);
  });

  it("data files keep their literal check — they have no export surface", () => {
    expect(brokenProof("workflows/lp.plan.json#\"plan_critic\"", roots)).toBeNull();
    expect(brokenProof("workflows/lp.plan.json#\"no-such-node-q7z\"", roots)).toMatch(/not in the file/);
  });

  it("a missing file is still a broken proof", () => {
    expect(brokenProof("src/rooms/nowhere/gone.ts#anything", roots)).toMatch(/no such file/);
  });

  it("every proof in the registry resolves under the declared-name rule", async () => {
    const { smaRows } = await import("../src/rooms/sma-map");
    const broken = smaRows().flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter((x): x is string => !!x);
    expect(broken).toEqual([]);
  });
});

describe("export surface and anchor relocation", () => {
  it("exportedOf reads declarations, export lists and defaults", () => {
    const text = `const a = 1;\nexport function bee() {}\nexport const C = 2;\nexport type D = {};\nexport { a as A2 };\nexport default function () {}\n`;
    const names = exportedOf(text);
    for (const name of ["bee", "C", "D", "A2", "default"]) expect(names).toContain(name);
    expect(names).not.toContain("a");
  });

  it("relocateAnchor repairs to an export anchor, not the moved text", () => {
    // attemptPercent is exported by exactly one module.
    const at = relocateAnchor(process.cwd(), "attemptPercent");
    expect(at).toMatch(/#attemptPercent$/);
    const broken = `src/rooms/nowhere/gone.ts#attemptPercent`;
    expect(proofDrift(broken, roots)).toMatch(/moved to /);
  });

  it("an ambiguous or deleted anchor does not relocate", () => {
    expect(relocateAnchor(process.cwd(), "zzz-no-such-symbol-q7z")).toBeNull();
  });
});

describe("dark-table clocks come from the live schema", () => {
  const cols = (...names: string[]) => new Set(names);

  it("the generic convention picks created_at for entities and the event column for logs", () => {
    expect(clockForColumns("lane_pilot_attempt", cols("id", "created_at", "state"))).toBe("created_at");
    expect(clockForColumns("lane_pilot_attempt_transition", cols("id", "at"))).toBe("at");
    expect(clockForColumns("lane_pilot_stage_receipt", cols("id", "updated_at"))).toBe("updated_at");
    expect(clockForColumns("lane_pilot_cursor", cols("id", "position"))).toBe("");
  });

  it("documented overrides keep the domain clock the convention cannot pick", () => {
    expect(clockForColumns("lane_pilot_errand_episode", cols("id", "created_at"))).toBe("updated_at");
    expect(clockForColumns("lane_pilot_owner_records", cols("id", "created_at"))).toBe("updated_at");
    expect(clockForColumns("lane_pilot_regression", cols("id", "created_at"))).toBe("found_at");
    expect(clockForColumns("lane_pilot_token_daily", cols("day"))).toBe("day");
  });

  it("darkClockExpr reads the day column through strftime and counts clockless tables in full", () => {
    expect(darkClockExpr("lane_pilot_token_daily")).toContain("strftime");
    expect(darkClockExpr("lane_pilot_cursor", cols("id", "position"))).toBeNull();
    expect(darkClockExpr("lane_pilot_attempt", cols("id", "created_at"))).toBe("created_at");
    expect(darkClockExpr("lane_pilot_attempt_reasoning")).toBeNull();
  });
});

describe("pure behaviour contracts", () => {
  it("failureClass reads the machine's fault, not the task's", () => {
    expect(failureClass("empty_output", "writer changed no files; its retry was lost in a plugin reload")).toBe("harness");
    expect(failureClass("provider_error", "ENOSPC: no space left on device")).toBe("infra");
    expect(failureClass("empty_output", "writer returned no output")).toBe("provider");
    expect(failureClass("validation_failed", "check tests/x.test.ts failed")).toBe("task");
  });

  it("stage transitions follow the receipt lifecycle", () => {
    expect(stageTransition("pending", "running")).toBe(true);
    expect(stageTransition("running", "passed")).toBe(true);
    expect(stageTransition("pending", "passed")).toBe(false);
    expect(stageTransition("passed", "running")).toBe(false);
    expect(stageTransition("failed", "pending")).toBe(false);
  });

  it("attempt progress grows with elapsed work and receipts lift the phase", () => {
    const row = { state: "running", createdAt: 1_000 };
    const early = attemptPercent(row, [], 1_000 + 60_000);
    const late = attemptPercent(row, [], 1_000 + 10 * 60_000);
    expect(late).toBeGreaterThan(early);
    const receipts = [{ stageId: "verification", state: "passed", updatedAt: 2_000 }];
    expect(attemptPercent(row, receipts, 3_000)).toBeGreaterThanOrEqual(0.9);
  });
});
