/**
 * Design evaluation (SMA atlas D2-12: «Design evaluation rubric», «Paired design judgement»). A rubric of features a browser can measure on
 * a real page, at a phone and a desktop width, so a design-lead result or a skill change is scored by code, not by a model's taste:
 * no horizontal overflow, readable text contrast, tap targets of at least 44 px on the phone, no text under 12 px, exactly one H1, and a
 * small set of spacing values. `MEASURE_SCRIPT` runs in the page (scripts/lp-design-eval.mjs drives it with Playwright); the scoring and the
 * pairwise comparison are pure.
 */
export type Measurement = {
  width: number;
  overflowPx: number;
  /** Text elements and how many fall under WCAG AA contrast (4.5, or 3 for large text). */
  textElements: number; lowContrast: number;
  /** Interactive elements and how many are under 44 px in their smaller dimension (only judged at a phone width). */
  targets: number; smallTargets: number;
  tinyText: number;
  h1: number;
  /** Distinct margin/padding/gap values used. */
  spacingValues: number;
};

export type Criterion = { id: string; label: string; score: number; detail: string };
export const RUBRIC = ["overflow", "contrast", "targets", "tiny_text", "one_h1", "spacing"] as const;

const share = (bad: number, all: number) => (all ? bad / all : 0);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/** Every criterion scored 0..1 at one width, with what was measured. */
export function scoreMeasurement(m: Measurement): Criterion[] {
  const phone = m.width < 600;
  return [
    { id: "overflow", label: "no horizontal overflow", score: m.overflowPx <= 1 ? 1 : 0, detail: `${m.overflowPx}px wider than the viewport` },
    { id: "contrast", label: "text contrast AA", score: clamp01(1 - share(m.lowContrast, m.textElements) * 5), detail: `${m.lowContrast} of ${m.textElements} text elements under AA` },
    { id: "targets", label: "tap targets ≥ 44 px", score: phone ? clamp01(1 - share(m.smallTargets, m.targets) * 2) : 1, detail: phone ? `${m.smallTargets} of ${m.targets} under 44 px` : "desktop: not judged" },
    { id: "tiny_text", label: "no text under 12 px", score: m.tinyText === 0 ? 1 : clamp01(1 - m.tinyText / 10), detail: `${m.tinyText} elements under 12 px` },
    { id: "one_h1", label: "exactly one H1", score: m.h1 === 1 ? 1 : 0, detail: `${m.h1} H1` },
    { id: "spacing", label: "a small spacing scale", score: m.spacingValues <= 12 ? 1 : clamp01(1 - (m.spacingValues - 12) / 20), detail: `${m.spacingValues} distinct spacing values` },
  ];
}

/** The page's score: the mean of every criterion at every width, 0..100. */
export function designScore(measurements: readonly Measurement[]): { score: number; byWidth: Array<{ width: number; criteria: Criterion[] }> } {
  const byWidth = measurements.map((m) => ({ width: m.width, criteria: scoreMeasurement(m) }));
  const all = byWidth.flatMap((row) => row.criteria.map((c) => c.score));
  return { score: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) : 0, byWidth };
}

/** Paired judgement: per criterion and width, which of two versions is better (or equal), and the overall winner. */
export function compareDesigns(a: readonly Measurement[], b: readonly Measurement[]): { winner: "a" | "b" | "tie"; a: number; b: number; changes: Array<{ width: number; id: string; a: number; b: number }> } {
  const sa = designScore(a), sb = designScore(b);
  const changes = sa.byWidth.flatMap((row) => {
    const other = sb.byWidth.find((item) => item.width === row.width);
    return other ? row.criteria.flatMap((c) => { const o = other.criteria.find((item) => item.id === c.id)!; return Math.abs(o.score - c.score) > 0.001 ? [{ width: row.width, id: c.id, a: Math.round(c.score * 100) / 100, b: Math.round(o.score * 100) / 100 }] : []; }) : [];
  });
  return { winner: sa.score === sb.score ? "tie" : sa.score > sb.score ? "a" : "b", a: sa.score, b: sb.score, changes };
}

/** One measurement of a page from the measurements of its frames (a BB plugin page is a frame): counts summed, the widest overflow. */
export function mergeFrames(width: number, frames: readonly Measurement[]): Measurement {
  const sum = (key: keyof Measurement) => frames.reduce((total, row) => total + row[key], 0);
  return { width, overflowPx: Math.max(0, ...frames.map((row) => row.overflowPx)), textElements: sum("textElements"), lowContrast: sum("lowContrast"),
    targets: sum("targets"), smallTargets: sum("smallTargets"), tinyText: sum("tinyText"), h1: sum("h1"), spacingValues: Math.max(0, ...frames.map((row) => row.spacingValues)) };
}

/** Runs in the page (as the body of a function): returns a Measurement for the current viewport. */
export const MEASURE_SCRIPT = `
const doc = document.documentElement, width = window.innerWidth;
const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
// Any CSS colour (oklch, color(), rgb) to [r, g, b, a] through a 1x1 canvas: the browser does the conversion.
const paint = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
const rgb = (c) => { paint.clearRect(0, 0, 1, 1); paint.fillStyle = "rgba(0,0,0,0)"; paint.fillStyle = c; paint.fillRect(0, 0, 1, 1); const d = paint.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const bg = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c[3] > 0.5) return c; } return [255, 255, 255, 1]; };
const texts = [...document.querySelectorAll("body *")].filter((el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1));
let lowContrast = 0, tinyText = 0;
for (const el of texts) {
  const s = getComputedStyle(el), size = parseFloat(s.fontSize), fg = lum(rgb(s.color)), back = lum(bg(el));
  const ratio = (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  if (ratio < (size >= 18.66 || (size >= 14 && Number(s.fontWeight) >= 700) ? 3 : 4.5)) lowContrast++;
  if (size < 12) tinyText++;
}
const targets = [...document.querySelectorAll("a[href], button, input, select, textarea, [role=button], [role=tab]")].filter(visible);
const smallTargets = targets.filter((el) => { const r = el.getBoundingClientRect(); return Math.min(r.width, r.height) < 44; }).length;
const spacing = new Set();
for (const el of [...document.querySelectorAll("body *")].slice(0, 3000)) { const s = getComputedStyle(el); for (const v of [s.marginTop, s.marginBottom, s.paddingTop, s.paddingLeft, s.rowGap]) if (v && v !== "0px" && v !== "normal") spacing.add(v); }
return { width, overflowPx: Math.max(0, doc.scrollWidth - doc.clientWidth), textElements: texts.length, lowContrast, targets: targets.length, smallTargets, tinyText, h1: document.querySelectorAll("h1").length, spacingValues: spacing.size };
`;
