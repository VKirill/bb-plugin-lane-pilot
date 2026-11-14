// Region 28 · Design training and evaluation — the behaviour proofs of the map nodes n1756–n1767 (docs/sma-evidence.md). These cards measure design
// work, so each test feeds a fixture set of measurements, journal lines or critique forms and checks the number or the verdict the code gives back,
// computed here by hand: a wrong denominator, a flipped comparison or a swapped order changes it.
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  CRITIQUE_AXES, DESIGN_SUITE_VERSION, RUBRIC, appendDesignJournalLine, compareDesigns, critiqueProblems, designJournalKey, designJournalLines, designScore, noteDesignJournalWord,
  pairBasis, pairOrder, readDesignCase, readinessWords, roleLine, scoreMeasurement, trainedConditions, trainingRatios, writeDesignCase,
  type DesignJournalLine, type DrawingCritique, type Measurement,
} from "../../src/rooms/design-eval";
import { createPhaseReactions } from "../../src/rooms/core/server/phase-reactions";
import { roleLinesKey } from "../../src/rooms/contracts/server";
import { designDecision } from "../../src/rooms/phase/logic/design";
import { ANIMATOR_LAW, motionRows } from "../../src/rooms/phase/stages";
import { cliPipeline } from "../../src/rooms/tools/server/cli-pipeline";
import { openDatabase } from "../../src/rooms/plugin-db";

const clean = (width: number): Measurement => ({ width, overflowPx: 0, textElements: 10, lowContrast: 0, targets: 4, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 6 });
/** Overflow 40, 1 of 10 texts under AA, 2 of 4 targets small, 5 tiny texts, two H1, 22 spacing values. */
const flawed = (width: number): Measurement => ({ width, overflowPx: 40, textElements: 10, lowContrast: 1, targets: 4, smallTargets: 2, tinyText: 5, h1: 2, spacingValues: 22 });
const kv = () => { const store = new Map<string, unknown>(); return { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } }; };
const line = (over: Partial<DesignJournalLine> = {}): DesignJournalLine => ({ at: 1, projectId: "p1", phaseId: "ph1", designer: "designer", reviewer: "rev", drawingSha: "sha1", firstPass: true, critique: null, codeScore: null, ownerWord: null, ...over });
const critique = (verdict: "pass" | "rework", axes: number, notes = "x"): DrawingCritique => ({ scores: Object.fromEntries(CRITIQUE_AXES.slice(0, axes).map((axis) => [axis, 2])), verdict, notes });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("design measurement and score (n1756, n1759)", () => {
  it("[sma:k_lib_dcodescore] the score is the mean of every criterion at every width, 0..100, from the measured facts alone", () => {
    expect(designScore([clean(375), clean(1280)]).score).toBe(100);
    // 375: overflow 0, contrast 0.5, targets 0, tiny 0.5, h1 0, spacing 0.5 = 1.5; 1280: the same but the targets are not judged on a desktop = 2.5; 4 / 12 = 33.
    const bad = designScore([flawed(375), flawed(1280)]);
    expect(bad.score).toBe(33);
    expect(bad.byWidth.map((row) => [row.width, row.criteria.map((c) => c.score)])).toEqual([[375, [0, 0.5, 0, 0.5, 0, 0.5]], [1280, [0, 0.5, 1, 0.5, 0, 0.5]]]);
    expect(bad.byWidth[1]!.criteria[2]!.detail).toBe("desktop: not judged");
    expect(bad.byWidth[0]!.criteria[0]!.detail).toBe("40px wider than the viewport");
    // A clean phone and a flawed desktop: (6 + 2.5) / 12 = 0.708 → 71.
    expect(designScore([clean(375), flawed(1280)]).score).toBe(71);
    expect(designScore([]).score).toBe(0);
    // The measured facts decide: one more small target on the phone lowers the score, a desktop's small targets do not.
    expect(designScore([{ ...clean(375), smallTargets: 1 }]).score).toBe(92);
    expect(designScore([{ ...clean(1280), smallTargets: 4 }]).score).toBe(100);
  });

  it("[sma:k_lib_drubric] six obligations, each worth one unit, and no acceptance threshold: failing any one costs the same 1/6 and the result has no verdict", () => {
    expect([...RUBRIC]).toEqual(["overflow", "contrast", "targets", "tiny_text", "one_h1", "spacing"]);
    expect(scoreMeasurement(clean(375)).map((c) => c.id)).toEqual([...RUBRIC]);
    const failing: Array<Partial<Measurement>> = [{ overflowPx: 40 }, { lowContrast: 2 }, { smallTargets: 4 }, { tinyText: 10 }, { h1: 0 }, { spacingValues: 32 }];
    for (const [index, over] of failing.entries()) {
      const one = scoreMeasurement({ ...clean(375), ...over });
      expect(one.map((c) => c.score)).toEqual(RUBRIC.map((_, at) => (at === index ? 0 : 1)));
      expect(designScore([{ ...clean(375), ...over }]).score).toBe(83);
    }
    expect(Object.keys(designScore([flawed(375)]))).toEqual(["score", "byWidth"]);
    expect(designScore([flawed(375), flawed(1280)]).score).toBeLessThan(50);
  });
});

