import { LEARNED_DRAFT_SOURCES, listDraftsBySources, type DraftRow } from "@lane-pilot/workflow-engine";
import type { RoadRow } from "../../../contracts";
import { listHypotheses, type EvolveHypothesisRow } from "../../../evolve/server";
import { listRoad } from "../../../lead/server";
import { collectOwnerWaiting, postOwnerItem, type OwnerItem } from "../../../owner-waiting";
import { loadPushConfig } from "../../../owner-waiting/server";
import {
  listProposedSharedRules,
  promotionCandidates,
  specialistScorecard,
  type PromotionCandidate,
  type SpRuleRow,
  type SpecialistScorecardEntry,
} from "../../../specialist/server";
import type { LanePilotDatabase } from "../../../storage";
import type { LoopHealthEntry } from "../../models/loop-health";
import {
  DESK_SECTION_LABELS,
  DESK_SECTIONS,
  deskWeekKey,
  formatReviewDeskText,
  reviewDeskOwnerItemKey,
  type ComposeReviewDeskResult,
  type DeskItem,
  type DeskSection,
  type DeskSectionView,
} from "../../models/review-desk";
import { TelegramNotReadyError, type TelegramSend } from "../../models/telegram";
import { loopHealth } from "./loop-health";
import { composeDurabilityDeskSection } from "./durability";

const CANDIDATE_LIMIT = 5;
const CANDIDATE_CLASSES = new Set(["process", "branch"]);
const AWAITING_DRAFT_SOURCES = LEARNED_DRAFT_SOURCES.filter((source) => source !== "evolve");

export type ReviewDeskLogger =
  | ((message: string) => void)
  | { info?: (message: string) => void; warn?: (message: string) => void; debug?: (message: string) => void };

export type DurabilitySectionHookResult =
  | DeskItem[]
  | { summaryLine?: string; items?: DeskItem[] };

export type ComposeReviewDeskDeps = {
  timezone?: string;
  log?: ReviewDeskLogger;
  listRoadCandidates?: (db: LanePilotDatabase) => RoadRow[];
  listPendingDrafts?: (db: LanePilotDatabase) => DraftRow[];
  listEvolveHypotheses?: (db: LanePilotDatabase) => EvolveHypothesisRow[];
  readEmployee?: (
    db: LanePilotDatabase,
    now: number,
  ) => {
    scorecards: SpecialistScorecardEntry[];
    promotions: PromotionCandidate[];
    sharedRules: SpRuleRow[];
  };
  listDeferredItems?: (db: LanePilotDatabase, now: number) => OwnerItem[];
  readLoopHealth?: (db: LanePilotDatabase, now: number) => LoopHealthEntry[];
  durability?: (input: { db: LanePilotDatabase; now: number }) => DurabilitySectionHookResult;
};

export type ReviewDeskRunDeps = {
  db: LanePilotDatabase;
  now: number;
  send: TelegramSend;
  log: ReviewDeskLogger;
  composeDeps?: ComposeReviewDeskDeps;
};

export type ReviewDeskRunOutcome = {
  sent: boolean;
  reason: string;
  week: string;
  items: number;
  text: string;
};

export function emitDeskInfo(log: ReviewDeskLogger | undefined, message: string): void {
  if (!log) return;
  if (typeof log === "function") log(message);
  else log.info?.(message);
}

