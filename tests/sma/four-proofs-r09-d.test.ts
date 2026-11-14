// Region 9 · Person and window, batch d (n850 … n881): the parts of the window that are not a screen — the drawing-feedback note, the worker history, the
// narrow-window switch and the window theme. What they produced is also written down with observe() for the region scene sma_r09.
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { drawingFeedbackNote } from "../../packages/contracts/src/design";
import { chromeIsCompact, SHELL_COMPACT_MAX } from "../../packages/ui-kit/src/ui/panel-layout";
import { createAttempt, createRun, createTask, openDatabase, saveReasoningTrace, transitionAttempt, workerOutcomesSince } from "../../src/rooms/plugin-db";
import { observe } from "./r09-world-d";

describe("region 9 · the drawing critique and the worker history", () => {
  it("[sma:m_sw_design_feedback] the «goal — obstacle — question» form becomes one note in the owner's words, each part trimmed and in its own place; a part under three or over three hundred characters refuses the whole form and names it", () => {
    const note = drawingFeedbackNote({ goal: "  a calm hero ", obstacle: "the box is loud", question: "keep the box?  " });
    expect(note).toBe("Цель: a calm hero Что мешает: the box is loud Вопрос: keep the box?");
    expect(() => drawingFeedbackNote({ goal: "ok", obstacle: "the box is loud", question: "keep the box?" })).toThrow("the drawing feedback form is not filled: goal: 3 to 300 characters");
    expect(() => drawingFeedbackNote({ goal: "a calm hero", obstacle: "x".repeat(301), question: "  " })).toThrow("obstacle: 3 to 300 characters; question: 3 to 300 characters");
    expect(drawingFeedbackNote({ goal: "abc", obstacle: "d".repeat(300), question: "efg" })).toBe(`Цель: abc Что мешает: ${"d".repeat(300)} Вопрос: efg`);
    const refused = (form: { goal: string; obstacle: string; question: string }) => { try { drawingFeedbackNote(form); return false; } catch { return true; } };
    observe("n852", { note, shortGoal: refused({ goal: "ok", obstacle: "the box is loud", question: "keep the box?" }), tooLong: refused({ goal: "a calm hero", obstacle: "x".repeat(301), question: "fine" }) });
  });

  it("[sma:m_sw_worker_history] done and not done are counted per worker and per day over the window asked for: an accepted work is done, every other ended one is not done, an open one is neither, a work with no trace belongs to «unknown», and a work older than the window is not counted", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run_h", "proj_h");
    createTask(db, { id: "th", runId: "run_h", kind: "bb", contract: {} });
    const trace = (attemptId: string, providerId: string, model: string) => ({ planSha256: "s", sourceLength: 1, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId, model, serviceTier: null, requestedServiceTier: "default" as const, runId: "run_h", attemptId, threadId: null });
    const day = (n: number) => Date.UTC(2026, 10, n, 12, 0);
    const make = (id: string, at: number, workerTrace: [string, string] | null, ends: "accepted" | "canceled" | "running" | null) => {
      createAttempt(db, { id, runId: "run_h", taskId: "th" });
      if (workerTrace) saveReasoningTrace(db, trace(id, workerTrace[0], workerTrace[1]));
      if (ends === "accepted" || ends === "canceled") transitionAttempt(db, id, ends, {});
      if (ends === "running") { transitionAttempt(db, id, "spawn_requested", {}); transitionAttempt(db, id, "running", {}); }
      db.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id=?").run(at, id);
    };
    make("h1", day(12), ["codex", "gpt-6-luna"], "accepted");
    make("h2", day(12), ["codex", "gpt-6-luna"], "accepted");
    make("h3", day(12), ["codex", "gpt-6-luna"], "canceled");
    make("h4", day(12), ["codex", "gpt-6-luna"], "running");
    make("h5", day(13), ["codex", "gpt-6-luna"], "canceled");
    make("h6", day(13), null, "canceled");
    make("h7", day(1), ["codex", "gpt-6-luna"], "accepted");
    const rows = workerOutcomesSince(db, "proj_h", day(10)).sort((a, b) => `${a.providerId}${a.day}`.localeCompare(`${b.providerId}${b.day}`));
    expect(rows).toEqual([
      { providerId: "codex", model: "gpt-6-luna", day: "2026-11-12", done: 2, notDone: 1 },
      { providerId: "codex", model: "gpt-6-luna", day: "2026-11-13", done: 0, notDone: 1 },
      { providerId: "unknown", model: "unknown", day: "2026-11-13", done: 0, notDone: 1 },
    ]);
    expect(workerOutcomesSince(db, "proj_other", 0)).toEqual([]);
    observe("n855", rows);
  });
});

describe("region 9 · the narrow window", () => {
  it("[sma:m_wnr_switch] the window is narrow from the first pixel up to 448 wide and not before it is measured (0) or above 448", () => {
    expect(SHELL_COMPACT_MAX).toBe(448);
    const answers = Object.fromEntries([0, 1, 320, 448, 449, 768].map((width) => [width, chromeIsCompact(width)]));
    expect(answers).toEqual({ 0: false, 1: true, 320: true, 448: true, 449: false, 768: false });
    observe("n868", answers);
  });
});

// A small resolver of the CSS `var(--a, fallback)` chains the window's theme tokens use: the answer the browser would give for each token under a theme.
function resolve(value: string, vars: Record<string, string>): string {
  let out = value.trim();
  for (let guard = 0; guard < 8 && out.includes("var("); guard += 1) {
    out = out.replace(/var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/, (_, name: string, fallback: string | undefined) => vars[name] ?? (fallback !== undefined ? fallback : ""));
  }
  return out.trim();
}
function rootTokens(): Record<string, string> {
  const css = readFileSync(new URL("../../app.css", import.meta.url), "utf8");
  const start = css.indexOf('[data-bb-plugin="lane-pilot"],');
  const block = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  return Object.fromEntries([...block.matchAll(/(--lp-[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
}

describe("region 9 · the window theme", () => {
  it("[sma:m_ws_theme] the window's own colours follow whatever theme BB is in, light or dark (card, hairline, outline), and the Pokecut theme's tokens win when it is on", () => {
    const tokens = rootTokens();
    const light = { "--card": "#ffffff", "--border": "#e5e5e5", "--input": "#d4d4d4" };
    const dark = { "--card": "#1a1a1a", "--border": "#333333", "--input": "#444444" };
    const pokecut = { ...light, "--pk-card": "#fff7fb", "--pk-hairline": "#f3c6dd", "--pk-outline": "#e29bc4" };
    const under = (theme: Record<string, string>) => Object.fromEntries(["--lp-card", "--lp-hairline", "--lp-outline"].map((name) => [name, resolve(tokens[name]!, theme)]));
    expect(under(light)).toEqual({ "--lp-card": "#ffffff", "--lp-hairline": "#e5e5e5", "--lp-outline": "#d4d4d4" });
    expect(under(dark)).toEqual({ "--lp-card": "#1a1a1a", "--lp-hairline": "#333333", "--lp-outline": "#444444" });
    expect(under(pokecut)).toEqual({ "--lp-card": "#fff7fb", "--lp-hairline": "#f3c6dd", "--lp-outline": "#e29bc4" });
    observe("n880", { light: under(light), dark: under(dark), pokecut: under(pokecut) });
  });
});
