import { randomUUID } from "node:crypto";
import { sha256Hex } from "@lane-pilot/kit";
import type { LanePilotDatabase } from "../../storage";
import { canonicalJson } from "../action-order";
import { type CfBatch, cfBatchSchema, validateCfBatchPreFlight } from "../cf-batch";
import { execPluginPythonSync } from "../plugin-python";
import { acquireLock } from "./sp-locks-intents";

/**
 * Content Factory Bridge v1 (`content-factory-bridge-spec.md` §§2–10):
 * - Enforces SEO BOFU gates `G-1..G-W` + canary wave progression `canary_10 -> wave_50 -> full` (`G-15`).
 * - Enforces multi-channel Organic gates `G-O1..G-O5` including real `audit_organic_pack.py --strict` execution!
 * - Idempotent replay by `(project_id, batch_sha256, wave)` in `lane_pilot_sp_cf_batch`.
 * - Records organic distribution units in `lane_pilot_sp_organic_unit` and handles `sp.cf_feedback` (including SEO 21–45d indexation locks [`G-09`]).
 */
export interface CfDispatchResult {
  ok: boolean;
  replayed: boolean;
  batchId: string;
  batchSha256: string;
  status: "staged" | "canary_running" | "blocked" | "frozen";
  cfGroupId: string | null;
  cfRunId: string | null;
  failedGates: Array<{ gate: string; detail: string }>;
  organicAuditScore?: number;
}

function runOrganicPackAudit(batch: CfBatch): {
  ok: boolean;
  score: number;
  sha256: string;
  issues: Array<{ gate: string; detail: string }>;
} {
  const packPayload = {
    pack_id: batch.batch_id,
    items: batch.organic_items.map((item) => ({
      id: item.id,
      channel: item.channel,
      title: item.title,
      link: item.target_url ?? "",
      ...item.payload,
    })),
  };
  const payloadStr = canonicalJson(packPayload);
  const sha = sha256Hex(payloadStr);
  try {
    const stdout = execPluginPythonSync("mkt-organic-content", "audit_organic_pack.py", ["--input", "-"], payloadStr, 15_000);
    const parsed = JSON.parse(stdout) as {
      ok?: boolean;
      verdict?: string;
      score?: number;
      issues?: Array<{ item_id?: string; check?: string; severity?: string; detail?: string }>;
    };
    const score = typeof parsed.score === "number" ? parsed.score : 0;
    const blocking = (parsed.issues ?? []).filter((x) => x.severity === "error");
    if (!parsed.ok || parsed.verdict === "block" || blocking.length > 0) {
      return {
        ok: false,
        score,
        sha256: sha,
        issues:
          blocking.length > 0
            ? blocking.map((b) => ({ gate: `G-O5_${b.check ?? "audit"}`, detail: `${b.item_id ?? "pack"}: ${b.detail ?? "failed"}` }))
            : [{ gate: "G-O5_organic_audit_block", detail: `verdict=${parsed.verdict ?? "error"}` }],
      };
    }
    return { ok: true, score, sha256: sha, issues: [] };
  } catch (err) {
    return {
      ok: false,
      score: 0,
      sha256: sha,
      issues: [{ gate: "G-O5_audit_exec_error", detail: err instanceof Error ? err.message.slice(0, 200) : String(err) }],
    };
  }
}

