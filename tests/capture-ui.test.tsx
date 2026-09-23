/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { VISIBLE_CATALOG } from "../src/ui-catalog";
import { en, ru } from "../i18n";
import { EXTERNAL_OPS } from "../src/constants";

const root = process.cwd();
const outDir = resolve(root, "../../.agency/jobs/AG-195/tmp/ui-html");
const pngDir = resolve(root, "../../.agency/jobs/AG-195/artifacts");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function screenFixture() {
  return {
    projectId: "proj_ui",
    hostId: "host_ui",
    workspacePath: "/tmp/lane-pilot-ui",
    values: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, row.defaultValue])),
    versions: Object.fromEntries(VISIBLE_CATALOG.map((row) => [row.storageKey, 1])),
    importSource: { completed: true, at: 1, routingPath: "/tmp/routing.profile.yaml", nightPath: "/tmp/night-shift.yaml" },
    runs: [{
      id: "lprun_1",
      state: "running",
      kind: "bb",
      created_at: 1,
      updated_at: 1,
      cliReceiptJson: "{\"kind\":\"cli\",\"applied\":[\"writer.provider\"]}",
      attempts: [{
        id: "lpattempt_1",
        state: "running",
        attempt_no: 1,
        thread_id: "thr_writer",
        reason: null,
        task_id: "task_1",
        cliReceiptJson: "{\"kind\":\"cli\",\"applied\":[\"writer.provider\"]}",
      }],
    }],
    unapplied: [{ key: "plan_critique.mode", reason: "no proven runtime channel" }],
    lastSnapshotPath: "/tmp/snapshot",
    lastReceiptJson: "{\"action\":\"install\"}",
    writerResultJson: "{\"status\":\"accepted\",\"output\":\"hello from writer\"}",
    writerResultPatch: "--- /dev/null\n+++ b/writer-output.txt\n@@ -0,0 +1,1 @@\n+hello from writer\n",
    cliReceiptJson: "{\"kind\":\"cli\",\"applied\":[\"writer.provider\"]}",
  };
}

async function mount(lang: string) {
  document.documentElement.lang = lang;
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath: "" }, {
    context: { projectId: "proj_ui", threadId: null },
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as {suggestedLocale:"en"|"ru"}).suggestedLocale, lastProjectId: null }),
      set_locale: (input: unknown) => ({ locale: (input as {locale:"en"|"ru"}).locale }),
      remember_project: () => ({ ok:true }),
      list_projects: () => ({ projects:[], lastProjectId:null }),
      get_screen: () => screenFixture(),
      save_setting: () => ({ ok: true, conflict: false, version: 2, value: true }),
      save_settings: () => ({ ok:true, conflict:false, values:{}, versions:{} }),
      cancel_attempt: () => ({ ok: true, state: "canceled", reason: null }),
      retry_attempt: () => ({ ok: true, state: "queued", attemptId: "lpattempt_2", reason: null }),
      resume_runs: () => ({ resumed: [], skipped: [], finished: [] }),
      stack_detect: () => ({ scenario: "S1" }),
      stack_install: () => ({ status: "ok" }),
      stack_connect: () => ({ status: "ok" }),
      stack_rollback: () => ({ status: "ok" }),
    },
  });
}

function wrap(html: string, lang: string, theme: "light" | "dark") {
  const css = resolve(root, "dist/app.css");
  const vars = theme === "dark"
    ? `--background:#0a0a0a;--foreground:#fafafa;--card:#0a0a0a;--card-foreground:#fafafa;--popover:#0a0a0a;--popover-foreground:#fafafa;--primary:#fafafa;--primary-foreground:#171717;--secondary:#262626;--secondary-foreground:#fafafa;--muted:#262626;--muted-foreground:#a3a3a3;--accent:#262626;--accent-foreground:#fafafa;--destructive:#7f1d1d;--destructive-foreground:#fafafa;--border:#262626;--input:#262626;--ring:#d4d4d4;--radius:0.5rem;`
    : `--background:#ffffff;--foreground:#0a0a0a;--card:#ffffff;--card-foreground:#0a0a0a;--popover:#ffffff;--popover-foreground:#0a0a0a;--primary:#171717;--primary-foreground:#fafafa;--secondary:#f5f5f5;--secondary-foreground:#171717;--muted:#f5f5f5;--muted-foreground:#737373;--accent:#f5f5f5;--accent-foreground:#171717;--destructive:#fee2e2;--destructive-foreground:#991b1b;--border:#e5e5e5;--input:#e5e5e5;--ring:#a3a3a3;--radius:0.5rem;`;
  return `<!doctype html><html lang="${lang}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="file://${css}"><style>
:root{${vars}font-family:ui-sans-serif,system-ui,sans-serif;background:var(--background);color:var(--foreground);}
</style></head><body data-bb-plugin="lane-pilot" data-bb-plugin-root class="bg-background text-foreground">${html}<script>
setTimeout(() => {
  document.documentElement.setAttribute("data-document-scroll-width", String(document.documentElement.scrollWidth));
  const dialog = document.querySelector('[data-testid="external-ops-dialog"]');
  if (dialog) {
    const rect = dialog.getBoundingClientRect();
    dialog.setAttribute("data-dialog-left", String(rect.left));
    dialog.setAttribute("data-dialog-right", String(rect.right));
  }
}, 700);
</script></body></html>`;
}

