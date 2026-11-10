/**
 * Scores a page by the design rubric (src/rooms/design-eval) at 375 and 1280 px, or compares two pages (before / after a skill change).
 *   npx tsx scripts/lp-design-eval.ts <url> [--json]
 *   npx tsx scripts/lp-design-eval.ts <url-a> <url-b>        (paired judgement: which is better, per criterion)
 */
import { chromium } from "playwright";
import { compareDesigns, designScore, mergeFrames, MEASURE_SCRIPT, pairBasis, type Measurement } from "../src/rooms/design-eval";

async function measure(url: string, shot = false): Promise<{ measurements: Measurement[]; shotPng?: string }> {
  const browser = await chromium.launch();
  try {
    const out: Measurement[] = [];
    let shotPng: string | undefined;
    for (const width of [375, 1280]) {
      const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
      await page.waitForTimeout(4000);
      // A BB plugin page lives in a frame: every frame is measured and the counts are summed.
      const frames = await Promise.all(page.frames().map((frame) => frame.evaluate(new Function(MEASURE_SCRIPT) as () => Measurement).catch(() => null)));
      out.push(mergeFrames(width, frames.filter((row): row is Measurement => row !== null)));
      if (shot && width === 1280) shotPng = (await page.screenshot({ type: "png" })).toString("base64");
    }
    return { measurements: out, ...(shotPng ? { shotPng } : {}) };
  } finally {
    await browser.close();
  }
}

const args = process.argv.slice(2).filter((arg) => arg !== "--json");
// design-pair: the paired judgement — one basis text (scores + fixed order) for the model and the person, plus a screenshot of each for the judge.
if (args[0] === "design-pair") {
  const [urlA, urlB] = args.slice(1);
  if (!urlA || !urlB) { console.error("usage: npx tsx scripts/lp-design-eval.ts design-pair <url-a> <url-b>"); process.exit(1); }
  const a = await measure(urlA, true), b = await measure(urlB, true);
  const { order, basis, comparison } = pairBasis(urlA, urlB, a.measurements, b.measurements);
  console.log(JSON.stringify({ order, basis, comparison, shots: { a: a.shotPng ?? null, b: b.shotPng ?? null } }, null, 2));
  process.exit(0);
}
if (!args.length) { console.error("usage: npx tsx scripts/lp-design-eval.ts <url> [<url-b>] [--json]"); process.exit(1); }
const a = await measure(args[0]!);
if (args[1]) {
  const result = compareDesigns(a.measurements, (await measure(args[1])).measurements);
  console.log(JSON.stringify(result, null, 2));
} else {
  const result = designScore(a.measurements);
  console.log(process.argv.includes("--json") ? JSON.stringify({ measurements: a.measurements, ...result }, null, 2)
    : [`score ${result.score}/100`, ...result.byWidth.flatMap((row) => row.criteria.map((c) => `  ${row.width}px ${c.id}: ${Math.round(c.score * 100)} (${c.detail})`))].join("\n"));
}
