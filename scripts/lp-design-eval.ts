/**
 * Scores a page by the design rubric (src/rooms/design-eval) at 375 and 1280 px, or compares two pages (before / after a skill change).
 *   npx tsx scripts/lp-design-eval.ts <url> [--json]
 *   npx tsx scripts/lp-design-eval.ts <url-a> <url-b>        (paired judgement: which is better, per criterion)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { compareDesigns, designScore, mergeFrames, MEASURE_SCRIPT, pairBasis, readDesignCase, writeDesignCase, type Measurement } from "../src/rooms/design-eval";
import { pairUrlRefusal } from "../src/rooms/design-eval/url-guard";
import { pairUrlsRefusal } from "../src/rooms/design-eval/server";

/** `guard` (a pair that is not --local): the first address was checked by the caller, and the page itself must not lead the browser
 * to this machine or a private network either. A frame or a request straight to such an address is cut (a navigation by its
 * resolved address, any other request by its literal one). A redirect hop never reaches a route handler (checked on Chrome with
 * Playwright 1.63), so each hop is checked as it is seen and a refused one fails the whole measure before any picture is taken. */
async function measure(url: string, shot = false, guard?: { hubPorts: number[] }): Promise<{ measurements: Measurement[]; shotPng?: string }> {
  const browser = await chromium.launch();
  try {
    const out: Measurement[] = [];
    let shotPng: string | undefined;
    for (const width of [375, 1280]) {
      const page = await (await browser.newContext({ viewport: { width, height: 900 } })).newPage();
      if (guard) await page.route("**/*", async (route) => {
        const request = route.request();
        const refused = request.isNavigationRequest() ? await pairUrlsRefusal([request.url()], { hubPorts: guard.hubPorts }) : pairUrlRefusal(request.url(), { hubPorts: guard.hubPorts });
        return refused ? route.abort("blockedbyclient") : route.continue();
      });
      const hops: Promise<string | null>[] = [];
      if (guard) page.on("request", (request) => { if (request.redirectedFrom()) hops.push(pairUrlsRefusal([request.url()], { hubPorts: guard.hubPorts })); });
      await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
      await page.waitForTimeout(4000);
      const led = (await Promise.all(hops)).find(Boolean);
      if (led) throw new Error(`the page redirected the browser: ${led}`);
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

const args = process.argv.slice(2).filter((arg) => arg !== "--json" && arg !== "--local");
const local = process.argv.includes("--local");
const flagValue = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const flagArgs = args.filter((arg, index, all) => all[index - 1] !== "--save" && all[index - 1] !== "--case" && arg !== "--save" && arg !== "--case");
// --case <file>: re-score a pinned case; its bytes and rubric balance are checked before any score is printed.
// A value flag with nothing after it would be silently ignored: refuse it.
for (const flag of ["--save", "--case"]) {
  if (process.argv.includes(flag) && (process.argv.indexOf(flag) === process.argv.length - 1 || process.argv[process.argv.indexOf(flag) + 1]!.startsWith("--"))) {
    console.error(`${flag} needs a file\nusage: npx tsx scripts/lp-design-eval.ts <url> [<url-b>] [--json] [--save <case-file>] [--case <case-file>]`); process.exit(1);
  }
}
const caseFile = flagValue("--case");
if (caseFile) {
  const result = readDesignCase(readFileSync(caseFile, "utf8"));
  if (!result.ok) { console.error(result.reason); process.exit(1); }
  const scored = designScore(result.case.measurements);
  console.log(process.argv.includes("--json") ? JSON.stringify({ id: result.case.id, suiteVersion: result.case.suiteVersion, ...scored }, null, 2)
    : [`case ${result.case.id} (${result.case.suiteVersion})`, `score ${scored.score}/100`, ...scored.byWidth.flatMap((row) => row.criteria.map((c) => `  ${row.width}px ${c.id}: ${Math.round(c.score * 100)} (${c.detail})`))].join("\n"));
  process.exit(0);
}
// design-pair: the paired judgement — one basis text (scores + fixed order) for the model and the person, plus a screenshot of each for the judge.
if (flagArgs[0] === "design-pair") {
  const [urlA, urlB] = flagArgs.slice(1);
  if (!urlA || !urlB) { console.error("usage: npx tsx scripts/lp-design-eval.ts design-pair <url-a> <url-b> [--local]"); process.exit(1); }
  // Checked again here, before any browser starts: the screenshots of a refused pair are never taken.
  const fromUrl = (value: string | undefined): number[] => { try { const url = new URL(value ?? ""); return [Number(url.port || (url.protocol === "https:" ? 443 : 80))]; } catch { return []; } };
  const hubPorts = [...fromUrl(process.env.BB_SERVER_URL), Number(process.env.BB_HOST_DAEMON_PORT), Number(process.env.PORT)].filter((n) => Number.isInteger(n) && n > 0);
  const refused = await pairUrlsRefusal([urlA, urlB], { local, hubPorts });
  if (refused) { console.error(refused); process.exit(1); }
  const guard = local ? undefined : { hubPorts };
  const a = await measure(urlA, true, guard), b = await measure(urlB, true, guard);
  const { order, basis, comparison } = pairBasis(urlA, urlB, a.measurements, b.measurements);
  console.log(JSON.stringify({ order, basis, comparison, shots: { a: a.shotPng ?? null, b: b.shotPng ?? null } }, null, 2));
  process.exit(0);
}
if (!flagArgs.length) { console.error("usage: npx tsx scripts/lp-design-eval.ts <url> [<url-b>] [--json] [--save <case-file>] [--case <case-file>]"); process.exit(1); }
const a = await measure(flagArgs[0]!);
// --save <file>: pin this measurement set as a case (id, suite version, sha256 of its bytes).
const saveFile = flagValue("--save");
if (saveFile) writeFileSync(saveFile, writeDesignCase({ id: flagArgs[0]!, measurements: a.measurements }));
if (flagArgs[1]) {
  const result = compareDesigns(a.measurements, (await measure(flagArgs[1])).measurements);
  console.log(JSON.stringify(result, null, 2));
} else {
  const result = designScore(a.measurements);
  console.log(process.argv.includes("--json") ? JSON.stringify({ measurements: a.measurements, ...result }, null, 2)
    : [`score ${result.score}/100`, ...result.byWidth.flatMap((row) => row.criteria.map((c) => `  ${row.width}px ${c.id}: ${Math.round(c.score * 100)} (${c.detail})`))].join("\n"));
}
