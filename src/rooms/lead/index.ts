// Public API of lead («Штурман», the lead over the runs): the migrations (storage imports them), the two surfaces other rooms call when a question
// to the owner appears and when he answers, the exam math and the predictor's judgment. The journal itself is behind ./server, the CLI behind ./cli.
export { leadMigrations } from "./migrations";
export { EXAM_RULES, cohenKappa, examAll, examClass, examEligible, wilsonLower, type ClassExam, type ExamRow, type Verdict } from "./logic";
export { LEAD_PREDICT_ID, leadPredictJudgment, type PredictDecision, type PredictInput } from "./predict";
export { answerPhaseWord, answerTaskWord, askPhaseWord, askTaskWord, phaseDecisionId, taskWordItemPrefix, wordDecisionId } from "./server/surfaces";
export { LEAD_DEFAULTS, LEAD_SETTING_KEYS, leadSettingProblem, parseLeadSettings, type LeadSettingKey, type LeadSettings } from "./settings";
export { LEAD_ID, LEAD_LAUNCH, LEAD_NAME, LEAD_SESSION, LEAD_SUMMARY, LEAD_TICK, LEAD_TOOLS } from "./lead-agent";
export { addRoad, doneRoad, getRoad, listRoad, reopenRoad } from "./server/road";
export type { RoadEvidence, RoadRow } from "./server/road";