describe("design case (n1757)", () => {
  const canonical = (rows: Measurement[]) => JSON.stringify(rows.map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))));
  it("[sma:k_lib_dcase] the writer pins the id, the suite version and the hash of the canonical bytes; the reader refuses each broken case with its own reason", () => {
    const rows = [clean(375), flawed(1280)];
    const written = JSON.parse(writeDesignCase({ id: "hero@1", measurements: rows })) as Record<string, unknown>;
    expect(written).toMatchObject({ id: "hero@1", suiteVersion: DESIGN_SUITE_VERSION, sha256: sha(canonical(rows)) });
    // Key order does not change the pinned hash.
    const reordered = rows.map((row) => Object.fromEntries(Object.entries(row).reverse())) as unknown as Measurement[];
    expect(JSON.parse(writeDesignCase({ id: "hero@1", measurements: reordered })).sha256).toBe(written.sha256);
    const text = writeDesignCase({ id: "hero@1", measurements: rows });
    expect(readDesignCase(text)).toEqual({ ok: true, case: { id: "hero@1", suiteVersion: DESIGN_SUITE_VERSION, sha256: written.sha256, measurements: rows } });
    const refusal = (value: unknown) => (readDesignCase(typeof value === "string" ? value : JSON.stringify(value)) as { reason?: string }).reason;
    expect(refusal("{not json")).toBe("design_case_not_json");
    expect(refusal({ ...written, id: "" })).toBe("design_case_id_missing");
    expect(refusal({ ...written, suiteVersion: "other-9" })).toBe("design_case_suite_mismatch:other-9");
    expect(refusal({ ...written, measurements: [clean(375), { ...flawed(1280), overflowPx: 41 }] })).toBe("design_case_bytes_differ");
    expect(refusal({ ...written, measurements: [] })).toBe("design_case_bytes_differ");
    const only = (width: number) => { const one = [clean(width)]; return { ...written, measurements: one, sha256: sha(canonical(one)) }; };
    expect(refusal(only(1280))).toBe("design_case_width_missing:375");
    expect(refusal(only(375))).toBe("design_case_width_missing:1280");
    const { h1: _h1, ...noH1 } = clean(375);
    const partial = [noH1, { ...clean(1280), h1: undefined }];
    expect(refusal({ ...written, measurements: partial, sha256: sha(canonical(partial as unknown as Measurement[])) })).toBe("design_case_measurement_incomplete");
  });
});

