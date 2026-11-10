// Public API of design-eval: the rubric, the in-page measurement, the score and the paired comparison.
export { compareDesigns, designScore, mergeFrames, MEASURE_SCRIPT, RUBRIC, scoreMeasurement } from "./logic";
export type { Criterion, Measurement } from "./logic";
export { CRITIQUE_AXES, critiqueProblems, readinessWords, roleLine, trainedConditions, trainingRatios } from "./training";
export type { CritiqueAxis, DesignJournalLine, DrawingCritique } from "./training";
export { DESIGN_JOURNAL_KEY, appendDesignJournalLine, appendDesignPair, designJournalKey, designJournalLines, noteDesignJournalWord } from "./journal";
export { pairBasis, pairOrder } from "./pair";
export { designPairJudgment, judgeDesigns, DESIGN_PAIR_ID } from "./judge";
