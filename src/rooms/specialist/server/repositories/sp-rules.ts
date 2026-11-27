import { randomUUID } from "node:crypto";
import type { LanePilotDatabase } from "../../../storage";
import {
  formatUncertainty,
  isMeasuredOutcome,
  normalizeRuleText,
  type OutcomeWithOrderRow,
  parseEvidenceEntries,
  parseJsonSafe,
  resolveWindowFromOutcomes,
  type RuleActionResult,
  type RuleEvidenceEntry,
  type RuleSnapshotEntry,
  type RuleWindow,
  type SpRuleLogger,
  type SpRuleRow,
  toEvidenceEntry,
} from "../../models/sp-rule";
import { classifyProjectOutcome, type SpHypothesisRow } from "./sp-hypotheses";
import type { IntentOutcomeRow } from "./sp-outcomes";

export {
  type SpRuleLogger,
  type SpRuleRow,
  type RuleWindow,
  type RuleEvidenceEntry,
  type RuleSnapshotEntry,
  type RuleActionResult,
  normalizeRuleText,
};

const SNAPSHOT_RULES_MAX = 15;

function refuse(reason: string, log?: SpRuleLogger, extra?: { contradictions?: number }): RuleActionResult {
  log?.warn?.(`sp rule refused: ${reason}`);
  return { ok: false, reason, ...extra };
}

function verifyMeasuredEvidence(
  db: LanePilotDatabase,
  evidenceJson: string,
  domain: string,
  projectId?: string,
): IntentOutcomeRow[] {
  const entries = parseEvidenceEntries(evidenceJson).filter((e) => e.contradicts !== true);
  const intentIds = [...new Set(entries.map((e) => e.intent_id.trim()).filter(Boolean))];
  if (intentIds.length === 0) return [];
  const ph = intentIds.map(() => "?").join(",");
  const rows = (
    projectId
      ? db
          .prepare(`SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id IN (${ph}) AND project_id = ? AND domain = ?`)
          .all(...intentIds, projectId, domain)
      : db
          .prepare(`SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id IN (${ph}) AND domain = ?`)
          .all(...intentIds, domain)
  ) as IntentOutcomeRow[];
  return rows.filter(isMeasuredOutcome);
}

/**
 * Creates (or refreshes) an active business-local rule from a `worked` hypothesis with measured intent outcomes.
 * Refuses any hypothesis without measured intent outcome evidence (`no_measured_evidence`).
 */