export function emitDeskWarn(log: ReviewDeskLogger | undefined, message: string): void {
  if (!log) return;
  if (typeof log === "function") log(message);
  else log.warn?.(message);
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function candidateRank(row: RoadRow, payload: Record<string, unknown> | null): { score: number; lastSeen: number } {
  const count = typeof payload?.count === "number" && Number.isFinite(payload.count) ? payload.count : 1;
  const cost = typeof payload?.costMicroUsd === "number" && Number.isFinite(payload.costMicroUsd) ? payload.costMicroUsd : 0;
  const lastSeen = typeof payload?.lastSeen === "number" && Number.isFinite(payload.lastSeen)
    ? payload.lastSeen
    : (row.proposed_at ?? row.created_at);
  return { score: count * Math.max(cost, 1), lastSeen };
}

function safeTimezone(db: LanePilotDatabase, override?: string): string {
  if (override) return override;
  try {
    return loadPushConfig(db).timezone;
  } catch {
    return "UTC";
  }
}

function readCandidatesSection(db: LanePilotDatabase, deps: ComposeReviewDeskDeps): DeskItem[] {
  const rows = (deps.listRoadCandidates
    ? deps.listRoadCandidates(db)
    : listRoad(db, { state: "proposed" }).filter((row) => row.class !== null && CANDIDATE_CLASSES.has(row.class)));

  const ranked = rows
    .filter((row) => row.state === "proposed" && row.class !== null && CANDIDATE_CLASSES.has(row.class))
    .map((row) => {
      const payload = parseJsonObject(row.payload_json);
      return { row, payload, ...candidateRank(row, payload) };
    })
    .sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen || a.row.id.localeCompare(b.row.id))
    .slice(0, CANDIDATE_LIMIT);

  return ranked.map(({ row, payload }) => ({
    id: `road:${row.id}`,
    section: "candidates",
    title: `${row.class}: ${row.title}`,
    default: "later",
    options: ["save as draft", "later", "reject"],
    action: {
      kind: "road",
      roadId: row.id,
      roadClass: row.class,
      projectId: row.project_id,
      payload,
    },
  }));
}

function readDraftsSection(db: LanePilotDatabase, deps: ComposeReviewDeskDeps): DeskItem[] {
  const rows = deps.listPendingDrafts
    ? deps.listPendingDrafts(db)
    : listDraftsBySources(db as never, AWAITING_DRAFT_SOURCES);

  return rows
    .filter((draft) => draft.status !== "published")
    .map((draft) => {
      const source = typeof draft.metadata?.source === "string" ? draft.metadata.source : "draft";
      return {
        id: `draft:${draft.id}`,
        section: "drafts" as const,
        title: `${draft.workflowId} (${source}, ${draft.status})`,
        default: "keep draft",
        options: ["publish", "keep draft", "delete"],
        action: {
          kind: "draft" as const,
          draftId: draft.id,
          workflowId: draft.workflowId,
          projectId: draft.projectId,
          threadId: draft.threadId,
        },
      };
    });
}

function evolveGainOf(hyp: EvolveHypothesisRow): string {
  const sc = parseJsonObject(hyp.scorecardJson);
  const comp = sc && typeof sc.comparison === "object" && sc.comparison !== null ? (sc.comparison as Record<string, unknown>) : null;
  return typeof comp?.gain === "string" && comp.gain ? comp.gain : "unknown";
}

function readEvolveSection(db: LanePilotDatabase, deps: ComposeReviewDeskDeps): DeskItem[] {
  const hyps = deps.listEvolveHypotheses
    ? deps.listEvolveHypotheses(db)
    : listHypotheses(db, { state: "report_only" });

  return hyps.map((hyp) => {
    const gain = evolveGainOf(hyp);
    const defaultOption = gain === "none" || gain === "unknown" ? "reject" : "approve";
    return {
      id: `evolve:${hyp.id}`,
      section: "evolve",
      title: `${hyp.workflowId}.${hyp.nodeId} (${hyp.armKind}, gain=${gain})`,
      default: defaultOption,
      options: ["approve", "reject"],
      action: {
        kind: "evolve",
        hypothesisId: hyp.id,
        workflowId: hyp.workflowId,
      },
    };
  });
}

