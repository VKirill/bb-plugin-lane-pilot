#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { collectPanelGeometry } from "./geometry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = JSON.parse(readFileSync(join(root, "src/bundled-agents.json"), "utf8"));
const profile = bundled["dev-orchestrator"];
if (!profile?.prompt || !Array.isArray(profile.tools) || profile.prompt.length < 1000) {
  throw new Error("bundled-agents.json must contain the full dev-orchestrator profile");
}

const VIEWPORTS = [375, 768, 1200, 1280, 1440];
const PANEL_WIDTHS = { 375: 343, 768: 520, 1200: 632, 1280: 632, 1440: 720 };
const LOCALES = ["en", "ru"];
const copy = {
  en: { agents: "Agents", instructions: "Instructions", name: "Name and purpose", profile: "Profile", resources: "Resources" },
  ru: { agents: "Агенты", instructions: "Инструкции", name: "Название и назначение", profile: "Профиль", resources: "Ресурсы" },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageHtml(locale) {
  const l = copy[locale];
  const tools = profile.tools.map((name) => `<li class="min-w-0"><label class="flex min-w-0 items-center gap-2 text-sm"><input type="checkbox" class="size-4 shrink-0" checked /><span class="min-w-0 break-all">${escapeHtml(name)}</span></label></li>`).join("");
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body{margin:0;height:100%;}
  fieldset{min-inline-size:min-content;}
  .fix fieldset,[data-testid="owned-settings"],.fix section{min-inline-size:0;min-width:0;max-width:100%;}
  textarea,input,select,button[role="combobox"]{box-sizing:border-box;min-width:0;max-width:100%;width:100%;}
  textarea{overflow-wrap:anywhere;word-break:break-word;}
</style>
</head>
<body class="bg-white text-neutral-900">
<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row" data-testid="project-picker" data-locale="${locale}">
  <nav class="hidden w-[13.5rem] shrink-0 flex-col border-r md:flex" data-testid="scope-rail"><button class="h-8 w-full">${l.agents}</button></nav>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full min-w-0 max-w-5xl space-y-6 px-4 py-5" id="content-column">
        <section class="fix min-w-0 max-w-full space-y-6" style="min-inline-size:0" data-testid="owned-settings">
          <div class="min-w-0 space-y-1">
            <h1 class="text-xl font-medium">${l.agents}</h1>
            <p class="text-sm text-neutral-500">${locale === "ru" ? "Здесь правится текст профиля." : "Edit the profile text here."}</p>
          </div>
          <fieldset class="min-w-0 max-w-full space-y-6" style="min-inline-size:0">
            <section class="min-w-0 max-w-full space-y-2">
              <h2 class="text-sm font-medium">${l.profile}</h2>
              <label class="text-sm" for="owned-agent">${l.profile}</label>
              <select id="owned-agent" class="min-h-11 min-w-0 w-full max-w-full box-border"><option>${escapeHtml(profile.displayName)}</option></select>
              <label class="text-sm" for="agent-description">${l.name}</label>
              <input id="agent-description" class="min-h-11 min-w-0 w-full max-w-full box-border" value="${escapeHtml(profile.displayName + " — " + profile.tools[0])}" />
            </section>
            <section class="min-w-0 max-w-full space-y-2">
              <h2 class="text-sm font-medium">${l.instructions}</h2>
              <label class="text-sm" for="agent-prompt">${l.instructions}</label>
              <textarea id="agent-prompt" class="min-h-64 min-w-0 w-full max-w-full box-border rounded-md border p-3 text-sm" style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(profile.prompt)}</textarea>
            </section>
            <section class="min-w-0 max-w-full space-y-2" data-testid="agent-resource-tools">
              <h2 class="text-sm font-medium">${l.resources}</h2>
              <ul class="max-h-40 min-w-0 space-y-1 overflow-y-auto" role="list">${tools}</ul>
            </section>
          </fieldset>
        </section>
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

const server = createServer((req, res) => {
  const locale = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("locale") === "ru" ? "ru" : "en";
  const html = pageHtml(locale);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();
const results = [];
const outDir = join(root, ".bb/chats/thr_guc48rx8p5/artifacts/layout");
mkdirSync(outDir, { recursive: true });

try {
  for (const locale of LOCALES) {
    for (const width of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/?locale=${locale}`, { waitUntil: "networkidle" });
      const panelWidth = PANEL_WIDTHS[width];
      await page.addStyleTag({ content: `#content-column{max-width:${panelWidth}px !important;width:${panelWidth}px !important;}` });
      const measure = await page.evaluate(collectPanelGeometry);
      const shot = join(outDir, `${locale}-${width}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      results.push({ locale, width, ...measure, screenshot: shot });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(outDir, "geometry.json"), JSON.stringify(results, null, 2));
const failed = results.filter((row) => !row.ok);
for (const row of results) {
  console.log(`${row.locale} ${row.width} section ${row.section.clientWidth}/${row.section.scrollWidth} fieldset ${row.fieldset.clientWidth}/${row.fieldset.scrollWidth} controls ${row.controlOverflow.length} overflowNodes ${row.overflowNodes.length} ${row.ok ? "ok" : "FAIL"}`);
}
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