describe("training ratios, conditions and words (n1758, n1764, n1766)", () => {
  // Five drawings: two passes (one agreed by the owner, one not), one rework agreed, two uncritiqued (one scored 100, one worded yes).
  const five = [
    line({ phaseId: "a", firstPass: true, critique: critique("pass", 6), ownerWord: "yes", codeScore: 100 }),
    line({ phaseId: "b", firstPass: false, critique: critique("rework", 3, "needs air around the hero"), ownerWord: "no", codeScore: 80 }),
    line({ phaseId: "c", firstPass: true, critique: critique("pass", 6), ownerWord: "no" }),
    line({ phaseId: "d", firstPass: true, codeScore: 100 }),
    line({ phaseId: "e", firstPass: false, ownerWord: "yes" }),
  ];
  it("[sma:k_lib_dmetrics] first pass over all drawings, the judge's agreement over the lines with both a verdict and a word, point coverage over the critiques", () => {
    expect(trainingRatios(five)).toEqual({
      drawings: 5,
      firstPass: 0.6,                // 3 of 5
      passedAll: 0.67,               // codeScore 100 on 2 of the 3 scored
      critiquePass: 0.67,            // 2 passes of 3 critiques
      judgeAgrees: 0.67,             // of the 3 lines with verdict and word: pass+yes, rework+no agree, pass+no does not
      pointCoverage: 0.83,           // (6/6 + 3/6 + 6/6) / 3
      codeScore: 93,                 // (100 + 80 + 100) / 3
      ownerYes: 0.5,                 // 2 yes of the 4 worded
    });
    expect(trainingRatios([])).toEqual({ drawings: 0, firstPass: null, passedAll: null, critiquePass: null, judgeAgrees: null, pointCoverage: null, codeScore: null, ownerYes: null });
  });

  /** n drawings: the first `pass` ones are critiqued «pass», the rest «rework»; the first `first` ones went through at first show. */
  const set = (n: number, first: number, pass: number, words: Array<"yes" | "no" | null> = []) =>
    Array.from({ length: n }, (_, i) => line({ phaseId: `d${i}`, firstPass: i < first, critique: critique(i < pass ? "pass" : "rework", 4, "needs more air"), ownerWord: words[i] ?? null }));

  it("[sma:k_lib_dtrained] each of the four conditions is closed by its own number, at its own threshold, and not before", () => {
    expect(trainedConditions(set(10, 7, 8))).toEqual([
      { id: "enough_drawings", ok: true, detail: "10 of 8 drawings" },
      { id: "first_pass", ok: true, detail: "first pass 0.7 (≥ 0.7)" },
      { id: "critique_pass", ok: true, detail: "critique pass 0.8 (≥ 0.8)" },
      { id: "no_recent_no", ok: true, detail: "no «no» among the last five" },
    ]);
    const open = (lines: DesignJournalLine[]) => trainedConditions(lines).filter((row) => !row.ok).map((row) => `${row.id}: ${row.detail}`);
    expect(open(set(7, 7, 7))).toEqual(["enough_drawings: 7 of 8 drawings"]);
    expect(open(set(10, 6, 8))).toEqual(["first_pass: first pass 0.6 (≥ 0.7)"]);
    expect(open(set(10, 7, 7))).toEqual(["critique_pass: critique pass 0.7 (≥ 0.8)"]);
    // The owner's «no» counts only among the last five drawings.
    expect(open(set(10, 7, 8, [null, null, null, null, "no", null, null, null, null, null]))).toEqual([]);
    expect(open(set(10, 7, 8, [null, null, null, null, null, "no", null, null, null, null]))).toEqual(["no_recent_no: the owner said no among the last five"]);
    expect(open([])).toEqual(["enough_drawings: 0 of 8 drawings", "first_pass: first pass — (≥ 0.7)", "critique_pass: critique pass — (≥ 0.8)"]);
  });

  it("[sma:k_lib_dwords] trained says so in one sentence; otherwise the sentence lists exactly the open conditions", () => {
    expect(readinessWords(set(10, 7, 8))).toBe("Дизайнер обучен: его чертежи проходят ревью с первого раза, критика ставит «годится», владелец не возвращал последние пять. Чертёж можно не показывать владельцу заранее.");
    expect(readinessWords(set(3, 3, 3))).toBe("Дизайнер ещё учится: 3 of 8 drawings. Чертежи идут через ревью отдельной роли.");
    expect(readinessWords(set(10, 6, 7, [null, null, null, null, null, "no"]))).toBe("Дизайнер ещё учится: first pass 0.6 (≥ 0.7); critique pass 0.7 (≥ 0.8); the owner said no among the last five. Чертежи идут через ревью отдельной роли.");
  });
});

