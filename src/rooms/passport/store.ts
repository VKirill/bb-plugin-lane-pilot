import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../storage";
import { renderPassportMarkdown } from "./passport-checks-and-render";
import {
  computePassportMetrics,
  createEmptyPassport,
  getPassportClaimAt,
  mergePassportPatch,
  passportV1Schema,
  type Claim,
  type ClaimStatus,
  type PassportMetrics,
  type PassportV1,
  type PendingPassportDelta,
  type VerbatimEntry,
} from "./schema";

export interface StoredPassportRecord {
  project_id: string;
  scope_key: string;
  schema_version: number;
  passport: PassportV1;
  passport_md: string;
  metrics: PassportMetrics;
  primary_locale: string;
  markets: string[];
  version: number;
  sha256: string;
  updated_at: number;
  updated_by: string;
}

function tableExists(db: LanePilotDatabase, name: string): boolean {
  if (!db || typeof db.prepare !== "function") return false;
  try {
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { ok?: number } | undefined;
    return row?.ok === 1;
  } catch {
    return false;
  }
}

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function hasPassportRecord(db: LanePilotDatabase, projectId: string, scopeKey = ""): boolean {
  if (!projectId || !tableExists(db, "lane_pilot_passport")) return false;
  const row = db
    .prepare("SELECT completeness_score FROM lane_pilot_passport WHERE project_id = ? AND scope_key = ?")
    .get(projectId, scopeKey) as { completeness_score: number } | undefined;
  return Boolean(row && row.completeness_score > 0);
}

export function getPassport(db: LanePilotDatabase, projectId: string, scopeKey = ""): StoredPassportRecord | null {
  if (!projectId || !tableExists(db, "lane_pilot_passport")) return null;
  const row = db
    .prepare("SELECT * FROM lane_pilot_passport WHERE project_id = ? AND scope_key = ?")
    .get(projectId, scopeKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parsed = passportV1Schema.safeParse(parseJsonOr(String(row.passport_json ?? "{}"), {}));
  const passport = parsed.success ? parsed.data : createEmptyPassport();
  const metrics = computePassportMetrics(passport);
  return {
    project_id: String(row.project_id),
    scope_key: String(row.scope_key ?? ""),
    schema_version: Number(row.schema_version ?? 1),
    passport,
    passport_md: String(row.passport_md ?? ""),
    metrics,
    primary_locale: String(row.primary_locale ?? ""),
    markets: parseJsonOr<string[]>(String(row.markets_json ?? "[]"), []),
    version: Number(row.version ?? 1),
    sha256: String(row.sha256 ?? ""),
    updated_at: Number(row.updated_at ?? 0),
    updated_by: String(row.updated_by ?? "system"),
  };
}

export function listVerbatim(
  db: LanePilotDatabase,
  projectId: string,
  options: { scopeKey?: string; limit?: number } = {},
): VerbatimEntry[] {
  const scopeKey = options.scopeKey ?? "";
  const limit = Math.max(1, Math.min(200, options.limit ?? 30));
  if (!projectId || !tableExists(db, "lane_pilot_passport_verbatim")) return [];
  const rows = db
    .prepare(
      "SELECT * FROM lane_pilot_passport_verbatim WHERE project_id = ? AND scope_key = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(projectId, scopeKey, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    scope_key: String(r.scope_key ?? ""),
    source: String(r.source ?? "interview"),
    thread_id: typeof r.thread_id === "string" ? r.thread_id : null,
    run_id: typeof r.run_id === "string" ? r.run_id : null,
    question_asked: String(r.question_asked ?? ""),
    owner_verbatim: String(r.owner_verbatim ?? ""),
    extracted_paths: parseJsonOr<string[]>(String(r.extracted_paths_json ?? "[]"), []),
    created_at: Number(r.created_at ?? 0),
  }));
}

