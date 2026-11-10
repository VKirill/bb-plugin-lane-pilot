/**
 * The design drawing contract shared by the phase driver (which records it) and design-eval
 * (which trains on it): the critique form's axes and the journal line one drawing leaves.
 */
export const CRITIQUE_AXES = ["hierarchy", "spacing", "contrast", "states", "brand", "motion"] as const;
export type CritiqueAxis = (typeof CRITIQUE_AXES)[number];
/** The drawing critique form: 0–3 on each axis, a verdict and what to change. */
export type DrawingCritique = { scores: Partial<Record<CritiqueAxis, number>>; verdict: "pass" | "rework"; notes: string };

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
