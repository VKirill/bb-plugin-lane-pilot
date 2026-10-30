import { box, defineJudgment, noul, noulOf } from "../registry";
import type { JevAsset, JevBox } from "../types";

/**
 * Jev looks at the screenshots a page/design validator takes (B1 of the docs audit, revised by the live probe on
 * jev-latest): Jev confidently catches content cut off or overflowing the viewport (noul 0.8–0.99 on broken pages,
 * 0.04–0.09 on clean ones), but misses semantic breakage (a heading hidden under a form scored «clean» — the model does
 * not know what should be there). So this judgment asks only the geometric question it answers well; the DOM probe in
 * the validator is the main gate, and semantic review goes to a vision-capable agent.
 */
export const UI_SHOTS_ID = "ui.page_shots";

export type UiShot = { name: string; format: "png" | "jpg" | "jpeg"; data_base64: string };
export type UiShotsInput = { url: string; brief?: string; shots: UiShot[] };
/** `cut` — Jev is sure something overflows; `uncertain` — between the bands, send to the reviewing agent. */
export type UiShotsDecision = { verdict: "clean" | "uncertain" | "cut"; worst: number; worstShot: string | null; box?: JevBox };

export const MAX_SHOTS = 4;
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const ref = (index: number) => `shot-${index}-x7q`;

export const uiShotsJudgment = defineJudgment<UiShotsInput, UiShotsDecision>({
  id: UI_SHOTS_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 20_000,
  stateBuilder: (input) => ({
    page: clip(input.url, 300),
    shots: Object.fromEntries(input.shots.slice(0, MAX_SHOTS).map((shot, i) => [clip(shot.name, 40) || `shot${i}`, ref(i)])),
  }),
  assets: (input) => Object.fromEntries(input.shots.slice(0, MAX_SHOTS).map((shot, i) => [ref(i), { type: "image", format: shot.format, data_base64: shot.data_base64 } satisfies JevAsset])),
  questions: (input) => {
    const out: Record<string, ReturnType<typeof noul> | ReturnType<typeof box>> = {};
    input.shots.slice(0, MAX_SHOTS).forEach((shot, i) => {
      const name = clip(shot.name, 40) || `shot${i}`;
      out[`s${i}`] = noul(
        `In the screenshot \`shots.${name}\` of the page \`page\`, is any content cut off at the viewport edge or overflowing horizontally — text or blocks clipped by the right edge, a horizontal scrollbar, elements rendered partly off-screen? Judge only what is visible, not whether the page's content is correct.`,
        { true: "content visibly overflows or is clipped by the viewport edge", false: "everything fits inside the viewport" },
      );
      out[`b${i}`] = box(`the element that is clipped or overflowing in \`shots.${name}\`; the whole viewport when nothing overflows`);
    });
    return out;
  },
  thresholds: {
    cut_p: { default: 0.7, min: 0.3, max: 0.99, about: "P(overflow) on any shot that counts as «cut off» (probe: broken 0.8+, clean <0.1)" },
    unsure_p: { default: 0.3, min: 0.05, max: 0.8, about: "below this the shot reads clean; between it and cut_p the verdict is uncertain" },
  },
  decide(answers, t, input) {
    let worst = 0, worstShot: string | null = null, worstIndex = -1;
    input.shots.slice(0, MAX_SHOTS).forEach((shot, i) => {
      const p = noulOf(answers, `s${i}`) ?? 0;
      if (p > worst) { worst = p; worstShot = shot.name; worstIndex = i; }
    });
    const boxAnswer = worstIndex >= 0 ? answers[`b${worstIndex}`] : undefined;
    const verdict = worst >= t.cut_p! ? "cut" : worst >= t.unsure_p! ? "uncertain" : "clean";
    return { decision: { verdict, worst: Math.round(worst * 1000) / 1000, worstShot, ...(boxAnswer?.type === "box" ? { box: boxAnswer.box } : {}) } };
  },
  fallback: () => ({ verdict: "clean", worst: 0, worstShot: null }),
  describe: (d) => d.verdict === "clean" ? `clean (worst ${d.worst})` : `${d.verdict} on ${d.worstShot} (p=${d.worst})`,
});
