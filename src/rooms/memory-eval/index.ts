// Public API of memory-eval: pure models and fixtures (server runners are behind ./server).
export { OFFTOPIC, candidateQuestions, classify, fileKey, folderKey, notesNaming, queryOf } from "./models/questions";
export type { Classified, EvalQuestion, QuestionKind } from "./models/questions";
export { EVAL_PROJECT, planCorpus, poisonCopy, prng, shuffled, syntheticCopy } from "./models/corpus";
export type { CorpusNote, EvalScope, PlanInput, SizePlan } from "./models/corpus";
export { MASLOV_FILLER, SUITE_CASES, SUITE_NOTES, SUITE_PACK_NOTES, SUITE_PROJECT } from "./models/suite-fixture";
export type { SuiteCase, SuiteFamily, SuiteNote } from "./models/suite-fixture";