describe("journal, critique form, pair (n1760, n1761, n1762)", () => {
  it("[sma:k_lib_dstore] a repeated packet never doubles a fact; a redraw after another drawing or after the owner's word is a new one; written lines stay as they were", async () => {
    const store = kv();
    const a = line({ phaseId: "ph1", drawingSha: "sha1", at: 1 }), b = line({ phaseId: "ph1", drawingSha: "sha2", at: 2 });
    await appendDesignJournalLine(store, a);
    const first = JSON.stringify((await designJournalLines(store))[0]);
    expect(JSON.parse(first).key).toBe(sha("ph1|sha1|designer").slice(0, 16));
    expect(designJournalKey(a)).toBe(sha("ph1|sha1|designer").slice(0, 16));
    await appendDesignJournalLine(store, a);
    expect(await designJournalLines(store)).toHaveLength(1);
    await appendDesignJournalLine(store, b);
    expect((await designJournalLines(store)).map((row) => row.drawingSha)).toEqual(["sha1", "sha2"]);
    await appendDesignJournalLine(store, a);
    expect((await designJournalLines(store)).map((row) => row.drawingSha)).toEqual(["sha1", "sha2", "sha1"]);
    await appendDesignJournalLine(store, b);
    await noteDesignJournalWord(store, "ph1", "yes");
    await appendDesignJournalLine(store, b);
    expect((await designJournalLines(store)).map((row) => row.drawingSha)).toEqual(["sha1", "sha2", "sha1", "sha2", "sha2"]);
    expect(JSON.stringify((await designJournalLines(store))[0])).toBe(first);
  });

  it("[sma:k_lib_dfeedback] the critique form: scores are 0–3 whole numbers on the six known axes, at least four; a rework says what to change; the feedback form is all three or none", () => {
    const form = (over: Partial<DrawingCritique> = {}, scores: Record<string, number> = { hierarchy: 2, spacing: 2, contrast: 2, states: 1 }): DrawingCritique => ({ scores, verdict: "pass", notes: "", ...over });
    expect(critiqueProblems(form())).toEqual([]);
    expect(critiqueProblems(form({}, { hierarchy: 3, spacing: 0, contrast: 3, states: 0 }))).toEqual([]);
    const withScore = (axis: string, score: number) => critiqueProblems(form({}, { hierarchy: 2, spacing: 2, contrast: 2, states: 1, [axis]: score }));
    expect(withScore("brand", 4)).toEqual(["brand: a score is 0–3 on a known axis"]);
    expect(withScore("brand", -1)).toEqual(["brand: a score is 0–3 on a known axis"]);
    expect(withScore("brand", 1.5)).toEqual(["brand: a score is 0–3 on a known axis"]);
    expect(withScore("typography", 2)).toEqual(["typography: a score is 0–3 on a known axis"]);
    expect(critiqueProblems(form({}, { hierarchy: 2, spacing: 2, contrast: 2 }))).toEqual(["score at least four axes of the critique form"]);
    expect(critiqueProblems(form({ verdict: "rework", notes: "too short" }))).toEqual(["a rework says what to change"]);
    expect(critiqueProblems(form({ verdict: "rework", notes: "the hero needs more air" }))).toEqual([]);
    expect(critiqueProblems(form({ goal: "a calm hero" }))).toEqual(["the feedback form names the obstacle", "the feedback form names the question"]);
    expect(critiqueProblems(form({ goal: "g", obstacle: "o", question: "q" }))).toEqual([]);
    expect(critiqueProblems(form({ goal: "g", obstacle: " ", question: "q" }))).toEqual(["the feedback form names the obstacle"]);
    expect(critiqueProblems(form({ continuation: { kind: "role_line", lesson: " " } }))).toEqual(["a role_line continuation names the lesson"]);
    expect(critiqueProblems(form({ continuation: { kind: "set_case", caseId: "" } }))).toEqual(["a set_case continuation names the case"]);
    expect(critiqueProblems(form({ continuation: { kind: "set_case", caseId: "hero-1" } }))).toEqual([]);
    expect(critiqueProblems(form({ continuation: { kind: "other" } as never }))).toEqual(["a continuation is role_line or set_case"]);
  });

  it("[sma:k_lib_djudgement] the two pages are shown in the order a hash of the pair fixes, and the basis lists the design shown first as «first» with its own scores", () => {
    const orderOf = (a: string, b: string) => (createHash("sha256").update(`${a}|${b}`).digest()[0]! % 2 === 0 ? "ab" : "ba");
    const pick = (want: "ab" | "ba") => { for (let i = 0; ; i++) if (orderOf(`http://a/${i}`, "http://b/") === want) return `http://a/${i}`; };
    const good = [clean(375), clean(1280)], poor = [flawed(375), flawed(1280)];
    const all = (score: number) => `${score}/100`;
    const goodLine = `${all(100)}; 375px overflow=100,contrast=100,targets=100,tiny_text=100,one_h1=100,spacing=100; 1280px overflow=100,contrast=100,targets=100,tiny_text=100,one_h1=100,spacing=100`;
    const poorLine = `${all(33)}; 375px overflow=0,contrast=50,targets=0,tiny_text=50,one_h1=0,spacing=50; 1280px overflow=0,contrast=50,targets=100,tiny_text=50,one_h1=0,spacing=50`;
    const rubric = "Rubric: overflow, contrast, targets, tiny_text, one_h1, spacing — each 0..100 at 375 and 1280 px.";
    for (const want of ["ab", "ba"] as const) {
      const urlA = pick(want), urlB = "http://b/";
      expect(pairOrder(urlA, urlB)).toBe(want);
      const pair = pairBasis(urlA, urlB, good, poor);
      expect(pair.order).toBe(want);
      expect(pair.basis).toBe([
        `Design pair, order ${want} (${want === "ab" ? "A shown first" : "B shown first"}).`,
        want === "ab" ? `first: ${goodLine}` : `first: ${poorLine}`,
        want === "ab" ? `second: ${poorLine}` : `second: ${goodLine}`,
        rubric, `A=${urlA} B=${urlB}`,
      ].join("\n"));
      // One basis for both judges: the same call gives the same text, and swapping the designs changes who is first, not the verdict.
      expect(pairBasis(urlA, urlB, good, poor).basis).toBe(pair.basis);
      expect(pair.comparison).toMatchObject({ winner: "a", a: 100, b: 33 });
      expect(pair.comparison.changes).toHaveLength(11);
      expect(pair.comparison.changes[0]).toEqual({ width: 375, id: "overflow", a: 1, b: 0 });
    }
    expect(compareDesigns(good, good)).toEqual({ winner: "tie", a: 100, b: 100, changes: [] });
    expect(compareDesigns(poor, good).winner).toBe("b");
  });
});

