/**
 * The design drawing contract shared by the phase driver (which records it) and design-eval
 * (which trains on it): the critique form's axes and the journal line one drawing leaves.
 */
export const CRITIQUE_AXES = ["hierarchy", "spacing", "contrast", "states", "brand", "motion"] as const;
export type CritiqueAxis = (typeof CRITIQUE_AXES)[number];
/** The drawing critique form: 0–3 on each axis, a verdict and what to change.
 * A rework also carries the person's goal–obstacle–question (SMA m_sw_design_feedback) and may continue
 * into a role line for the designer or a stored set case for the judge (SMA k_lib_dfeedback). */
export type DrawingCritique = {
  scores: Partial<Record<CritiqueAxis, number>>; verdict: "pass" | "rework"; notes: string;
  goal?: string; obstacle?: string; question?: string;
  continuation?: { kind: "role_line"; lesson: string } | { kind: "set_case"; caseId: string };
};

/** The «goal — obstacle — question» form a person answers on a drawing. */
export type DrawingFeedback = { goal: string; obstacle: string; question: string };

/** Each field of the form is required, 3–300 characters. */
export function drawingFeedbackProblems(form: DrawingFeedback): string[] {
  const why: string[] = [];
  for (const key of ["goal", "obstacle", "question"] as const) {
    const length = form[key]?.trim().length ?? 0;
    if (length < 3 || length > 300) why.push(`${key}: 3 to 300 characters`);
  }
  return why;
}

/** The form as one note, sent as the owner's word: «Цель: … Что мешает: … Вопрос: …». Throws on an invalid field. */
export function drawingFeedbackNote(form: DrawingFeedback): string {
  const why = drawingFeedbackProblems(form);
  if (why.length) throw new Error(`the drawing feedback form is not filled: ${why.join("; ")}`);
  return `Цель: ${form.goal.trim()} Что мешает: ${form.obstacle.trim()} Вопрос: ${form.question.trim()}`;
}

/** One stored judge case: the drawing's sha, the form it was judged with and the verdict it should learn to give. */
export type DesignCritiqueCase = { drawingSha: string; form: DrawingCritique; expectedVerdict: "pass" | "rework" };

export type DesignJournalLine = {
  at: number; projectId: string; phaseId: string; designer: string; reviewer: string | null; drawingSha: string;
  firstPass: boolean; critique: DrawingCritique | null; codeScore: number | null; ownerWord: "yes" | "no" | null;
  /** Append-only dedupe key: sha(phaseId|drawingSha|designer); a repeated packet never doubles a fact. */
  key?: string;
  /** Which training state the drawing was made under: a short hash of the designer's role lines at write time («base» before any). */
  series?: string;
  /** A folded design-pair judgement (n1762): presentation order and both verdicts. */
  pair?: { order: "ab" | "ba"; model: string | null; person: string | null; /** Absent = an active judge; «shadow» = the judge ran in its shadow mode and the verdict is its shadow answer. */ modelFrom?: "jev" | "shadow" };
};
/** Journal entries that are events, not drawings: the owner's word and a paired design judgement, appended, never edited in place. */
export type DesignJournalEvent =
  /** `line`/`lineAt`: the key and time of the drawing the word was said about (the phase's latest line at that moment); absent in older events. */
  | { event: "owner-word"; at: number; phaseId: string; word: "yes" | "no"; line?: string; lineAt?: number }
  | { event: "design-pair"; at: number; phaseId: string; order: "ab" | "ba"; model: string | null; person: string | null; modelFrom?: "jev" | "shadow" };
export type DesignJournalEntry = DesignJournalLine | DesignJournalEvent;
export const isDesignJournalEvent = (entry: DesignJournalEntry): entry is DesignJournalEvent => "event" in entry;