export function proposeLocalRule(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    domain: string;
    hypothesisId: string;
    text?: string;
    comparison?: "pre/post" | "holdout";
    nowMs?: number;
  },
  log?: SpRuleLogger,
): RuleActionResult {
  const projectId = input.projectId.trim();
  const domain = input.domain.trim();
  const hypothesisId = input.hypothesisId.trim();
  if (!projectId || !domain || !hypothesisId) return refuse("invalid_input", log);

  const now = input.nowMs ?? Date.now();
  const hyp = db.prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE id = ?").get(hypothesisId) as SpHypothesisRow | undefined;
  if (!hyp || hyp.project_id !== projectId || hyp.domain !== domain) return refuse("unknown_hypothesis", log);

  const outcomeRows = db
    .prepare(
      `SELECT o.*, i.order_json AS intent_order_json, i.created_at AS intent_created_at
       FROM lane_pilot_sp_intent_outcome o
       LEFT JOIN lane_pilot_sp_intent i ON i.intent_id = o.intent_id
       WHERE o.hypothesis_id = ? AND o.project_id = ? AND o.domain = ?
       ORDER BY COALESCE(o.measured_at, o.check_at) ASC, o.intent_id ASC`,
    )
    .all(hyp.id, projectId, domain) as OutcomeWithOrderRow[];

  const measured = outcomeRows.filter(isMeasuredOutcome);
  if (measured.length === 0) return refuse("no_measured_evidence", log);
  if (hyp.state !== "worked") return refuse(`hypothesis_${hyp.state}`, log);

  const favourable = measured.filter((o) => classifyProjectOutcome(db, projectId, domain, o) === "favourable");
  if (favourable.length === 0) return refuse("no_favourable_evidence", log);

  const ruleText = input.text?.trim() || hyp.title.trim();
  if (!ruleText) return refuse("empty_rule_text", log);

  const evidence = measured.map((o) => toEvidenceEntry(o));
  const windowObj = resolveWindowFromOutcomes(measured, hyp.created_at, input.comparison);
  const uncertainty = formatUncertainty(measured);

  const normText = normalizeRuleText(ruleText);
  const existingActive = (
    db
      .prepare(
        `SELECT * FROM lane_pilot_sp_rule
         WHERE project_id = ? AND domain = ? AND scope = 'local' AND state = 'active'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(projectId, domain) as SpRuleRow[]
  ).find((r) => normalizeRuleText(r.text) === normText);

  if (existingActive) {
    db.prepare(
      `UPDATE lane_pilot_sp_rule
       SET evidence_json = ?, window_json = ?, uncertainty = ?, decided_at = ?
       WHERE id = ?`,
    ).run(JSON.stringify(evidence), JSON.stringify(windowObj), uncertainty, now, existingActive.id);
    const updated = db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(existingActive.id) as SpRuleRow;
    log?.info?.(`sp rule id=${updated.id} scope=local state=active`);
    return { ok: true, rule: updated, id: updated.id, scope: "local", state: "active" };
  }

  const id = `spr_${randomUUID()}`;
  db.prepare(
    `INSERT INTO lane_pilot_sp_rule
      (id, domain, project_id, scope, text, evidence_json, window_json, uncertainty, state, created_at, decided_at)
     VALUES (?, ?, ?, 'local', ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, domain, projectId, ruleText, JSON.stringify(evidence), JSON.stringify(windowObj), uncertainty, now, now);

  const created = db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(id) as SpRuleRow;
  log?.info?.(`sp rule id=${id} scope=local state=active`);
  return { ok: true, rule: created, id, scope: "local", state: "active" };
}

/**
 * Proposes a cross-business `shared` rule (`state = 'proposed'`, `project_id = NULL`) from active `local` rules.
 * Requires matching normalized text across >= 2 projects, each with >= 2 verified favourable outcomes.
 */
export function proposeSharedRule(
  db: LanePilotDatabase,
  input: { domain: string; ruleIds: string[]; nowMs?: number },
  log?: SpRuleLogger,
): RuleActionResult {
  const domain = input.domain.trim();
  const uniqueIds = [...new Set((input.ruleIds ?? []).map((s) => s.trim()).filter(Boolean))];
  if (!domain || uniqueIds.length < 2) return refuse("insufficient_projects", log);

  const placeholders = uniqueIds.map(() => "?").join(",");
  const rules = db.prepare(`SELECT * FROM lane_pilot_sp_rule WHERE id IN (${placeholders})`).all(...uniqueIds) as SpRuleRow[];

  if (rules.length !== uniqueIds.length) return refuse("unknown_rule", log);
  if (rules.some((r) => r.domain !== domain)) return refuse("domain_mismatch", log);
  if (rules.some((r) => r.scope !== "local" || r.state !== "active" || !r.project_id)) return refuse("rule_not_active_local", log);
  if (new Set(rules.map((r) => normalizeRuleText(r.text))).size !== 1) return refuse("text_mismatch", log);

  const favourableByProject = new Map<string, Set<string>>();
  const combinedEvidence: RuleEvidenceEntry[] = [];
  const seenIntentIds = new Set<string>();
  let comparison: "pre/post" | "holdout" = "pre/post";
  let maxDays = 0;

  for (const rule of rules) {
    const proj = rule.project_id!;
    const measured = verifyMeasuredEvidence(db, rule.evidence_json, domain, proj);
    if (measured.length === 0) return refuse("no_measured_evidence", log);

    const projSet = favourableByProject.get(proj) ?? new Set<string>();
    favourableByProject.set(proj, projSet);
    for (const row of measured) {
      if (classifyProjectOutcome(db, proj, domain, row) === "favourable") projSet.add(row.intent_id);
      if (!seenIntentIds.has(row.intent_id)) {
        seenIntentIds.add(row.intent_id);
        combinedEvidence.push(toEvidenceEntry(row, { project_id: proj, rule_id: rule.id }));
      }
    }

    const win = parseJsonSafe<Partial<RuleWindow>>(rule.window_json, {});
    if (win.comparison === "holdout") comparison = "holdout";
    if (typeof win.measurement_days === "number" && Number.isFinite(win.measurement_days)) {
      maxDays = Math.max(maxDays, win.measurement_days);
    }
  }

  if (favourableByProject.size < 2) return refuse("insufficient_projects", log);
  const qualifiedProjects = [...favourableByProject.values()].filter((ids) => ids.size >= 2);
  if (qualifiedProjects.length < 2 || qualifiedProjects.length < favourableByProject.size) {
    return refuse("insufficient_favourable_outcomes", log);
  }

  const now = input.nowMs ?? Date.now();
  const id = `spr_${randomUUID()}`;
  const windowObj: RuleWindow = {
    comparison,
    measurement_days: maxDays > 0 ? maxDays : 14,
    source_rules: rules.map((r) => ({ id: r.id, project_id: r.project_id })),
  };

  db.prepare(
    `INSERT INTO lane_pilot_sp_rule
      (id, domain, project_id, scope, text, evidence_json, window_json, uncertainty, state, created_at, decided_at)
     VALUES (?, ?, NULL, 'shared', ?, ?, ?, ?, 'proposed', ?, NULL)`,
  ).run(id, domain, rules[0]!.text.trim(), JSON.stringify(combinedEvidence), JSON.stringify(windowObj), formatUncertainty(combinedEvidence), now);

  const created = db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(id) as SpRuleRow;
  log?.info?.(`sp rule id=${id} scope=shared state=proposed`);
  return { ok: true, rule: created, id, scope: "shared", state: "proposed" };
}

/** Activates a proposed cross-business `shared` rule. Owner-only (`by === "owner"`). */
export function activateSharedRule(
  db: LanePilotDatabase,
  id: string,
  by: "owner" | (string & {}),
  optsOrLog?: SpRuleLogger | { nowMs?: number; log?: SpRuleLogger },
  maybeLog?: SpRuleLogger,
): RuleActionResult {
  const opts = optsOrLog && ("nowMs" in optsOrLog || "log" in optsOrLog) ? optsOrLog : undefined;
  const log = opts ? (opts.log ?? maybeLog) : (optsOrLog as SpRuleLogger | undefined) ?? maybeLog;
  const now = opts?.nowMs ?? Date.now();

  if (by.trim() !== "owner") return refuse("owner_required", log);

  const ruleId = id.trim();
  const row = ruleId ? (db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(ruleId) as SpRuleRow | undefined) : undefined;
  if (!row) return refuse("unknown_rule", log);
  if (row.scope !== "shared") return refuse("not_shared_rule", log);
  if (row.state !== "proposed") return refuse(`rule_${row.state}`, log);

  if (verifyMeasuredEvidence(db, row.evidence_json, row.domain).length === 0) {
    return refuse("no_measured_evidence", log);
  }

  db.prepare("UPDATE lane_pilot_sp_rule SET state = 'active', decided_at = ? WHERE id = ? AND state = 'proposed'").run(now, row.id);
  const updated = db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(row.id) as SpRuleRow;
  log?.info?.(`sp rule id=${updated.id} scope=shared state=active`);
  return { ok: true, rule: updated, id: updated.id, scope: "shared", state: "active" };
}

function collectLaterOutcomesForRule(
  db: LanePilotDatabase,
  rule: SpRuleRow,
  supportingIntentIds: ReadonlySet<string>,
  linkedHypIds: ReadonlySet<string>,
  explicitIntentIds?: readonly string[],
): IntentOutcomeRow[] {
  const scoped = rule.scope === "local" && rule.project_id;
  if (explicitIntentIds && explicitIntentIds.length > 0) {
    const clean = [...new Set(explicitIntentIds.map((s) => s.trim()).filter(Boolean))];
    if (clean.length === 0) return [];
    const ph = clean.map(() => "?").join(",");
    const rows = (
      scoped
        ? db.prepare(`SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id IN (${ph}) AND domain = ? AND project_id = ?`).all(...clean, rule.domain, rule.project_id)
        : db.prepare(`SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id IN (${ph}) AND domain = ?`).all(...clean, rule.domain)
    ) as IntentOutcomeRow[];
    return rows.filter((o) => !supportingIntentIds.has(o.intent_id));
  }

  const normRuleText = normalizeRuleText(rule.text);
  const matchingHyps = (
    scoped
      ? db.prepare("SELECT id, title FROM lane_pilot_sp_hypothesis WHERE domain = ? AND project_id = ?").all(rule.domain, rule.project_id)
      : db.prepare("SELECT id, title FROM lane_pilot_sp_hypothesis WHERE domain = ?").all(rule.domain)
  ) as Array<{ id: string; title: string }>;

  const hypIds = new Set<string>(linkedHypIds);
  for (const h of matchingHyps) {
    if (normalizeRuleText(h.title) === normRuleText) hypIds.add(h.id);
  }
  if (hypIds.size === 0) return [];

  const ph = [...hypIds].map(() => "?").join(",");
  const sql = scoped
    ? `SELECT * FROM lane_pilot_sp_intent_outcome WHERE hypothesis_id IN (${ph}) AND domain = ? AND project_id = ? ORDER BY COALESCE(measured_at, check_at) ASC, intent_id ASC`
    : `SELECT * FROM lane_pilot_sp_intent_outcome WHERE hypothesis_id IN (${ph}) AND domain = ? ORDER BY COALESCE(measured_at, check_at) ASC, intent_id ASC`;
  const rows = (scoped ? db.prepare(sql).all(...hypIds, rule.domain, rule.project_id) : db.prepare(sql).all(...hypIds, rule.domain)) as IntentOutcomeRow[];
  return rows.filter((o) => !supportingIntentIds.has(o.intent_id));
}

/** Retires an active rule when >= 2 later linked intent outcomes contradict it (unfavourable verdict). */
export function retireRule(
  db: LanePilotDatabase,
  input: string | { ruleId: string; intentIds?: string[]; nowMs?: number; quietIfInsufficient?: boolean },
  log?: SpRuleLogger,
): RuleActionResult {
  const opts = typeof input === "string" ? { ruleId: input } : input;
  const ruleId = opts.ruleId.trim();
  const now = opts.nowMs ?? Date.now();
  const quiet = opts.quietIfInsufficient === true;

  const rule = ruleId ? (db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(ruleId) as SpRuleRow | undefined) : undefined;
  if (!rule) return refuse("unknown_rule", log);
  if (rule.state === "retired") return refuse("already_retired", log);
  if (rule.state !== "active") return refuse("rule_not_active", log);

  const existingEvidence = parseEvidenceEntries(rule.evidence_json);
  const supportingIntentIds = new Set<string>();
  const linkedHypIds = new Set<string>();
  for (const entry of existingEvidence) {
    if (entry.contradicts !== true) supportingIntentIds.add(entry.intent_id);
    if (entry.hypothesis_id) linkedHypIds.add(entry.hypothesis_id);
  }

  const candidates = collectLaterOutcomesForRule(db, rule, supportingIntentIds, linkedHypIds, opts.intentIds);
  const contradicting: IntentOutcomeRow[] = [];
  const seen = new Set<string>();
  for (const out of candidates) {
    if (seen.has(out.intent_id) || !isMeasuredOutcome(out)) continue;
    if (classifyProjectOutcome(db, out.project_id, out.domain, out) === "unfavourable") {
      seen.add(out.intent_id);
      contradicting.push(out);
    }
  }

  if (contradicting.length < 2) {
    if (!quiet) return refuse("insufficient_contradictions", log, { contradictions: contradicting.length });
    return { ok: false, reason: "insufficient_contradictions", contradictions: contradicting.length };
  }

  const existingIds = new Set(existingEvidence.map((e) => e.intent_id));
  const nextEvidence = [
    ...existingEvidence,
    ...contradicting.filter((c) => !existingIds.has(c.intent_id)).map((c) => toEvidenceEntry(c, { project_id: c.project_id, contradicts: true })),
  ];

  db.prepare("UPDATE lane_pilot_sp_rule SET state = 'retired', evidence_json = ?, decided_at = ? WHERE id = ? AND state = 'active'").run(
    JSON.stringify(nextEvidence),
    now,
    rule.id,
  );
  const updated = db.prepare("SELECT * FROM lane_pilot_sp_rule WHERE id = ?").get(rule.id) as SpRuleRow;
  log?.info?.(`sp rule id=${updated.id} scope=${updated.scope} state=retired`);
  return { ok: true, rule: updated, id: updated.id, scope: updated.scope, state: "retired" };
}

/** Sweeps active local (for `projectId`) and shared rules in `domain`, retiring any with >= 2 contradicting outcomes. */
export function retireContradictedRules(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; nowMs?: number },
  log?: SpRuleLogger,
): SpRuleRow[] {
  const activeRows = db
    .prepare(
      `SELECT id FROM lane_pilot_sp_rule
       WHERE domain = ? AND state = 'active'
         AND ((scope = 'local' AND project_id = ?) OR (scope = 'shared' AND project_id IS NULL))`,
    )
    .all(input.domain, input.projectId) as Array<{ id: string }>;

  const retired: SpRuleRow[] = [];
  for (const row of activeRows) {
    const res = retireRule(db, { ruleId: row.id, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}), quietIfInsufficient: true }, log);
    if (res.ok) retired.push(res.rule);
  }
  return retired;
}

