import { defineJudgment, noul, noulOf } from "../registry";
import type { JevAsset } from "../types";

/**
 * Does the rendered 3D asset match the concept it was built from (B5; images as criteria). `validate3d` counts n-gons
 * and tris; this asks the preview render whether it is the thing the concept art shows — catches «valid mesh, wrong
 * object». Shadow-only material until calibrated: the coordinator's B1 probe proved geometric questions land well, but
 * style fit is subjective, so the default bar is high and the receipt carries the doubt.
 */
export const RENDER_MATCH_ID = "d.render_match";

export type RenderMatchInput = { brief: string; concept: { format: "png" | "jpg" | "jpeg"; data_base64: string }; render: { format: "png" | "jpg" | "jpeg"; data_base64: string } };
export type RenderMatchDecision = { matches: boolean; matchP: number; defectsP: number };

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const renderMatchJudgment = defineJudgment<RenderMatchInput, RenderMatchDecision>({
  id: RENDER_MATCH_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 20_000,
  stateBuilder: (input) => ({ brief: clip(input.brief, 800), concept: "concept-ref-3x", render: "render-ref-3x" }),
  assets: (input) => ({
    "concept-ref-3x": { type: "image", format: input.concept.format, data_base64: input.concept.data_base64 } satisfies JevAsset,
    "render-ref-3x": { type: "image", format: input.render.format, data_base64: input.render.data_base64 } satisfies JevAsset,
  }),
  questions: () => ({
    matches: noul(
      "`concept` is the concept art for the asset (`brief`); `render` is the render of the 3D model that was built. Is the rendered model the same object, same proportions and silhouette — ignoring surface finish and lighting?",
      { true: "same object, silhouette matches the concept", false: "different object, wrong proportions, or parts missing" },
    ),
    defects: noul(
      "Does `render` show obvious render or mesh defects — holes, z-fighting, visible seams, black or missing surfaces?",
      { true: "visible defects", false: "clean render" },
    ),
  }),
  thresholds: {
    match_p: { default: 0.65, min: 0.4, max: 0.95, about: "p(matches) needed to accept the render" },
    defect_p: { default: 0.7, min: 0.4, max: 0.95, about: "p(defects) that alone fails the render" },
  },
  decide(answers, t) {
    const matchP = Math.round((noulOf(answers, "matches") ?? 1) * 1000) / 1000;
    const defectsP = Math.round((noulOf(answers, "defects") ?? 0) * 1000) / 1000;
    return { decision: { matches: matchP >= t.match_p! && defectsP < t.defect_p!, matchP, defectsP } };
  },
  fallback: () => ({ matches: true, matchP: 1, defectsP: 0 }),
  describe: (d) => d.matches ? `matches (p=${d.matchP})` : `off (match p=${d.matchP}, defects p=${d.defectsP})`,
});
