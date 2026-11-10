#!/usr/bin/env node
/**
 * ui-drive — a live window run (SMA map: ui-drive, ui-stage, Live run exit law, Decidable half of the scene). A scene is a JSON file:
 *
 *   { "url": "http://127.0.0.1:4173/", "widths": [375, 1280], "steps": [{ "click": "text=Задачи" }, { "wait": 500 }],
 *     "asserts": [{ "selector": "h1", "text": "Lane Pilot" }, { "noOverflow": true }, { "selector": "[data-task-card]", "minCount": 1 }],
 *     "judge": "Is the task board readable at this width?" }
 *
 * The decidable half (asserts) is checked by code at every width; the rest — the question in `judge` — goes with the screenshots to a
 * judge, never decided here. The exit law: 0 every assert held, 1 an assert failed, 2 the scene could not run (no browser, the page did
 * not load). The report and the screenshots go to .agents/runs/ui/<scene>-<stamp>/.
 *
 *   node scripts/lp-ui-drive.mjs <scene.json>            ui-drive: the scene against a live window
 *   node scripts/lp-ui-drive.mjs --stage <scene>         ui-stage: the same scene, steps only, screenshots for the judge and no asserts
 *   node scripts/lp-ui-drive.mjs --stage --tree <path> <scene>
 *                                                      ui-stage: raise this tree's built window on its own port, run the scene,
 *                                                      take the window down (also on SIGINT); a tree without a fresh dist/app.js
 *                                                      is refused before a browser starts. --trees a,b stages several trees in turn,
 *                                                      --trees kit the checkout plus its git worktrees, --port overrides the address.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SceneUsage, kitOfTrees, parseSceneArgs, serveTree, treeBuildError, waitForPage } from "./lib/ui-scene.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let args;
try { args = parseSceneArgs(process.argv.slice(2)); }
catch (cause) { console.error(cause instanceof SceneUsage ? cause.message : String(cause)); process.exit(2); }

let scene;
try { scene = JSON.parse(readFileSync(args.scene, "utf8")); } catch (cause) { console.error(`scene unreadable: ${cause.message}`); process.exit(2); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, ".agents/runs/ui", `${basename(args.scene, ".json")}-${stamp}`);
mkdirSync(outDir, { recursive: true });

// The kit word expands before anything is built; every tree is checked for a fresh build before a browser is launched.
const trees = args.trees.flatMap((tree) => tree === "kit" ? kitOfTrees(root) : [tree]);
for (const tree of trees) {
  const error = treeBuildError(tree);
  if (error) { console.error(error); process.exit(2); }
}

let staged = null;
const takeDown = async () => { const held = staged; staged = null; if (held) await held.close().catch(() => {}); };
process.on("SIGINT", () => { takeDown().finally(() => process.exit(2)); });

const report = { scene: args.scene, url: scene.url, stage: args.stage, tree: trees[0] ?? null, widths: [], judge: scene.judge ?? null };
let failed = false;
let browser = null;
try {
  if (trees.length) {
    staged = await serveTree(trees[0], { port: args.port });
    report.url = staged.url;
    console.log(`STAGE_URL=${staged.url}`);
    if (!(await waitForPage(staged.url))) { await takeDown(); console.error(`the staged window did not answer on ${staged.url}`); process.exit(2); }
    scene = { ...scene, url: staged.url };
  }
  let chromium;
  try { ({ chromium } = await import("playwright")); } catch { await takeDown(); console.error("playwright is not installed"); process.exit(2); }
  try { browser = await chromium.launch(); } catch (cause) { await takeDown(); console.error(`no browser: ${cause.message}`); process.exit(2); }
  const widths = args.width ? [args.width] : scene.widths ?? [375, 1280];
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: scene.height ?? 900 } });
    const row = { width, asserts: [], screenshot: null, error: null };
    try {
      const answer = await page.goto(scene.url, { waitUntil: "networkidle", timeout: 30_000 });
      if (!answer || answer.status() >= 400) throw new Error(`the page answered ${answer?.status() ?? "nothing"}`);
      for (const step of scene.steps ?? []) {
        if (step.click) await page.click(step.click, { timeout: 10_000 });
        if (step.fill) await page.fill(step.fill.selector, step.fill.value);
        if (step.wait) await page.waitForTimeout(step.wait);
      }
      row.screenshot = join(outDir, `w${width}.png`);
      await page.screenshot({ path: row.screenshot, fullPage: true });
      if (!args.stage) for (const check of scene.asserts ?? []) {
        let ok = true, detail = "";
        if (check.noOverflow) {
          const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          ok = over <= 1; detail = `horizontal overflow ${over}px`;
        } else {
          const items = page.locator(check.selector);
          const count = await items.count();
          if (check.minCount !== undefined) { ok = count >= check.minCount; detail = `${count} of at least ${check.minCount}`; }
          else if (check.text !== undefined) { const text = count ? await items.first().innerText() : ""; ok = text.includes(check.text); detail = `«${text.slice(0, 80)}»`; }
          else { ok = count > 0 && await items.first().isVisible(); detail = ok ? "visible" : "not visible"; }
        }
        row.asserts.push({ ...check, ok, detail });
        if (!ok) failed = true;
      }
    } catch (cause) {
      row.error = cause.message;
      writeFileSync(join(outDir, "report.json"), JSON.stringify({ ...report, widths: [...report.widths, row] }, null, 2));
      console.error(`width ${width}: ${cause.message}`);
      await takeDown();
      await browser?.close();
      process.exit(2);
    }
    report.widths.push(row);
    await page.close();
  }
} finally {
  await takeDown();
  await browser?.close().catch(() => {});
}
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`UI_REPORT=${join(outDir, "report.json")}`);
process.exit(failed ? 1 : 0);
