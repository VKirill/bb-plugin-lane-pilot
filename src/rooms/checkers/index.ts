// Public API of checkers: the migrations only (storage imports them; the rest of the room is behind ./server so storage never loads it).
export { checkerMigrations } from "./migrations";
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
} from "./diff-hidden";
