import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { autoresearchThresholds, insertReceipt } from "@lane-pilot/jev";

function db() { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return openDatabase(bb); }
function seed(d: ReturnType<typeof db>, n: number, agreeAbove: number) {
  for (let i = 0; i < n; i++) {
    const p = 0.3 + (i % 7) * 0.1;
    const id = insertReceipt(d, { judgment: "test.j", version: 1, mode: "shadow", inputSha256: `h${i}`, inputChars: 10, questions: 1, status: "ok", decidedBy: "fallback", answers: { q: { kind: "choice", value: "x", top: [["x", p]], confidence: p } }, at: Date.now() - i });
    d.prepare("UPDATE lane_pilot_jev_receipt SET outcome=? WHERE id=?").run(p >= agreeAbove ? "agree" : "disagree", id);
  }
}

describe("autoresearch", () => {
  it("proposes a cut once enough labels exist, stays quiet below", () => {
    const d = db();
    seed(d, 40, 0.6);
    const [r] = autoresearchThresholds(d, { sinceMs: 0 });
    expect(r!.ready).toBe(true);
    expect(r!.suggested_p).toBeGreaterThanOrEqual(0.5);
    expect(r!.accuracy).toBeGreaterThan(r!.baseline);
    const d2 = db();
    seed(d2, 5, 0.6);
    expect(autoresearchThresholds(d2, { sinceMs: 0 })[0]!.ready).toBe(false);
  });
});
