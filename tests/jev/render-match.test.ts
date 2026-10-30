import { describe, expect, it } from "vitest";
import { renderMatchJudgment } from "@lane-pilot/jev/judgments/render-match";

const n = (v: number) => ({ type: "noul" as const, noul: v });
const img = { format: "png" as const, data_base64: "AA==" };
const input = { brief: "a mug", concept: img, render: img };

describe("d.render_match", () => {
  it("fails on mismatch or visible defects", () => {
    const off = renderMatchJudgment.decide({ matches: n(0.3), defects: n(0.1) }, { match_p: 0.65, defect_p: 0.7 }, input);
    expect(off.decision?.matches).toBe(false);
    const bad = renderMatchJudgment.decide({ matches: n(0.9), defects: n(0.95) }, { match_p: 0.65, defect_p: 0.7 }, input);
    expect(bad.decision?.matches).toBe(false);
    const ok = renderMatchJudgment.decide({ matches: n(0.9), defects: n(0.05) }, { match_p: 0.65, defect_p: 0.7 }, input);
    expect(ok.decision?.matches).toBe(true);
  });
  it("whitelist state holds only the brief and refs", () => {
    const state = renderMatchJudgment.stateBuilder({ ...input, secret: "sk-x" } as never) as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["brief", "concept", "render"]);
    expect(JSON.stringify(state)).not.toContain("sk-x");
    expect(JSON.stringify(state)).not.toContain("AA==");
  });
});