export function appendVerbatim(
  db: LanePilotDatabase,
  input: {
    id?: string;
    projectId: string;
    scopeKey?: string;
    source: string;
    threadId?: string | null;
    runId?: string | null;
    questionAsked?: string;
    ownerVerbatim: string;
    extractedPaths?: readonly string[];
    now?: number;
  },
): VerbatimEntry {
  const now = input.now ?? Date.now();
  const scopeKey = input.scopeKey ?? "";
  const trimmed = input.ownerVerbatim.trim();
  const id =
    input.id ||
    `vrb_${sha256Hex(`${input.projectId}:${scopeKey}:${input.source}:${trimmed}:${now}`).slice(0, 14)}`;
  const extracted = [...(input.extractedPaths ?? [])];
  db.prepare(
    `INSERT OR REPLACE INTO lane_pilot_passport_verbatim
      (id, project_id, scope_key, source, thread_id, run_id, question_asked, owner_verbatim, extracted_paths_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.projectId,
    scopeKey,
    input.source,
    input.threadId ?? null,
    input.runId ?? null,
    input.questionAsked ?? "",
    trimmed,
    JSON.stringify(extracted),
    now,
  );
  return {
    id,
    project_id: input.projectId,
    scope_key: scopeKey,
    source: input.source,
    thread_id: input.threadId ?? null,
    run_id: input.runId ?? null,
    question_asked: input.questionAsked ?? "",
    owner_verbatim: trimmed,
    extracted_paths: extracted,
    created_at: now,
  };
}

export function upsertPassport(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    scopeKey?: string;
    passport: PassportV1;
    updatedBy?: string;
    now?: number;
  },
): StoredPassportRecord {
  const now = input.now ?? Date.now();
  const scopeKey = input.scopeKey ?? "";
  const validated = passportV1Schema.parse(input.passport);
  const verbatim = listVerbatim(db, input.projectId, { scopeKey, limit: 15 });
  const md = renderPassportMarkdown(validated, verbatim);
  const metrics = computePassportMetrics(validated);
  const jsonStr = JSON.stringify(validated);
  const sha = sha256Hex(jsonStr);
  const primaryLocale =
    validated.market_rails.content_locales.value[0] ??
    validated.market_rails.ui_locales.value[0] ??
    "";
  const markets = validated.market_rails.primary_countries.value;
  const existing = getPassport(db, input.projectId, scopeKey);
  const nextVersion = existing ? (existing.sha256 === sha ? existing.version : existing.version + 1) : 1;
  const updatedBy = input.updatedBy ?? "system";

  db.prepare(
    `INSERT INTO lane_pilot_passport
      (project_id, scope_key, schema_version, passport_json, passport_md, completeness_score,
       confirmed_count, hypothesis_count, unknown_count, taboo_count, primary_locale, markets_json,
       version, sha256, updated_at, updated_by)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, scope_key) DO UPDATE SET
       passport_json = excluded.passport_json,
       passport_md = excluded.passport_md,
       completeness_score = excluded.completeness_score,
       confirmed_count = excluded.confirmed_count,
       hypothesis_count = excluded.hypothesis_count,
       unknown_count = excluded.unknown_count,
       taboo_count = excluded.taboo_count,
       primary_locale = excluded.primary_locale,
       markets_json = excluded.markets_json,
       version = excluded.version,
       sha256 = excluded.sha256,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).run(
    input.projectId,
    scopeKey,
    jsonStr,
    md,
    metrics.completeness_score,
    metrics.confirmed_count,
    metrics.hypothesis_count,
    metrics.unknown_count,
    metrics.taboo_count,
    primaryLocale,
    JSON.stringify(markets),
    nextVersion,
    sha,
    now,
    updatedBy,
  );

  return {
    project_id: input.projectId,
    scope_key: scopeKey,
    schema_version: 1,
    passport: validated,
    passport_md: md,
    metrics,
    primary_locale: primaryLocale,
    markets,
    version: nextVersion,
    sha256: sha,
    updated_at: now,
    updated_by: updatedBy,
  };
}

