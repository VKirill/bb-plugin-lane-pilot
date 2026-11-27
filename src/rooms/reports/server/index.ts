// Public API of reports/server: what other rooms import. Everything else in this room is private.
export {
  composeDailyReport,
  DAILY_DRY_KEY,
  DAILY_SENT_KEY,
  dailyDue,
  localDayHour,
  type DailySummary,
} from "../models/daily-report";
export { type DigestLike, type OwnerPushOutcome } from "../models/owner-push";
export {
  TelegramNotReadyError,
  TelegramSendError,
  TG_CHAT_NAME,
  TG_TOKEN_NAME,
  TG_TOPIC_NAME,
  type TelegramSend,
} from "../models/telegram";
export { mountReports, type ReportsDeps } from "./handlers/report-workflows";
export { room } from "./room";
export {
  buildDailyReport,
  runDailyReport,
  type DailyDeps,
  type DailyReportOutcome,
  type DailyReportRunDeps,
  type PathCandidatesReader,
} from "./services/daily-report";
export { type LoopHealthEntry } from "../models/loop-health";
export {
  loopHealth,
  type LoopHealthLogger,
  type LoopHealthOptions,
} from "./services/loop-health";
export {
  DESK_KEEP_OPTIONS,
  DESK_SECTIONS,
  DESK_SECTION_LABELS,
  deskWeekKey,
  formatReviewDeskText,
  normalizeDeskOption,
  reviewDeskOwnerItemKey,
  type ComposeReviewDeskResult,
  type DeskItem,
  type DeskItemAction,
  type DeskSection,
  type DeskSectionView,
} from "../models/review-desk";
export {
  composeReviewDesk,
  runReviewDesk,
  type ComposeReviewDeskDeps,
  type DurabilitySectionHookResult,
  type ReviewDeskLogger,
  type ReviewDeskRunDeps,
  type ReviewDeskRunOutcome,
} from "./services/review-desk";
export {
  acceptDeskDefaults,
  answerDeskItem,
  type DeskAcceptDefaultsResult,
  type DeskAnswerDeps,
  type DeskAnswerResult,
} from "./services/review-desk-answers";
export { DESK_USAGE, runDeskCli } from "./handlers/desk-cli";
export { deskRpc, nextDeskDefaultAt } from "./handlers/desk-rpc";
export { runOwnerPush } from "./services/owner-push";
export { createTelegramSender } from "./services/telegram";
export {
  GRAPHS_LAST_EXPORT_AT_KEY,
  collectGraphDurability,
  composeDurabilityDeskSection,
  loadGraphDurability,
  readLastGraphExportAt,
  type DurabilityDeskItem,
  type DurabilitySummary,
} from "./services/durability";