function pngPixelWidth(pngPath: string): number {
  const out = execFileSync("sips", ["-g", "pixelWidth", pngPath], { encoding: "utf8" });
  return Number(out.match(/pixelWidth: (\d+)/)?.[1] ?? "NaN");
}

function chromeShot(htmlPath: string, pngPath: string): number {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--allow-file-access-from-files",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=375,4000",
    "--virtual-time-budget=5000",
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ], { timeout: 60_000 });
  return pngPixelWidth(pngPath);
}

function chromeDump(htmlPath: string): string {
  return execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--allow-file-access-from-files",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=375,4000",
    "--virtual-time-budget=5000",
    `--screenshot=${resolve(outDir, "dump-viewport.png")}`,
    "--dump-dom",
    `file://${htmlPath}`,
  ], { encoding: "utf8", timeout: 60_000 });
}

describe.skipIf(process.env.CAPTURE !== "1")("UI screenshot HTML", () => {
  it("writes EN/RU light/dark fixtures at 375px", { timeout: 180_000 }, async () => {
    mkdirSync(outDir, { recursive: true });
    mkdirSync(pngDir, { recursive: true });
    const dialogWidths: number[] = [];
    const captures: Array<{ lang: "en" | "ru"; theme: "light" | "dark"; view: "settings" | "monitor" | "dialog"; htmlPath: string; pngPath: string }> = [];
    for (const lang of ["en", "ru"] as const) {
      for (const theme of ["light", "dark"] as const) {
        for (const view of ["settings", "monitor", "dialog"] as const) {
          const slot = await mount(lang);
          await slot.findByText(/\/tmp\/routing\.profile\.yaml/);
          if (view === "monitor") fireEvent.click(slot.getByTestId("tab-monitor"));
          if (view === "dialog") {
            fireEvent.click(slot.getByTestId("tab-install"));
            fireEvent.click(slot.getByTestId("install-stack"));
          }
          const dialog = document.querySelector('[data-testid="external-ops-dialog"]');
          if (view === "dialog") {
            expect(dialog?.textContent, `${view}-${lang}-${theme} title`).toContain(lang === "ru" ? ru.confirmTitle : en.confirmTitle);
            for (const op of EXTERNAL_OPS) {
              expect(dialog?.textContent, `${view}-${lang}-${theme} ${op}`).toContain(op);
            }
          }
          const html = document.body.innerHTML;
          const htmlPath = resolve(outDir, `${view}-${lang}-${theme}.html`);
          writeFileSync(htmlPath, wrap(html, lang, theme));
          const pngPath = resolve(pngDir, `${view}-${lang}-${theme}.png`);
          captures.push({ lang, theme, view, htmlPath, pngPath });
          slot.lifecycle.unmount();
        }
      }
    }
    for (const { lang, theme, view, htmlPath, pngPath } of captures) {
      const pixelWidth = chromeShot(htmlPath, pngPath);
      expect(pixelWidth, `${view}-${lang}-${theme}`).toBe(375);
      if (view === "dialog") {
        const dumped = chromeDump(htmlPath);
        expect(dumped, `${view}-${lang}-${theme} dump title`).toContain(lang === "ru" ? ru.confirmTitle : en.confirmTitle);
        for (const op of EXTERNAL_OPS) {
          expect(dumped, `${view}-${lang}-${theme} dump ${op}`).toContain(op);
        }
        expect(dumped).toContain('data-document-scroll-width="');
        const scrollWidth = Number(dumped.match(/data-document-scroll-width="(\d+)"/)?.[1] ?? "NaN");
        expect(scrollWidth, `${view}-${lang}-${theme} document.scrollWidth`).toBeLessThanOrEqual(375);
        const rightEdge = Number(dumped.match(/data-dialog-right="([\d.]+)"/)?.[1] ?? "NaN");
        expect(rightEdge, `${view}-${lang}-${theme} dialog right edge`).toBeLessThanOrEqual(375);
        dialogWidths.push(scrollWidth);
      }
    }
    expect(dialogWidths).toHaveLength(4);
  });
});
