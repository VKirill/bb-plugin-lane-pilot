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
 *   node scripts/lp-ui-drive.mjs <scene.json>       ui-drive: the scene against a live window
 *   node scripts/lp-ui-drive.mjs --stage <scene>    ui-stage: the same scene, steps only, screenshots for the judge and no asserts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const stageOnly = args[0] === "--stage";
const scenePath = stageOnly ? args[1] : args[0];
if (!scenePath) { console.error("usage: node scripts/lp-ui-drive.mjs [--stage] <scene.json>"); process.exit(2); }

let scene;
try { scene = JSON.parse(readFileSync(scenePath, "utf8")); } catch (cause) { console.error(`scene unreadable: ${cause.message}`); process.exit(2); }
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(root, ".agents/runs/ui", `${basename(scenePath, ".json")}-${stamp}`);
mkdirSync(outDir, { recursive: true });

let chromium;
try { ({ chromium } = await import("playwright")); } catch { console.error("playwright is not installed"); process.exit(2); }
let browser;
try { browser = await chromium.launch(); } catch (cause) { console.error(`no browser: ${cause.message}`); process.exit(2); }

const report = { scene: scenePath, url: scene.url, stage: stageOnly, widths: [], judge: scene.judge ?? null };
let failed = false;
try {
  for (const width of scene.widths ?? [375, 1280]) {
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
      if (!stageOnly) for (const check of scene.asserts ?? []) {
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
      await browser.close();
      process.exit(2);
    }
    report.widths.push(row);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
}
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log(`UI_REPORT=${join(outDir, "report.json")}`);
process.exit(failed ? 1 : 0);
