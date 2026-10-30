import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { choice, defineJudgment, insertReceipt, judgmentFingerprint, listJudgments, noul, noulOf, resolveThresholds, calibrateReceipts, JEV_CALIBRATED_KEY, type JevQuestion } from "@lane-pilot/jev";
import "../../src/rooms/jev/judgments";

const makeUrgency = (wording: string) => defineJudgment<{ text: string }, "urgent" | "calm">({
  id: `test.calib_${wording.length}`, version: 1, defaultMode: "active", timeoutMs: 1000,
  stateBuilder: (input) => ({ text: input.text }),
  questions: (): Record<string, JevQuestion> => ({ urgent: noul(wording), kind: choice("What is it?", { bug: "a defect", ask: "a question" }) }),
  thresholds: { min_p: { default: 0.8, min: 0.5, max: 0.99, about: "yes needed" } },
  decide: (answers, t) => ({ decision: (noulOf(answers, "urgent") ?? 0) >= t.min_p! ? "urgent" : "calm" }),
  fallback: () => "calm",
  describe: (d) => d,
});

function database() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("calibrated thresholds", () => {
  it("a saved calibration applies while the fingerprint matches; a reworded question falls back to defaults", () => {
    const j1 = makeUrgency("Is this urgent?"), j2 = makeUrgency("Is this pressing?");
    expect(judgmentFingerprint(j1)).not.toBe(judgmentFingerprint(j2));
    const settings = { [JEV_CALIBRATED_KEY]: JSON.stringify({ [j1.id]: { fingerprint: judgmentFingerprint(j1), model: "jev-1.14.0", thresholds: { min_p: 0.9 } } }) };
    expect(resolveThresholds(j1, settings, "jev-1.14.0").min_p).toBe(0.9);
    // A route suffix is not a different model: the alias-less base id is what binds.
    expect(resolveThresholds(j1, settings, "jev-1.14.0:stable").min_p).toBe(0.9);
    // The model moved under the same wording: the certified value is refused, the default stands until a recalibration.
    expect(resolveThresholds(j1, settings, "jev-1.15.0").min_p).toBe(0.8);
    // An entry saved before model binding (no model field) does not apply either.
    const unbound = { [JEV_CALIBRATED_KEY]: JSON.stringify({ [j1.id]: { fingerprint: judgmentFingerprint(j1), thresholds: { min_p: 0.9 } } }) };
    expect(resolveThresholds(j1, unbound, "jev-1.14.0").min_p).toBe(0.8);
    // Reworded without recalibration: the certified value is refused, the default stands.
    const stale = { [JEV_CALIBRATED_KEY]: JSON.stringify({ [j1.id]: { fingerprint: judgmentFingerprint(j2), model: "jev-1.14.0", thresholds: { min_p: 0.9 } } }) };
    expect(resolveThresholds(j1, stale, "jev-1.14.0").min_p).toBe(0.8);
  });
});

describe("calibration report", () => {
  it("verdicts gate, sort-only and dead from the labeled outcomes", () => {
    const db = database(), now = Date.now();
    const put = (judgment: string, n: number, outcome: (i: number) => string | null) => {
      for (let i = 0; i < n; i++) {
        const id = insertReceipt(db, { judgment, version: 1, mode: "active", inputSha256: `h${judgment}${i}`, inputChars: 10, questions: 1, status: "ok", decidedBy: judgment.startsWith("e.") ? "escalated" : "jev", answers: { q: { kind: "choice", value: "a", top: [["a", 0.9]], confidence: 0.8 } }, at: now - i });
        const label = outcome(i);
        if (label) db.prepare("UPDATE lane_pilot_jev_receipt SET outcome=? WHERE id=?").run(label, id);
      }
    };
    put("a.gate", 12, () => "agree");
    put("b.sort", 12, (i) => (i % 3 === 0 ? "disagree" : "agree"));
    put("c.dead", 12, () => "disagree");
    put("d.unlabeled", 5, () => null);
    // 19 escalated receipts all disagreeing and zero jev-decided labels: the border zone is bad, but it is the cases Jev
    // refused that land there — no dead verdict without confident labels.
    put("e.border", 19, () => "disagree");
    const report = calibrateReceipts(db, { sinceMs: now - 1000, judgments: listJudgments(), minLabeled: 10 });
    const at = (id: string) => report.find((row) => row.judgment === id)!;
    expect(at("a.gate").verdict).toBe("gate");
    expect(at("a.gate").accuracy).toBe(1);
    expect(at("a.gate").meanConfidence).toBe(0.8);
    expect(at("b.sort").verdict).toBe("sort-only");
    expect(at("c.dead").verdict).toBe("dead");
    expect(at("d.unlabeled").insufficient).toBe(true);
    expect(at("d.unlabeled").verdict).toBe("sort-only");
    const border = at("e.border");
    expect(border.verdict).not.toBe("dead");
    expect(border.labeled).toBe(0);
    expect(border.borderLabeled).toBe(19);
    expect(border.borderDisagree).toBe(19);
  });
});

describe("calibration regression", () => {
  it("every registered judgment keeps the fingerprint the calibration certified — a reword without recalibration is red", async () => {
    const { readFileSync, existsSync } = await import("node:fs");
    const fixture = new URL("./calibrated-thresholds.json", import.meta.url).pathname;
    expect(existsSync(fixture)).toBe(true);
    const saved = JSON.parse(readFileSync(fixture, "utf8")) as Record<string, { fingerprint: string; thresholds: Record<string, number> }>;
    const known = new Map(listJudgments().map((j) => [j.id, j]));
    for (const [id, entry] of Object.entries(saved)) {
      const judgment = known.get(id);
      expect(judgment, `${id}: a judgment the fixture certifies is missing from the registry`).toBeTruthy();
      expect(judgmentFingerprint(judgment!)).toBe(entry.fingerprint);
    }
  });
});