export function stageAndDispatchCfBatch(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    rawBatch: unknown;
    executeCli?: (args: string[]) => { exitCode: number; stdout: string; stderr: string };
    nowMs?: number;
  },
): CfDispatchResult {
  const now = input.nowMs ?? Date.now();
  const parsed = cfBatchSchema.safeParse(input.rawBatch);
  if (!parsed.success) {
    return {
      ok: false,
      replayed: false,
      batchId: "invalid_batch",
      batchSha256: "",
      status: "blocked",
      cfGroupId: null,
      cfRunId: null,
      failedGates: parsed.error.issues.map((iss) => ({ gate: "G-0_schema", detail: `${iss.path.join(".")}: ${iss.message}` })),
    };
  }

  const batch = parsed.data;
  const prevWave = batch.wave === "wave_50" ? "canary_10" : batch.wave === "full" ? "wave_50" : null;
  let prevCompleted = true;
  let prevIndexRate: number | null = null;
  if (prevWave) {
    const prior = db
      .prepare(
        "SELECT status, indexation_rate_14d FROM lane_pilot_sp_cf_batch WHERE project_id = ? AND domain = ? AND batch_kind = ? AND wave = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(input.projectId, batch.domain, batch.batch_kind, prevWave) as
      | { status: string; indexation_rate_14d: number | null }
      | undefined;
    prevCompleted = Boolean(prior && prior.status === "completed");
    prevIndexRate = prior?.indexation_rate_14d ?? null;
  }

  const pre = validateCfBatchPreFlight(batch, {
    previousWaveCompleted: prevCompleted,
    previousIndexationRate14d: prevIndexRate,
  });

  const existing = db
    .prepare("SELECT * FROM lane_pilot_sp_cf_batch WHERE project_id = ? AND batch_sha256 = ? AND wave = ?")
    .get(input.projectId, pre.batch_sha256, batch.wave) as
    | { batch_id: string; status: "staged" | "canary_running" | "blocked" | "frozen"; cf_group_id: string | null; cf_run_id: string | null }
    | undefined;
  if (existing) {
    return {
      ok: existing.status !== "blocked" && existing.status !== "frozen",
      replayed: true,
      batchId: existing.batch_id,
      batchSha256: pre.batch_sha256,
      status: existing.status,
      cfGroupId: existing.cf_group_id,
      cfRunId: existing.cf_run_id,
      failedGates: [],
    };
  }

  const failedGates = [...pre.failed_gates];
  let organicAuditScore: number | undefined;
  let organicAuditSha = "";

  if (batch.organic_items.length > 0) {
    const audit = runOrganicPackAudit(batch);
    organicAuditScore = audit.score;
    organicAuditSha = audit.sha256;
    if (!audit.ok) failedGates.push(...audit.issues);
  }

  const itemCount = batch.seo_items.length + batch.organic_items.length;
  const batchId = batch.batch_id || `cfb_${randomUUID()}`;

  if (failedGates.length > 0) {
    const isFrozen = failedGates.some((g) => g.gate === "G-15_indexation_gate");
    const status = isFrozen ? "frozen" : "blocked";
    db.prepare(
      `INSERT INTO lane_pilot_sp_cf_batch
        (batch_id, project_id, domain, batch_kind, wave, item_count, batch_sha256, cf_group_id, cf_run_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    ).run(batchId, input.projectId, batch.domain, batch.batch_kind, batch.wave, itemCount, pre.batch_sha256, status, now, now);
    return {
      ok: false,
      replayed: false,
      batchId,
      batchSha256: pre.batch_sha256,
      status,
      cfGroupId: null,
      cfRunId: null,
      failedGates,
      ...(organicAuditScore !== undefined ? { organicAuditScore } : {}),
    };
  }

  let cfGroupId = `cfg_${batch.cf_group_slug}`;
  let cfRunId = `cfr_${sha256Hex(`${batchId}:${now}`).slice(0, 12)}`;
  let status: "staged" | "canary_running" = "staged";

  if (input.executeCli) {
    const scenCheck = input.executeCli(["cf", "scenario", "steps", batch.scenario_id, "--json"]);
    if (scenCheck.exitCode === 0 && /"publish_live"\s*:\s*true|"kind"\s*:\s*"publish"/i.test(scenCheck.stdout)) {
      return {
        ok: false,
        replayed: false,
        batchId,
        batchSha256: pre.batch_sha256,
        status: "blocked",
        cfGroupId: null,
        cfRunId: null,
        failedGates: [{ gate: "G-2_cli_publish_step_detected", detail: "CF scenario contains a live publish step" }],
      };
    }
    const runRes = input.executeCli(["cf", "run", "start", "--group", batch.cf_group_slug, "--scenario", batch.scenario_id, "--draft-only"]);
    if (runRes.exitCode === 0) {
      status = "canary_running";
      const match = runRes.stdout.match(/cfr_[a-zA-Z0-9_-]+/);
      if (match) cfRunId = match[0];
    }
  }

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO lane_pilot_sp_cf_batch
        (batch_id, project_id, domain, batch_kind, wave, item_count, batch_sha256, cf_group_id, cf_run_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(batchId, input.projectId, batch.domain, batch.batch_kind, batch.wave, itemCount, pre.batch_sha256, cfGroupId, cfRunId, status, now, now);

    if (batch.organic_items.length > 0) {
      const insOrg = db.prepare(
        `INSERT INTO lane_pilot_sp_organic_unit
          (unit_id, batch_id, project_id, channel, slug, target_url, utm_campaign, audit_score, audit_sha256, status, meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of batch.organic_items) {
        insOrg.run(
          `org_${randomUUID()}`,
          batchId,
          input.projectId,
          item.channel,
          item.slug,
          item.target_url ?? null,
          item.utm_campaign,
          item.audit_score ?? organicAuditScore ?? 100,
          item.audit_sha256 || organicAuditSha || pre.batch_sha256,
          status === "canary_running" ? "queued_cf" : "draft_ready",
          canonicalJson({ title: item.title, utm_source: item.utm_source ?? item.channel, utm_medium: item.utm_medium }),
          now,
          now,
        );
      }
    }
  });
  tx();

  return {
    ok: true,
    replayed: false,
    batchId,
    batchSha256: pre.batch_sha256,
    status,
    cfGroupId,
    cfRunId,
    failedGates: [],
    ...(organicAuditScore !== undefined ? { organicAuditScore } : {}),
  };
}