function readEmployeeSection(db: LanePilotDatabase, deps: ComposeReviewDeskDeps, now: number): DeskItem[] {
  const data = deps.readEmployee
    ? deps.readEmployee(db, now)
    : {
        scorecards: specialistScorecard(db, { now }),
        promotions: promotionCandidates(db, { now }),
        sharedRules: listProposedSharedRules(db),
      };

  const items: DeskItem[] = [];
  for (const sc of data.scorecards) {
    items.push({
      id: `scorecard:${sc.caseId}`,
      section: "employee",
      title: sc.line,
      default: "keep",
      options: ["keep"],
      action: { kind: "noop" },
    });
  }
  for (const promo of data.promotions) {
    items.push({
      id: `autonomy:${promo.project_id}:${promo.domain}:${promo.action_class}`,
      section: "employee",
      title: `Promote ${promo.project_id}/${promo.domain} ${promo.action_class} -> bounded_auto (n=${promo.samples_n}, wilson=${promo.wilson_lb.toFixed(2)})`,
      default: "keep propose",
      options: ["grant bounded_auto", "keep propose"],
      action: {
        kind: "autonomy",
        projectId: promo.project_id,
        domain: promo.domain,
        actionClass: promo.action_class,
      },
    });
  }
  for (const rule of data.sharedRules) {
    items.push({
      id: `rule:${rule.id}`,
      section: "employee",
      title: `Share rule (${rule.domain}): ${rule.text}`,
      default: "keep local",
      options: ["activate shared", "keep local"],
      action: {
        kind: "shared_rule",
        ruleId: rule.id,
        domain: rule.domain,
      },
    });
  }
  return items;
}

function readDeferredSection(db: LanePilotDatabase, deps: ComposeReviewDeskDeps, now: number): DeskItem[] {
  const items = deps.listDeferredItems
    ? deps.listDeferredItems(db, now)
    : collectOwnerWaiting(db, now).items.filter((item) => item.desk === true && !item.key.startsWith("review-desk:"));

  return items.map((item) => {
    const options = [...new Set([...item.actions.map((a) => a.id), "keep", "dismiss"])];
    return {
      id: `deferred:${item.key}`,
      section: "deferred",
      title: item.what,
      default: "keep",
      options,
      action: {
        kind: "deferred",
        ownerItemKey: item.key,
        actions: item.actions,
      },
    };
  });
}

function readLoopHealthSection(
  db: LanePilotDatabase,
  deps: ComposeReviewDeskDeps,
  now: number,
): { items: DeskItem[]; summaryLine?: string } {
  const entries = deps.readLoopHealth ? deps.readLoopHealth(db, now) : loopHealth(db, { now });
  const failing = entries.filter((entry) => entry.failing);
  if (failing.length === 0) {
    return { items: [], summaryLine: `${entries.length}/${entries.length} loops healthy` };
  }
  return {
    items: failing.map((entry) => ({
      id: `loop:${entry.loop}`,
      section: "loop-health",
      title: `Loop ${entry.loop} failing (mode=${entry.mode}, ${String(entry.evidence.reason ?? "failing")})`,
      default: "switch to report-only",
      options: ["switch to report-only", "keep", "turn off"],
      action: {
        kind: "loop_health",
        loop: entry.loop,
        currentMode: entry.mode,
      },
    })),
  };
}

function defaultDurability(db: LanePilotDatabase): DurabilitySectionHookResult {
  const section = composeDurabilityDeskSection(db);
  return {
    summaryLine: section.text.split("\n")[0],
    items: section.items.map((item) => ({
      id: item.id,
      section: "durability",
      title: `${item.title} — run \`${item.action.cli}\` in the checkout`,
      default: item.default,
      options: [...item.options],
      action: { kind: "noop" },
    })),
  };
}

function readDurabilitySection(
  db: LanePilotDatabase,
  deps: ComposeReviewDeskDeps,
  now: number,
): { items: DeskItem[]; summaryLine?: string } {
  // Export writes the git checkout, which the hub cannot reach: the item only names the command to run there.
  const res = deps.durability ? deps.durability({ db, now }) : defaultDurability(db);
  const rawItems = Array.isArray(res) ? res : (res.items ?? []);
  const summaryLine = Array.isArray(res) ? undefined : res.summaryLine;
  return {
    items: rawItems.map((item) => ({ ...item, section: "durability" })),
    ...(summaryLine ? { summaryLine } : {}),
  };
}

