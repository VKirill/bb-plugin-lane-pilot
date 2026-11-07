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
};
