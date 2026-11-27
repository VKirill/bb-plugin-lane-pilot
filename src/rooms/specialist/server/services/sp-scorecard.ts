import { CONCLUSIVE_OUTCOME_VERDICTS, type OutcomeVerdict } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../../storage";
import { parseEvidenceEntries, parseJsonSafe, type RuleWindow, type SpRuleRow } from "../../models/sp-rule";
import { promotionCandidates } from "../repositories/sp-autonomy";
import { classifyProjectOutcome } from "../repositories/sp-hypotheses";
import type { IntentOutcomeRow } from "../repositories/sp-outcomes";
import { listProposedSharedRules } from "../repositories/sp-rules";

const DAY_MS = 86_400_000;
const ACTIVITY_WINDOW_DAYS = 7;
const CONCLUSIVE_WINDOW_DAYS = 56;
const MAX_LINE_LENGTH = 160;
const WEEKDAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const CONCLUSIVE_VERDICTS: ReadonlySet<OutcomeVerdict> = new Set(CONCLUSIVE_OUTCOME_VERDICTS);

export interface SpScorecardLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SpScorecardOptions {
  now?: number;
  log?: SpScorecardLogger;
}

export interface SpecialistScorecardEntry {
  caseId: string;
  line: string;
  conclusiveShare8w: number;
  askFor: string[];
}

function formatDomainLabel(domain: string): string {
  if (domain === "seo") return "SEO";
  if (domain === "marketing") return "Marketing";
  if (domain === "specialist_os") return "SpecialistOS";
  return domain ? `${domain[0]!.toUpperCase()}${domain.slice(1)}` : "Unknown";
}

function formatWeekdayRu(tsMs: number | null): string {
  if (tsMs === null || !Number.isFinite(tsMs)) return "нет";
  return WEEKDAYS_RU[new Date(tsMs).getUTCDay()] ?? "нет";
}

function clipText(text: string, maxLen: number): string {
  if (maxLen <= 0) return "";
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return "…";
  return `${text.slice(0, maxLen - 1).trimEnd()}…`;
}

function sharedRuleMatchesProject(rule: SpRuleRow, projectId: string): boolean {
  const sourceProjects = new Set<string>();
  const win = parseJsonSafe<Partial<RuleWindow>>(rule.window_json, {});
  if (Array.isArray(win.source_rules)) {
    for (const src of win.source_rules) {
      if (src && typeof src.project_id === "string" && src.project_id.trim()) {
        sourceProjects.add(src.project_id.trim());
      }
    }
  }
  for (const entry of parseEvidenceEntries(rule.evidence_json)) {
    if (typeof entry.project_id === "string" && entry.project_id.trim()) {
      sourceProjects.add(entry.project_id.trim());
    }
  }
  return sourceProjects.size === 0 || sourceProjects.has(projectId);
}

function formatScorecardLine(input: {
  domain: string;
  projectId: string;
  decisions7d: number;
  checked7d: number;
  worked7d: number;
  hypothesesInWork: number;
  nextWeekday: string;
  askFor: string[];
}): string {
  const domainLabel = formatDomainLabel(input.domain);
  const tail = `: решений ${input.decisions7d}, проверено ${input.checked7d}, сработало ${input.worked7d}; гипотез в работе ${input.hypothesesInWork}; следующая проверка ${input.nextWeekday}; просит: `;
  const maxProjectLen = Math.max(4, MAX_LINE_LENGTH - domainLabel.length - 1 - tail.length - 3);
  const projectLabel = clipText(input.projectId, maxProjectLen);
  const prefix = `${domainLabel}/${projectLabel}${tail}`;
  const budget = Math.max(0, MAX_LINE_LENGTH - prefix.length);
  const rawAsks = input.askFor.length > 0 ? input.askFor.join(", ") : "нет";
  return `${prefix}${clipText(rawAsks, budget)}`;
}

