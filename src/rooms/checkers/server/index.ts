// Public API of checkers/server: what other rooms import. Everything else in this room is private.
export { CHECKERS_USAGE, runCheckersCli } from "../api";
export type { CheckersApi } from "../api";
export { createPluginCheckers } from "./plugin-ports";
export {
  DIFF_INSPECTING_CHECKERS,
  auditCandidateDiffHidden,
  buildDiffHiddenSubject,
  diffHiddenMorningLine,
  getDiffHiddenSummary,
  runDiffHiddenAudit,
  saveDiffHiddenRows,
  type CandidateDiffHiddenAudit,
  type DiffHiddenAuditReport,
  type DiffHiddenCheckResult,
  type DiffHiddenRow,
  type DiffHiddenSummary,
} from "../diff-hidden";
