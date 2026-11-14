// Probe of scenes/sma_r28.py: runs the real design measurement code of THIS checkout (the commit under drill) on fixture measurements, journal
// lines and critique forms, and prints the numbers and verdicts as one JSON line. It judges nothing: the scene compares them with the cards.
import { createHash } from "node:crypto";
import {
  CRITIQUE_AXES, RUBRIC, appendDesignJournalLine, critiqueProblems, designJournalLines, designScore, pairBasis, readDesignCase, readinessWords, roleLine,
  trainedConditions, trainingRatios, writeDesignCase, type DesignJournalLine, type DrawingCritique, type Measurement,
} from "../../../src/rooms/design-eval";
import { motionRows } from "../../../src/rooms/phase/stages";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPhaseReactions } from "../../../src/rooms/core/server/phase-reactions";
import { openDatabase } from "../../../src/rooms/plugin-db";

const clean = (width: number): Measurement => ({ width, overflowPx: 0, textElements: 10, lowContrast: 0, targets: 4, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 6 });
const flawed = (width: number): Measurement => ({ width, overflowPx: 40, textElements: 10, lowContrast: 1, targets: 4, smallTargets: 2, tinyText: 5, h1: 2, spacingValues: 22 });
const line = (over: Partial<DesignJournalLine> = {}): DesignJournalLine => ({ at: 1, projectId: "p1", phaseId: "ph1", designer: "designer", reviewer: "rev", drawingSha: "sha1", firstPass: true, critique: null, codeScore: null, ownerWord: null, ...over });
const critique = (verdict: "pass" | "rework", axes: number): DrawingCritique => ({ scores: Object.fromEntries(CRITIQUE_AXES.slice(0, axes).map((axis) => [axis, 2])), verdict, notes: "needs more air" });
const set = (n: number, first: number, pass: number) => Array.from({ length: n }, (_, i) => line({ phaseId: `d${i}`, firstPass: i < first, critique: critique(i < pass ? "pass" : "rework", 4) }));

async function main() {
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } };
  await appendDesignJournalLine(kv, line({ drawingSha: "sha1" }));
  await appendDesignJournalLine(kv, line({ drawingSha: "sha1" }));
  const afterRepeat = (await designJournalLines(kv)).length;
  await appendDesignJournalLine(kv, line({ drawingSha: "sha2", at: 2 }));
  await appendDesignJournalLine(kv, line({ drawingSha: "sha1", at: 3 }));
  const shas = (await designJournalLines(kv)).map((row) => row.drawingSha);

  const bad = designScore([flawed(375), flawed(1280)]);
  const written = JSON.parse(writeDesignCase({ id: "hero@1", measurements: [clean(375), clean(1280)] })) as Record<string, unknown>;
  const flippedBytes = { ...written, measurements: [clean(375), { ...clean(1280), overflowPx: 9 }] };
  const five = [
    line({ phaseId: "a", firstPass: true, critique: critique("pass", 6), ownerWord: "yes", codeScore: 100 }),
    line({ phaseId: "b", firstPass: false, critique: critique("rework", 3), ownerWord: "no", codeScore: 80 }),
    line({ phaseId: "c", firstPass: true, critique: critique("pass", 6), ownerWord: "no" }),
    line({ phaseId: "d", firstPass: true, codeScore: 100 }),
    line({ phaseId: "e", firstPass: false, ownerWord: "yes" }),
  ];
  const piece = (id: string, title: string) => ({ id, title, wave: 1, promise: { given: "a screen", when: "", then: "it holds" }, task: {} }) as never;
  const orderOf = (a: string, b: string) => (createHash("sha256").update(`${a}|${b}`).digest()[0]! % 2 === 0 ? "ab" : "ba");
  const urlA = [...Array(50).keys()].map((i) => `http://a/${i}`).find((url) => orderOf(url, "http://b/") === "ba")!;
  const pair = pairBasis(urlA, "http://b/", [clean(375), clean(1280)], [flawed(375), flawed(1280)]);
  const scoreOf = (extra: Partial<Measurement>) => designScore([{ ...clean(375), ...extra }]).score;

  // n1767: drawings made before and after a role line carry different series; the first is the baseline.
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const reactions = createPhaseReactions(openDatabase(bb), bb as never);
  await reactions.journalDrawing(line({ phaseId: "a", drawingSha: "sa", firstPass: false }));
  await reactions.addRoleLine("p1", "designer", "2026-11-10 bigger taps");
  await reactions.journalDrawing(line({ phaseId: "b", drawingSha: "sb", firstPass: true }));
  const series = (await designJournalLines(bb.storage.kv as never)).map((row) => row.series);
  const wantSeries = createHash("sha256").update("2026-11-10 bigger taps").digest("hex").slice(0, 8);

  process.stdout.write(JSON.stringify({
    series, seriesAfterRoleLine: series[1] === wantSeries,
    badScore: bad.score, badPhone: bad.byWidth[0]!.criteria.map((c) => c.score), cleanScore: designScore([clean(375), clean(1280)]).score, mixedScore: designScore([clean(375), flawed(1280)]).score,
    rubric: [...RUBRIC], oneFailure: [scoreOf({ overflowPx: 40 }), scoreOf({ h1: 0 }), scoreOf({ spacingValues: 32 })],
    caseRead: readDesignCase(JSON.stringify(written)).ok, caseBytes: (readDesignCase(JSON.stringify(flippedBytes)) as { reason?: string }).reason,
    ratios: trainingRatios(five),
    afterRepeat, shas,
    critiqueScore4: critiqueProblems({ scores: { hierarchy: 2, spacing: 2, contrast: 2, states: 1, brand: 4 }, verdict: "pass", notes: "" }),
    pairOrder: pair.order, pairFirst: pair.basis.split("\n")[1]!.slice(0, 16), pairWinner: pair.comparison.winner, pairScores: [pair.comparison.a, pair.comparison.b],
    motion: motionRows([piece("hud", "HUD motion"), piece("copy", "Label copy"), piece("emo", "Emotion icons"), piece("ru", "Анимация кнопки")]),
    readyTrained: readinessWords(set(10, 7, 8)).slice(0, 16), readyOpen: readinessWords(set(3, 3, 3)),
    roleLine: roleLine("  leave   air\naround the hero ", new Date("2026-11-10T23:30:00Z")), roleLineCap: roleLine("x".repeat(300), new Date("2026-11-10T23:30:00Z")).length,
    conditionsEdge: trainedConditions(set(10, 7, 8)).map((row) => row.ok), conditionsBelow: trainedConditions(set(10, 6, 8)).map((row) => row.ok),
  }));
}
void main();