/** Composes all 7 M18 weekly review desk sections in independent try/catch guards with pre-selected defaults. */
export function composeReviewDesk(
  db: LanePilotDatabase,
  deps: ComposeReviewDeskDeps = {},
  options: { now?: number } = {},
): ComposeReviewDeskResult {
  const now = options.now ?? Date.now();
  const timezone = safeTimezone(db, deps.timezone);
  const week = deskWeekKey(now, timezone);

  const sectionSpecs: Array<{
    section: DeskSection;
    run: () => { items: DeskItem[]; summaryLine?: string };
  }> = [
    { section: "candidates", run: () => ({ items: readCandidatesSection(db, deps) }) },
    { section: "drafts", run: () => ({ items: readDraftsSection(db, deps) }) },
    { section: "evolve", run: () => ({ items: readEvolveSection(db, deps) }) },
    { section: "employee", run: () => ({ items: readEmployeeSection(db, deps, now) }) },
    { section: "deferred", run: () => ({ items: readDeferredSection(db, deps, now) }) },
    { section: "loop-health", run: () => readLoopHealthSection(db, deps, now) },
    { section: "durability", run: () => readDurabilitySection(db, deps, now) },
  ];

  const views: DeskSectionView[] = [];
  const allItems: DeskItem[] = [];
  const failedSections: DeskSection[] = [];

  for (const spec of sectionSpecs) {
    try {
      const out = spec.run();
      views.push({
        section: spec.section,
        label: DESK_SECTION_LABELS[spec.section],
        items: out.items,
        failed: false,
        ...(out.summaryLine ? { summaryLine: out.summaryLine } : {}),
      });
      allItems.push(...out.items);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      emitDeskWarn(deps.log, `review desk section failed: ${spec.section}: ${message}`);
      failedSections.push(spec.section);
      views.push({
        section: spec.section,
        label: DESK_SECTION_LABELS[spec.section],
        items: [],
        failed: true,
      });
    }
  }

  emitDeskInfo(
    deps.log,
    `review desk items=${allItems.length} sections=${DESK_SECTIONS.length} failed=${failedSections.length}`,
  );

  const text = formatReviewDeskText(week, views);
  return { text, items: allItems, week, failedSections };
}

/** Composes the weekly review desk, opens one `review-desk:<week>` decision item, and sends the <=40-line summary to Telegram. */
export async function runReviewDesk(deps: ReviewDeskRunDeps): Promise<ReviewDeskRunOutcome> {
  const cfg = loadPushConfig(deps.db);
  const desk = composeReviewDesk(
    deps.db,
    { ...deps.composeDeps, timezone: cfg.timezone, log: deps.log },
    { now: deps.now },
  );

  if (desk.items.length > 0) {
    postOwnerItem(
      deps.db,
      {
        key: reviewDeskOwnerItemKey(desk.week),
        source: "reports",
        kind: "review_desk",
        reason: "decision",
        wake: false,
        what: `Еженедельный разбор (${desk.week}): ${desk.items.length} решений`,
        why: desk.text,
        evidence: desk.items.slice(0, 8).map((item) => ({
          kind: "note" as const,
          ref: item.id,
          label: `${item.section}: ${item.title}`.slice(0, 120),
        })),
        actions: [
          { id: "accept_defaults", label: "Принять по умолчанию", cli: "bb lane-pilot desk accept-defaults" },
          { id: "show", label: "Показать разбор", cli: "bb lane-pilot desk show" },
        ],
      },
      deps.now,
      (msg) => emitDeskWarn(deps.log, msg),
    );
  }

  if (cfg.dryRun === true) {
    emitDeskInfo(deps.log, `[review-desk dry-run ${desk.week}]\n${desk.text}`);
    return { sent: false, reason: "dry_run", week: desk.week, items: desk.items.length, text: desk.text };
  }

  try {
    await deps.send(desk.text);
  } catch (cause) {
    const reason = cause instanceof TelegramNotReadyError ? "telegram_not_ready" : "send_failed";
    emitDeskWarn(deps.log, `review desk: ${reason}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { sent: false, reason, week: desk.week, items: desk.items.length, text: desk.text };
  }

  return { sent: true, reason: "", week: desk.week, items: desk.items.length, text: desk.text };
}