/** Returns up to 15 active local rules of `(projectId, domain)` + active shared rules of `domain`, newest first. */
export function activeRulesForSnapshot(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; limit?: number },
): RuleSnapshotEntry[] {
  const limit = Math.max(1, Math.min(SNAPSHOT_RULES_MAX, input.limit ?? SNAPSHOT_RULES_MAX));
  const rows = db
    .prepare(
      `SELECT * FROM lane_pilot_sp_rule
       WHERE domain = ? AND state = 'active'
         AND ((scope = 'local' AND project_id = ?) OR (scope = 'shared' AND project_id IS NULL))
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(input.domain, input.projectId, limit) as SpRuleRow[];

  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    domain: r.domain,
    project_id: r.project_id,
    text: r.text,
    uncertainty: r.uncertainty,
    window: parseJsonSafe<RuleWindow>(r.window_json, { comparison: "pre/post", measurement_days: 14 }),
    evidence: parseEvidenceEntries(r.evidence_json),
    created_at: r.created_at,
  }));
}

/** Lists `proposed` cross-business shared rules awaiting owner decision (used by the review desk). */
export function listProposedSharedRules(db: LanePilotDatabase, domain?: string): SpRuleRow[] {
  if (domain) {
    return db
      .prepare("SELECT * FROM lane_pilot_sp_rule WHERE scope = 'shared' AND state = 'proposed' AND domain = ? ORDER BY created_at DESC, rowid DESC")
      .all(domain) as SpRuleRow[];
  }
  return db
    .prepare("SELECT * FROM lane_pilot_sp_rule WHERE scope = 'shared' AND state = 'proposed' ORDER BY created_at DESC, rowid DESC")
    .all() as SpRuleRow[];
}