describe("motion rules (n1763)", () => {
  const piece = (id: string, title: string, promise = ""): never => ({ id, title, wave: 1, promise: { given: "a screen", when: promise, then: "it holds" }, task: { owns_paths: ["src/a.tsx"] } }) as never;
  it("[sma:k_lib_dmotion] a piece whose title or promise is about motion, in English or Russian, gets the animator's law; a word that only contains «motion» does not", () => {
    const items = [
      piece("hud", "HUD motion"), piece("copy", "Label copy", "the label stays"), piece("emo", "Emotion icons"),
      piece("page", "Page transition"), piece("ru-anim", "Анимация кнопки"), piece("ru-go", "Экран", "переход между экранами"), piece("ru-move", "Панель", "движение панели при открытии"),
      piece("anim-promise", "Toast", "the toast animates in"),
    ];
    expect(motionRows(items)).toEqual(["hud", "page", "ru-anim", "ru-go", "ru-move", "anim-promise"]);
    expect(motionRows([])).toEqual([]);
    // The design decision carries the motion rows to the designer, who is given the law.
    expect(designDecision(items).motion).toEqual(["hud", "page", "ru-anim", "ru-go", "ru-move", "anim-promise"]);
    expect(designDecision([piece("copy", "Label copy")]).motion).toEqual([]);
    for (const rule of ["transform and opacity only", "150–300 ms", "ease-out entering and ease-in leaving", "prefers-reduced-motion", "no motion that blocks input", "end state drawn"]) expect(ANIMATOR_LAW).toContain(rule);
  });
});