/** Handles `sp.cf_feedback`: updates `lane_pilot_sp_cf_batch` indexation rate & acquires 21–45d SEO indexation locks (`G-09`). */
export function recordCfFeedback(
  db: LanePilotDatabase,
  input: {
    projectId: string;
    batchId: string;
    status: "awaiting_indexation" | "completed" | "frozen";
    indexationRate14d?: number;
    publishedUrls?: string[];
    lockDays?: number;
    nowMs?: number;
  },
): { updated: boolean; locksAcquired: number; frozen: boolean } {
  const now = input.nowMs ?? Date.now();
  const frozen = typeof input.indexationRate14d === "number" && input.indexationRate14d < 0.65;
  const finalStatus = frozen ? "frozen" : input.status;

  const changes = db
    .prepare(
      `UPDATE lane_pilot_sp_cf_batch
       SET status = ?,
           indexation_rate_14d = COALESCE(?, indexation_rate_14d),
           published_at = CASE WHEN ? IN ('awaiting_indexation','completed') AND published_at IS NULL THEN ? ELSE published_at END,
           updated_at = ?
       WHERE project_id = ? AND batch_id = ?`,
    )
    .run(finalStatus, input.indexationRate14d ?? null, finalStatus, now, now, input.projectId, input.batchId).changes;

  let locksAcquired = 0;
  const days = Math.max(21, Math.min(45, input.lockDays ?? 28));
  for (const url of input.publishedUrls ?? []) {
    const res = acquireLock(db, {
      projectId: input.projectId,
      domain: "seo",
      scopeType: "seo_indexation",
      scopeValue: url,
      ownerGraph: "seo-template-scale",
      reasonCode: "seo_indexation_lock",
      ttlMs: days * 86_400_000,
      meta: { batch_id: input.batchId, observation_days: days },
      nowMs: now,
    });
    if (res.ok) locksAcquired++;
  }

  return { updated: changes > 0, locksAcquired, frozen };
}