export function queuePendingPassportDelta(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    scopeKey?: string;
    fieldPath: string;
    oldClaim: Claim<unknown>;
    proposedClaim: Claim<unknown>;
    verbatimId?: string | null;
    reason: string;
    now?: number;
  },
): PendingPassportDelta {
  const now = input.now ?? Date.now();
  const scopeKey = input.scopeKey ?? "";
  const id = `ppd_${sha256Hex(`${input.projectId}:${scopeKey}:${input.fieldPath}:${input.proposedClaim.status}:${JSON.stringify(input.proposedClaim.value)}`).slice(0, 14)}`;
  const oldJson = JSON.stringify(input.oldClaim);
  const existing = db
    .prepare("SELECT state, old_claim_json, created_at, decided_at FROM lane_pilot_passport_pending WHERE id = ?")
    .get(id) as { state?: string; old_claim_json?: string; created_at?: number; decided_at?: number | null } | undefined;
  if (existing && existing.state === "rejected" && existing.old_claim_json === oldJson) {
    return {
      id,
      project_id: input.projectId,
      scope_key: scopeKey,
      field_path: input.fieldPath,
      old_claim: input.oldClaim,
      proposed_claim: input.proposedClaim,
      verbatim_id: input.verbatimId ?? null,
      reason: input.reason,
      state: "rejected",
      created_at: Number(existing.created_at ?? now),
      decided_at: typeof existing.decided_at === "number" ? existing.decided_at : now,
    };
  }
  db.prepare(
    `INSERT OR REPLACE INTO lane_pilot_passport_pending
      (id, project_id, scope_key, field_path, old_claim_json, proposed_claim_json, verbatim_id, reason, state, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(
    id,
    input.projectId,
    scopeKey,
    input.fieldPath,
    oldJson,
    JSON.stringify(input.proposedClaim),
    input.verbatimId ?? null,
    input.reason,
    now,
  );
  return {
    id,
    project_id: input.projectId,
    scope_key: scopeKey,
    field_path: input.fieldPath,
    old_claim: input.oldClaim,
    proposed_claim: input.proposedClaim,
    verbatim_id: input.verbatimId ?? null,
    reason: input.reason,
    state: "pending",
    created_at: now,
    decided_at: null,
  };
}

export function listPendingPassportDeltas(
  db: LanePilotDatabase,
  projectId: string,
  scopeKeyOrOpts: string | { scopeKey?: string; onlyPending?: boolean } = "",
): PendingPassportDelta[] {
  if (!projectId || !tableExists(db, "lane_pilot_passport_pending")) return [];
  const scopeKey = typeof scopeKeyOrOpts === "string" ? scopeKeyOrOpts : (scopeKeyOrOpts.scopeKey ?? "");
  const onlyPending = typeof scopeKeyOrOpts === "string" ? true : (scopeKeyOrOpts.onlyPending ?? true);
  const sql = onlyPending
    ? "SELECT * FROM lane_pilot_passport_pending WHERE project_id = ? AND scope_key = ? AND state = 'pending' ORDER BY created_at DESC"
    : "SELECT * FROM lane_pilot_passport_pending WHERE project_id = ? AND scope_key = ? ORDER BY created_at DESC";
  const rows = db.prepare(sql).all(projectId, scopeKey) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    project_id: String(r.project_id),
    scope_key: String(r.scope_key ?? ""),
    field_path: String(r.field_path),
    old_claim: parseJsonOr<Claim<unknown>>(String(r.old_claim_json), { status: "unknown", value: "", evidence_ref: "" }),
    proposed_claim: parseJsonOr<Claim<unknown>>(String(r.proposed_claim_json), { status: "unknown", value: "", evidence_ref: "" }),
    verbatim_id: typeof r.verbatim_id === "string" ? r.verbatim_id : null,
    reason: String(r.reason ?? ""),
    state: r.state === "accepted" ? "accepted" : r.state === "rejected" ? "rejected" : "pending",
    created_at: Number(r.created_at ?? 0),
    decided_at: typeof r.decided_at === "number" ? r.decided_at : null,
  }));
}

export function decidePendingPassportDelta(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    deltaId: string;
    decision: "accept" | "reject";
    now?: number;
  },
): { ok: boolean; scopeKey?: string; updated?: StoredPassportRecord } {
  if (!tableExists(db, "lane_pilot_passport_pending")) return { ok: false };
  const row = db
    .prepare("SELECT * FROM lane_pilot_passport_pending WHERE id = ? AND project_id = ?")
    .get(input.deltaId, input.projectId) as Record<string, unknown> | undefined;
  if (!row || row.state !== "pending") return { ok: false };
  const now = input.now ?? Date.now();
  const scopeKey = String(row.scope_key ?? "");
  const nextState = input.decision === "accept" ? "accepted" : "rejected";
  db.prepare("UPDATE lane_pilot_passport_pending SET state = ?, decided_at = ? WHERE id = ?").run(nextState, now, input.deltaId);

  if (input.decision !== "accept") return { ok: true, scopeKey };
  const current = getPassport(db, input.projectId, scopeKey)?.passport ?? createEmptyPassport();
  const proposed = parseJsonOr<Claim<unknown>>(String(row.proposed_claim_json), { status: "confirmed", value: "", evidence_ref: "owner_confirm" });
  const merged = mergePassportPatch(current, { [String(row.field_path)]: proposed }, { evidenceRef: proposed.evidence_ref || "owner_confirm", now });
  const updated = upsertPassport(db, { projectId: input.projectId, scopeKey, passport: merged, updatedBy: "owner_confirm", now });
  return { ok: true, scopeKey, updated };
}

const ADDITIVE_ARRAY_PASSPORT_FIELDS = new Set([
  "identity.non_goals",
  "market_rails.excluded_countries",
  "market_rails.forbidden_channels",
  "audience_jtbd.anti_audience",
  "messaging_voice.owner_lexicon",
  "messaging_voice.banned_words",
  "proof_brandcore.verified_facts",
  "proof_brandcore.case_patterns",
  "proof_brandcore.forbidden_claims",
  "product_design_rails.anti_references",
  "product_design_rails.constraints",
]);

/**
 * Feedback loop helper: lets downstream workflows (`mkt-experiment-cycle`, `research-dossier`, `council`, `seo-project-intake`, `mkt-project-intake`)
 * promote a `hypothesis` or `unknown` claim (or append a verified fact / refuted taboo) without blindly overwriting unrelated owner locks.
 */
export function patchPassportHypothesis(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    scopeKey?: string;
    fieldPath: string;
    nextStatus: ClaimStatus;
    value: unknown;
    evidenceRef: string;
    note?: string;
    allowOverrideConfirmed?: boolean;
    allowAdditiveAppend?: boolean;
    updatedBy?: string;
    now?: number;
  },
): { applied: boolean; queuedPending?: PendingPassportDelta; record: StoredPassportRecord } {
  const scopeKey = input.scopeKey ?? "";
  const now = input.now ?? Date.now();
  const existingRecord = getPassport(db, input.projectId, scopeKey);
  const current = existingRecord?.passport ?? createEmptyPassport();
  const currentClaim = getPassportClaimAt(current, input.fieldPath);

  const proposedClaim: Claim<unknown> = {
    status: input.nextStatus,
    value: input.value,
    evidence_ref: input.evidenceRef,
    updated_at: now,
    ...(input.note ? { note: input.note } : {}),
  };

  const deferConflict = (oldClaim: Claim<unknown>, nextClaim: Claim<unknown>, fallbackReason: string) => {
    const pending = queuePendingPassportDelta(db, {
      projectId: input.projectId,
      scopeKey,
      fieldPath: input.fieldPath,
      oldClaim,
      proposedClaim: nextClaim,
      reason: input.note || fallbackReason,
      now,
    });
    return {
      applied: false,
      ...(pending.state === "pending" ? { queuedPending: pending } : {}),
      record: existingRecord ?? upsertPassport(db, { projectId: input.projectId, scopeKey, passport: current, updatedBy: "init", now }),
    };
  };

  if (currentClaim && Array.isArray(currentClaim.value)) {
    const incomingItems = (Array.isArray(input.value) ? input.value : [input.value]).map((s) => String(s).trim()).filter(Boolean);
    const existingItems = currentClaim.value.map((s) => String(s).trim()).filter(Boolean);
    const isLocked = (currentClaim.status === "confirmed" || currentClaim.status === "taboo") && !input.allowOverrideConfirmed && existingItems.length > 0;

    // ASTRA-R3-001: Never allow status downgrade (e.g. confirmed/taboo -> hypothesis) to bypass owner locks via additive array merge.
    if (isLocked && input.nextStatus !== currentClaim.status) {
      return deferConflict(
        currentClaim,
        { ...proposedClaim, value: incomingItems },
        `Downstream workflow evidence (${input.evidenceRef}) attempted epistemic downgrade (${currentClaim.status} → ${input.nextStatus}) on locked array field`,
      );
    }

    if (ADDITIVE_ARRAY_PASSPORT_FIELDS.has(input.fieldPath)) {
      const union = [...new Set([...existingItems, ...incomingItems])];
      if (isLocked && !input.allowAdditiveAppend && union.length !== existingItems.length) {
        return deferConflict(currentClaim, { ...proposedClaim, value: union }, `Downstream workflow evidence (${input.evidenceRef}) proposed adding items to ${currentClaim.status} array field`);
      }
      const merged = mergePassportPatch(
        current,
        { [input.fieldPath]: { ...proposedClaim, status: isLocked ? currentClaim.status : proposedClaim.status, value: union } },
        { evidenceRef: input.evidenceRef, now },
      );
      return { applied: true, record: upsertPassport(db, { projectId: input.projectId, scopeKey, passport: merged, updatedBy: input.updatedBy ?? input.evidenceRef, now }) };
    }

    if (isLocked && JSON.stringify(existingItems) !== JSON.stringify(incomingItems)) {
      return deferConflict(currentClaim, { ...proposedClaim, value: incomingItems }, `Downstream workflow evidence (${input.evidenceRef}) differs from ${currentClaim.status} array field`);
    }

    const merged = mergePassportPatch(current, { [input.fieldPath]: { ...proposedClaim, value: incomingItems } }, { evidenceRef: input.evidenceRef, now });
    return { applied: true, record: upsertPassport(db, { projectId: input.projectId, scopeKey, passport: merged, updatedBy: input.updatedBy ?? input.evidenceRef, now }) };
  }

  if (
    currentClaim &&
    (currentClaim.status === "confirmed" || currentClaim.status === "taboo") &&
    !input.allowOverrideConfirmed &&
    String(currentClaim.value).trim() !== "" &&
    (String(currentClaim.value).trim() !== String(input.value).trim() || input.nextStatus !== currentClaim.status)
  ) {
    return deferConflict(currentClaim, proposedClaim, `Downstream workflow evidence (${input.evidenceRef}) differs from confirmed field`);
  }

  const merged = mergePassportPatch(current, { [input.fieldPath]: proposedClaim }, { evidenceRef: input.evidenceRef, now });
  return { applied: true, record: upsertPassport(db, { projectId: input.projectId, scopeKey, passport: merged, updatedBy: input.updatedBy ?? input.evidenceRef, now }) };
}