describe("role line and designer measurement (n1765, n1767)", () => {
  it("[sma:k_lib_additions] a lesson becomes one dated line of at most 200 characters; the role grows by appending, never rewriting, and a repeat adds nothing", async () => {
    const day = new Date("2026-11-10T23:30:00Z");
    expect(roleLine("  leave   air\naround the hero ", day)).toBe("2026-11-10 leave air around the hero");
    expect(roleLine("x".repeat(300), day)).toBe(`2026-11-10 ${"x".repeat(200)}`);
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const reactions = createPhaseReactions(openDatabase(bb), bb as never);
    const read = async () => await bb.storage.kv.get(roleLinesKey("p1", "designer")) as string[];
    await reactions.addRoleLine("p1", "designer", "2026-11-10 bigger taps");
    await reactions.addRoleLine("p1", "designer", "2026-11-11 more air");
    await reactions.addRoleLine("p1", "designer", "2026-11-10 bigger taps");
    expect(await read()).toEqual(["2026-11-10 bigger taps", "2026-11-11 more air"]);
    for (let i = 0; i < 35; i++) await reactions.addRoleLine("p1", "designer", `2026-12-01 lesson ${i}`);
    const lines = await read();
    expect(lines).toHaveLength(30);
    expect(lines.at(-1)).toBe("2026-12-01 lesson 34");
    expect(lines[0]).toBe("2026-12-01 lesson 5");
  });

  it("[sma:k_v_designer_metrics] a drawing is stamped with the series of the role lines it was made under; the verb reports each series' ratios, the first as baseline and the last as latest", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const reactions = createPhaseReactions(openDatabase(bb), bb as never);
    const draw = (phaseId: string, firstPass: boolean) => reactions.journalDrawing(line({ phaseId, drawingSha: `sha-${phaseId}`, firstPass }));
    await draw("a", false);
    await reactions.addRoleLine("p1", "designer", "2026-11-10 bigger taps");
    await draw("b", true);
    await draw("c", false);
    await reactions.addRoleLine("p1", "designer", "2026-11-11 more air");
    await draw("d", true);
    const one = sha("2026-11-10 bigger taps").slice(0, 8), two = sha("2026-11-10 bigger taps\n2026-11-11 more air").slice(0, 8);
    expect((await designJournalLines(bb.storage.kv as never)).map((row) => row.series)).toEqual(["base", one, one, two]);
    const run = async (args: string[]) => JSON.parse((await cliPipeline({ ctx: { bb, db: undefined, effectiveProjectSettings: undefined, host: undefined }, services: {}, command: "design-metrics", args, invocation: undefined, commands: [], migrations: [] } as never))!.stdout!);
    const report = await run(["--json"]);
    expect(report.baseline).toBe("base");
    expect(report.latest).toBe(two);
    expect(Object.keys(report.series)).toEqual(["base", one, two]);
    expect(report.series.base).toMatchObject({ drawings: 1, firstPass: 0 });
    expect(report.series[one]).toMatchObject({ drawings: 2, firstPass: 0.5 });
    expect(report.series[two]).toMatchObject({ drawings: 1, firstPass: 1 });
    expect(report.ratios).toMatchObject({ drawings: 4, firstPass: 0.5 });
    const none = await run(["--json", "--project", "p9"]);
    expect(none).toMatchObject({ baseline: null, latest: null, series: {}, ratios: { drawings: 0 } });
  });
});