function listActiveCases(db: LanePilotDatabase, since7d: number): Array<{ project_id: string; domain: string }> {
  return db
    .prepare(
      `SELECT DISTINCT project_id, domain FROM (
         SELECT project_id, domain FROM lane_pilot_sp_intent WHERE created_at >= ? OR updated_at >= ?
         UNION
         SELECT project_id, domain FROM lane_pilot_sp_intent_outcome WHERE verdict != 'pending' AND COALESCE(measured_at, check_at) >= ?
         UNION
         SELECT project_id, domain FROM lane_pilot_sp_hypothesis WHERE created_at >= ? OR updated_at >= ?
         UNION
         SELECT project_id, domain FROM lane_pilot_sp_rule WHERE project_id IS NOT NULL AND (created_at >= ? OR (decided_at IS NOT NULL AND decided_at >= ?))
         UNION
         SELECT project_id, domain FROM lane_pilot_sp_dispatch WHERE created_at >= ?
         UNION
         SELECT project_id, domain FROM lane_pilot_sp_memory_commit WHERE created_at >= ?
       )
       ORDER BY project_id ASC, domain ASC`,
    )
    .all(since7d, since7d, since7d, since7d, since7d, since7d, since7d, since7d, since7d) as Array<{
    project_id: string;
    domain: string;
  }>;
}

function computeConclusiveShare8w(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  since8w: number,
): number {
  const rows = db
    .prepare(
      `SELECT verdict, COUNT(*) AS cnt
       FROM lane_pilot_sp_intent_outcome
       WHERE project_id = ? AND domain = ?
         AND verdict != 'pending'
         AND COALESCE(measured_at, check_at) >= ?
       GROUP BY verdict`,
    )
    .all(projectId, domain, since8w) as Array<{ verdict: OutcomeVerdict; cnt: number }>;

  let conclusive = 0;
  let nonPending = 0;
  for (const row of rows) {
    nonPending += row.cnt;
    if (CONCLUSIVE_VERDICTS.has(row.verdict)) {
      conclusive += row.cnt;
    }
  }
  return nonPending > 0 ? Number((conclusive / nonPending).toFixed(4)) : 0;
}

/**
 * Builds the weekly one-line progress scorecard per active employee `(project, domain)` case (activity in 7 days),
 * including 8-week conclusive verdict share and pending promotion / shared-rule asks.
 */
export function specialistScorecard(
  db: LanePilotDatabase,
  options: SpScorecardOptions = {},
  maybeLog?: SpScorecardLogger,
): SpecialistScorecardEntry[] {
  const now = options.now ?? Date.now();
  const log = options.log ?? maybeLog;
  const since7d = now - ACTIVITY_WINDOW_DAYS * DAY_MS;
  const since8w = now - CONCLUSIVE_WINDOW_DAYS * DAY_MS;

  const activeCases = listActiveCases(db, since7d);
  const proposedSharedRules = listProposedSharedRules(db);
  const sharedByDomain = new Map<string, SpRuleRow[]>();
  for (const rule of proposedSharedRules) {
    const list = sharedByDomain.get(rule.domain) ?? [];
    list.push(rule);
    sharedByDomain.set(rule.domain, list);
  }

  const decisionsStmt = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM lane_pilot_sp_intent
     WHERE project_id = ? AND domain = ? AND created_at >= ?`,
  );
  const checkedStmt = db.prepare(
    `SELECT *
     FROM lane_pilot_sp_intent_outcome
     WHERE project_id = ? AND domain = ?
       AND verdict IN ('within', 'above', 'below')
       AND COALESCE(measured_at, check_at) >= ?`,
  );
  const hypInWorkStmt = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM lane_pilot_sp_hypothesis
     WHERE project_id = ? AND domain = ? AND state IN ('open', 'testing')`,
  );
  const nextCheckStmt = db.prepare(
    `SELECT COALESCE(
       (SELECT MIN(check_at) FROM lane_pilot_sp_intent_outcome WHERE project_id = ? AND domain = ? AND verdict = 'pending' AND check_at >= ?),
       (SELECT MIN(check_at) FROM lane_pilot_sp_intent_outcome WHERE project_id = ? AND domain = ? AND verdict = 'pending')
     ) AS next_check_at`,
  );

  const entries: SpecialistScorecardEntry[] = activeCases.map(({ project_id: projectId, domain }) => {
    const decisions7d = (decisionsStmt.get(projectId, domain, since7d) as { cnt: number }).cnt;
    const checkedRows = checkedStmt.all(projectId, domain, since7d) as IntentOutcomeRow[];
    const checked7d = checkedRows.length;
    const worked7d = checkedRows.filter(
      (row) => classifyProjectOutcome(db, projectId, domain, row) === "favourable",
    ).length;
    const hypothesesInWork = (hypInWorkStmt.get(projectId, domain) as { cnt: number }).cnt;
    const nextCheckRow = nextCheckStmt.get(projectId, domain, now, projectId, domain) as {
      next_check_at: number | null;
    };
    const nextWeekday = formatWeekdayRu(nextCheckRow.next_check_at);

    const promoAsks = promotionCandidates(db, { projectId, domain, now }).map(
      (candidate) => `auto:${candidate.action_class}`,
    );
    const sharedAsks = (sharedByDomain.get(domain) ?? [])
      .filter((rule) => sharedRuleMatchesProject(rule, projectId))
      .map((rule) => `rule:${rule.text}`);
    const askFor = [...promoAsks, ...sharedAsks];

    const line = formatScorecardLine({
      domain,
      projectId,
      decisions7d,
      checked7d,
      worked7d,
      hypothesesInWork,
      nextWeekday,
      askFor,
    });

    return {
      caseId: `${projectId}:${domain}`,
      line,
      conclusiveShare8w: computeConclusiveShare8w(db, projectId, domain, since8w),
      askFor,
    };
  });

  log?.debug?.(`sp scorecard cases=${entries.length}`);
  return entries;
}

