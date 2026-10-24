/**
 * Design training (SMA map: Design training and evaluation). Every drawing a phase gets leaves one line in the design measurement journal:
 * who drew it, whether it passed its review the first time, the reviewer's critique form, the code score when measured, the owner's word.
 * Four ratios come out of the journal; four conditions say when the designer counts as trained; the readiness words say it to a person;
 * a lesson from a review becomes one dated line added to the designer's role, which its next brief carries.
 */
export const CRITIQUE_AXES = ["hierarchy", "spacing", "contrast", "states", "brand", "motion"] as const;
export type CritiqueAxis = (typeof CRITIQUE_AXES)[number];
/** The drawing critique form: 0–3 on each axis, a verdict and what to change. */
export type DrawingCritique = { scores: Partial<Record<CritiqueAxis, number>>; verdict: "pass" | "rework"; notes: string };

export type DesignJournalLine = {
  at: number; projectId: string; phaseId: string; designer: string; reviewer: string | null; drawingSha: string;
  firstPass: boolean; critique: DrawingCritique | null; codeScore: number | null; ownerWord: "yes" | "no" | null;
};

export function critiqueProblems(form: DrawingCritique): string[] {
  const why: string[] = [];
  for (const [axis, score] of Object.entries(form.scores)) if (!(CRITIQUE_AXES as readonly string[]).includes(axis) || !Number.isInteger(score) || score! < 0 || score! > 3) why.push(`${axis}: a score is 0–3 on a known axis`);
  if (Object.keys(form.scores).length < 4) why.push("score at least four axes of the critique form");
  if (form.verdict === "rework" && form.notes.trim().length < 10) why.push("a rework says what to change");
  return why;
}

/** Four training ratios over the designer's lines. */
export function trainingRatios(lines: readonly DesignJournalLine[]) {
  const n = lines.length;
  const share = (count: number, of: number) => (of ? Math.round((count / of) * 100) / 100 : null);
  const critiqued = lines.filter((line) => line.critique);
  const scored = lines.filter((line) => line.codeScore !== null);
  const worded = lines.filter((line) => line.ownerWord);
  return {
    drawings: n,
    firstPass: share(lines.filter((line) => line.firstPass).length, n),
    critiquePass: share(critiqued.filter((line) => line.critique!.verdict === "pass").length, critiqued.length),
    codeScore: scored.length ? Math.round(scored.reduce((sum, line) => sum + line.codeScore!, 0) / scored.length) : null,
    ownerYes: share(worded.filter((line) => line.ownerWord === "yes").length, worded.length),
  };
}

/** Four conditions of «trained»: enough drawings, first-pass and critique shares high, no owner «no» among the last five. */
export function trainedConditions(lines: readonly DesignJournalLine[]) {
  const ratios = trainingRatios(lines);
  const lastFive = lines.slice(-5);
  return [
    { id: "enough_drawings", ok: ratios.drawings >= 8, detail: `${ratios.drawings} of 8 drawings` },
    { id: "first_pass", ok: (ratios.firstPass ?? 0) >= 0.7, detail: `first pass ${ratios.firstPass ?? "—"} (≥ 0.7)` },
    { id: "critique_pass", ok: (ratios.critiquePass ?? 0) >= 0.8, detail: `critique pass ${ratios.critiquePass ?? "—"} (≥ 0.8)` },
    { id: "no_recent_no", ok: !lastFive.some((line) => line.ownerWord === "no"), detail: lastFive.some((line) => line.ownerWord === "no") ? "the owner said no among the last five" : "no «no» among the last five" },
  ];
}

/** Designer readiness words: what the conditions mean for a person. */
export function readinessWords(lines: readonly DesignJournalLine[]): string {
  const conditions = trainedConditions(lines);
  const missing = conditions.filter((row) => !row.ok);
  return missing.length === 0
    ? "Дизайнер обучен: его чертежи проходят ревью с первого раза, критика ставит «годится», владелец не возвращал последние пять. Чертёж можно не показывать владельцу заранее."
    : `Дизайнер ещё учится: ${missing.map((row) => row.detail).join("; ")}. Чертежи идут через ревью отдельной роли.`;
}

/** Role addition by one dated line: a lesson from a review, ≤ 200 characters, today's date first. */
export function roleLine(lesson: string, now = new Date()): string {
  return `${now.toISOString().slice(0, 10)} ${lesson.replace(/\s+/g, " ").trim().slice(0, 200)}`;
}
