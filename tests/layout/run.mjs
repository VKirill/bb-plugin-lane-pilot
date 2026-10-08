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

const CASES = [
  { width: 375, sidebar: 0, theme: "light" },
  { width: 375, sidebar: 0, theme: "dark" },
  { width: 768, sidebar: 320, theme: "light" },
  { width: 768, sidebar: 320, theme: "dark" },
  { width: 1200, sidebar: 0, theme: "light" },
  { width: 1200, sidebar: 0, theme: "dark" },
];
const LOCALES = ["en", "ru"];
const copy = {
  en: {
    agents: "Agents",
    instructions: "Instructions",
    name: "Name and purpose",
    profile: "Profile setup",
    selectedProfile: "Selected profile",
    resources: "Resources",
    tools: "Allowed tools",
    skills: "Profile skills",
    selected: "Selected",
    inherit: "Inherit",
    search: "Search",
    basic: "Basic",
    advanced: "Advanced",
    count: (n) => `${n} selected`,
    unknown: "Saved",
    unknownHelp: "Saved names that are missing from the current list stay until you clear them.",
  },
  ru: {
    agents: "Агенты",
    instructions: "Инструкции",
    name: "Название и назначение",
    profile: "Настройка профиля",
    selectedProfile: "Выбранный профиль",
    resources: "Ресурсы",
    tools: "Разрешённые инструменты",
    skills: "Навыки профиля",
    selected: "Выбрано",
    inherit: "Наследовать",
    search: "Поиск",
    basic: "Основные",
    advanced: "Расширенные",
    count: (n) => `Выбрано: ${n}`,
    unknown: "Сохранено",
    unknownHelp: "Сохранённые имена вне текущего списка остаются, пока их не снимете.",
  },
};

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pageHtml(locale, theme) {
  const l = copy[locale];
  const known = new Set(["Read", "Edit", "Bash"]);
  const listed = [...new Set([...profile.tools, "ghost-imported-tool"])];
  const tools = listed.map((name) => {
    const unknown = known.has(name) ? "" : `<span class="shrink-0 rounded-md border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 text-[10px] leading-none text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800">${l.unknown}</span>`;
    return `<li class="min-w-0 px-2.5 py-2"><label class="flex min-w-0 items-start gap-2 text-sm"><input type="checkbox" class="mt-0.5 size-4 shrink-0" checked /><span class="min-w-0 flex-1 break-all">${escapeHtml(name)}</span>${unknown}</label></li>`;
  }).join("");
  const dark = theme === "dark";
  return `<!doctype html>
<html lang="${locale}" class="${dark ? "dark" : ""}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={darkMode:'class'}</script>
<style>
  html,body{margin:0;height:100%;}
  fieldset{min-inline-size:min-content;}
  .fix fieldset,[data-testid="owned-settings"],.fix section{min-inline-size:0;min-width:0;max-width:100%;}
  textarea,input,select,button[role="combobox"]{box-sizing:border-box;min-width:0;max-width:100%;width:100%;}
  textarea{overflow-wrap:anywhere;word-break:break-word;}
</style>
</head>
<body class="${dark ? "bg-neutral-950 text-neutral-100" : "bg-white text-neutral-900"}">
<div class="flex h-full min-h-0 min-w-0" data-testid="bb-shell">
  <aside id="bb-sidebar" class="hidden shrink-0 border-r ${dark ? "border-neutral-800 bg-neutral-900" : "border-neutral-200 bg-neutral-50"}" data-testid="bb-sidebar"></aside>
  <div class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row" data-testid="project-picker" data-locale="${locale}" data-theme="${theme}">
    <nav class="hidden w-[13.5rem] shrink-0 flex-col border-r ${dark ? "border-neutral-800" : ""}" data-testid="scope-rail"><button class="h-8 w-full">${l.agents}</button></nav>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full min-w-0 max-w-5xl space-y-6 px-4 py-5" id="content-column">
          <section class="fix min-w-0 max-w-full space-y-6" style="min-inline-size:0" data-testid="owned-settings">
            <div class="min-w-0 space-y-1">
              <h1 class="text-xl font-medium">${l.agents}</h1>
              <p class="text-sm text-neutral-500">${locale === "ru" ? "Здесь правится текст профиля." : "Edit the profile text here."}</p>
            </div>
            <div class="flex items-end gap-2" data-testid="settings-toolbar">
              <div class="min-w-0 flex-1 space-y-1">
                <label class="text-sm" for="settings-search">${l.search}</label>
                <input id="settings-search" class="h-9 min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" placeholder="${l.search}" />
              </div>
              <div class="flex shrink-0 gap-1" data-testid="settings-depth">
                <button type="button" class="h-9 rounded-md border px-4 text-sm">${l.basic}</button>
                <button type="button" class="h-9 rounded-md border px-4 text-sm">${l.advanced}</button>
              </div>
            </div>
            <details class="min-w-0 max-w-full" data-testid="disclosure-closed">
              <summary class="flex h-9 w-full cursor-pointer list-none items-center gap-2 rounded-md ${dark ? "bg-neutral-800" : "bg-neutral-100"} px-2.5 text-sm">${l.advanced}</summary>
            </details>
            <details open class="min-w-0 max-w-full" data-testid="disclosure-open">
              <summary class="flex h-9 w-full cursor-pointer list-none items-center gap-2 rounded-md ${dark ? "bg-neutral-800" : "bg-neutral-100"} px-2.5 text-sm">${l.advanced}</summary>
              <div class="ml-2 mt-2 space-y-2 border-l ${dark ? "border-neutral-700" : "border-neutral-300"} pl-3">
                <p class="text-sm">${locale === "ru" ? "Открытое содержимое отделено." : "Open content is inset."}</p>
                <input class="h-9 min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" />
              </div>
            </details>
            <fieldset class="min-w-0 max-w-full space-y-6" style="min-inline-size:0">
              <section class="min-w-0 max-w-full rounded-lg border ${dark ? "border-neutral-800 bg-neutral-900" : "border-neutral-200 bg-white"}">
                <div class="px-3 pt-3"><h2 class="text-sm font-medium">${l.profile}</h2></div>
                <div class="space-y-3 px-3 pb-3 pt-2">
                  <label class="text-sm" for="owned-agent">${l.selectedProfile}</label>
                  <select id="owned-agent" class="h-9 min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}"><option>${escapeHtml(profile.displayName)}</option></select>
                  <label class="text-sm" for="agent-description">${l.name}</label>
                  <input id="agent-description" class="h-9 min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" value="${escapeHtml(profile.displayName + " — " + profile.tools[0])}" />
                  <div class="flex items-end gap-2" data-testid="agent-new-profile">
                    <input class="h-9 min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" aria-label="${locale === "ru" ? "ID нового профиля" : "New profile ID"}" placeholder="my-agent" />
                    <button type="button" class="h-9 shrink-0 rounded-md border px-4 text-sm">${locale === "ru" ? "Добавить профиль" : "Add profile"}</button>
                  </div>
                </div>
              </section>
              <section class="min-w-0 max-w-full rounded-lg border ${dark ? "border-neutral-800 bg-neutral-900" : "border-neutral-200 bg-white"}">
                <div class="px-3 pt-3"><h2 class="text-sm font-medium">${l.instructions}</h2></div>
                <div class="px-3 pb-3 pt-2">
                  <label class="sr-only" for="agent-prompt">${l.instructions}</label>
                  <textarea id="agent-prompt" class="min-h-64 min-w-0 w-full max-w-full box-border rounded-md border p-3 text-sm ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" style="overflow-wrap:anywhere;word-break:break-word">${escapeHtml(profile.prompt)}</textarea>
                </div>
              </section>
              <section class="min-w-0 max-w-full rounded-lg border ${dark ? "border-neutral-800 bg-neutral-900" : "border-neutral-200 bg-white"}" data-testid="agent-resource-skills">
                <div class="flex items-center justify-between gap-2 px-3 pb-3 pt-3">
                  <span class="text-sm">${l.skills}</span>
                  <select class="h-9 w-[11rem] min-w-0 max-w-full shrink-0 rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" aria-label="${l.skills}"><option>${l.inherit}</option></select>
                </div>
              </section>
              <section class="min-w-0 max-w-full rounded-lg border ${dark ? "border-neutral-800 bg-neutral-900" : "border-neutral-200 bg-white"}" data-testid="agent-resource-tools">
                <div class="flex items-center justify-between gap-2 px-3 pt-3">
                  <span class="text-sm">${l.tools}</span>
                  <select class="h-9 w-[11rem] min-w-0 max-w-full shrink-0 rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" aria-label="${l.tools}"><option>${l.selected}</option></select>
                </div>
                <div class="space-y-2 px-3 pb-3 pt-2">
                  <p class="text-xs text-neutral-500">${l.count(listed.length)}</p>
                  <p class="text-xs text-neutral-500">${l.unknownHelp}</p>
                  <input class="min-w-0 w-full max-w-full box-border rounded-md border ${dark ? "border-neutral-700 bg-neutral-950" : "border-neutral-300"}" placeholder="${l.search}" aria-label="${l.search}" />
                  <ul class="max-h-40 min-w-0 divide-y ${dark ? "divide-neutral-800 border-neutral-800" : "divide-neutral-200 border-neutral-200"} overflow-y-auto rounded-md border" role="list">${tools}</ul>
                </div>
              </section>
            </fieldset>
          </section>
        </div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const locale = url.searchParams.get("locale") === "ru" ? "ru" : "en";
  const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
  const html = pageHtml(locale, theme);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const browser = await chromium.launch();
const results = [];
const outDir = join(root, ".bb/chats/thr_grqzb9stny/artifacts/layout");
mkdirSync(outDir, { recursive: true });

try {
  for (const locale of LOCALES) {
    for (const spec of CASES) {
      const page = await browser.newPage({ viewport: { width: spec.width, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/?locale=${locale}&theme=${spec.theme}`, { waitUntil: "networkidle" });
      if (spec.sidebar) {
        await page.evaluate((sidebar) => {
          const rail = document.querySelector("[data-testid='bb-sidebar']");
          if (rail) {
            rail.style.display = "block";
            rail.style.width = `${sidebar}px`;
          }
        }, spec.sidebar);
      }
      const pluginWidth = spec.width - spec.sidebar;
      const compact = pluginWidth <= 448;
      await page.evaluate((hideRail) => {
        const rail = document.querySelector("[data-testid='scope-rail']");
        if (rail) rail.style.display = hideRail ? "none" : "";
      }, compact);
      const contentWidth = Math.max(200, pluginWidth - (compact ? 32 : 216 + 32));
      await page.addStyleTag({ content: `#content-column{max-width:${contentWidth}px !important;width:${contentWidth}px !important;}` });
      if (contentWidth <= 350) {
        await page.evaluate(() => {
          const bar = document.querySelector("[data-testid='settings-toolbar']");
          if (bar) {
            bar.classList.remove("items-end");
            bar.classList.add("flex-col");
            bar.querySelector("[data-testid='settings-depth']")?.classList.add("w-full");
          }
        });
      }
      const measure = await page.evaluate(collectPanelGeometry);
      const shot = join(outDir, `${locale}-${spec.theme}-${spec.width}${spec.sidebar ? `-sidebar${spec.sidebar}` : ""}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      await page.locator("[data-testid='agent-resource-tools']").screenshot({ path: shot.replace(/\.png$/, "-tools.png") });
      await page.locator("[data-testid='settings-toolbar']").screenshot({ path: shot.replace(/\.png$/, "-toolbar.png") });
      await page.locator("[data-testid='disclosure-open']").screenshot({ path: shot.replace(/\.png$/, "-disclosure.png") });
      results.push({ locale, theme: spec.theme, width: spec.width, sidebar: spec.sidebar, pluginWidth, contentWidth, ...measure, screenshot: shot });
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
  console.log(`${row.locale} ${row.theme} ${row.width} sidebar ${row.sidebar} section ${row.section.clientWidth}/${row.section.scrollWidth} overflowNodes ${row.overflowNodes.length} ${row.ok ? "ok" : "FAIL"}`);
}
if (failed.length) {
  console.error(JSON.stringify(failed, null, 2));
  process.exit(1);
}