export interface SpecialistCaseConclusiveEntry {
  caseId: string;
  conclusiveCount8w: number;
  inconclusiveCount8w: number;
  totalVerdicts8w: number;
  conclusiveShare8w: number;
}

export interface SpecialistConclusiveHealth8w {
  conclusiveCount8w: number;
  inconclusiveCount8w: number;
  totalVerdicts8w: number;
  conclusiveShare8w: number | null;
  cases: SpecialistCaseConclusiveEntry[];
}

/** Aggregates 8-week conclusive vs inconclusive verdict counts across all employee cases for loop health evaluation. */
export function specialistConclusiveHealth8w(
  db: LanePilotDatabase,
  options: { now?: number; windowDays?: number } = {},
): SpecialistConclusiveHealth8w {
  const hasTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_sp_intent_outcome'").get(),
  );
  if (!hasTable) {
    return { conclusiveCount8w: 0, inconclusiveCount8w: 0, totalVerdicts8w: 0, conclusiveShare8w: null, cases: [] };
  }
  const now = options.now ?? Date.now();
  const since8w = now - (options.windowDays ?? CONCLUSIVE_WINDOW_DAYS) * DAY_MS;
  const rows = db
    .prepare(
      `SELECT project_id, domain, verdict, COUNT(*) AS cnt
       FROM lane_pilot_sp_intent_outcome
       WHERE verdict != 'pending'
         AND COALESCE(measured_at, check_at) >= ?
       GROUP BY project_id, domain, verdict
       ORDER BY project_id ASC, domain ASC`,
    )
    .all(since8w) as Array<{ project_id: string; domain: string; verdict: OutcomeVerdict; cnt: number }>;

  const byCase = new Map<string, { conclusive: number; inconclusive: number }>();
  let conclusiveCount8w = 0;
  let inconclusiveCount8w = 0;
  for (const row of rows) {
    const caseId = `${row.project_id}:${row.domain}`;
    const bucket = byCase.get(caseId) ?? { conclusive: 0, inconclusive: 0 };
    if (CONCLUSIVE_VERDICTS.has(row.verdict)) {
      bucket.conclusive += row.cnt;
      conclusiveCount8w += row.cnt;
    } else {
      bucket.inconclusive += row.cnt;
      inconclusiveCount8w += row.cnt;
    }
    byCase.set(caseId, bucket);
  }

  const cases: SpecialistCaseConclusiveEntry[] = [...byCase.entries()].map(([caseId, bucket]) => {
    const total = bucket.conclusive + bucket.inconclusive;
    return {
      caseId,
      conclusiveCount8w: bucket.conclusive,
      inconclusiveCount8w: bucket.inconclusive,
      totalVerdicts8w: total,
      conclusiveShare8w: total > 0 ? Number((bucket.conclusive / total).toFixed(4)) : 0,
    };
  });

  const totalVerdicts8w = conclusiveCount8w + inconclusiveCount8w;
  return {
    conclusiveCount8w,
    inconclusiveCount8w,
    totalVerdicts8w,
    conclusiveShare8w: totalVerdicts8w > 0 ? Number((conclusiveCount8w / totalVerdicts8w).toFixed(4)) : null,
    cases,
  };
}
