import { bestEffort, isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import type { GraphNode, StepContext, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { noteEngineWrite } from "../../verification/server";
import type { ToolTier } from "../tool-tiers";
import { registerSpCommitAndDispatchExecutors } from "./sp-commit-dispatch";
import { listActiveLocks } from "./sp-locks-intents";
import { applyMutationsBatch, mintApprovalNonce, type MutationItem } from "./sp-mutation";
import { loadQuestionBank, triageQuestions } from "./sp-questions";
import { mapScriptOutputToDeclaredFields, runVerifiedSkillScript } from "./sp-script-runner";
import {
  acquireTick,
  getBudgetRemainingUsd,
  getCharter,
  listCursors,
  spSweep,
  upsertCharter,
} from "./sp-store";

type Row = Record<string, unknown>;
type ActionReg = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v));
const asDomain = (v: unknown): "seo" | "marketing" | "specialist_os" =>
  v === "seo" || v === "specialist_os" ? v : "marketing";

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val as T;
  if (typeof val === "string" && val.trim()) {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

async function resolveCheckout(ctx: ServerCore, rt: ChainRuntime): Promise<{ hostId: string; path: string } | null> {
  return await bestEffort(
    ctx.log,
    "sp checkout resolve",
    (async () => {
      if (rt.pmThreadId) {
        const pm = await orMiss(ctx.bb.sdk.threads.get({ threadId: rt.pmThreadId }), null, isNotFound);
        const envId = stringAt(pm, "environmentId");
        const env = envId ? await orMiss(ctx.bb.sdk.environments.get({ environmentId: envId }), null, isNotFound) : null;
        const path = stringAt(env, "path");
        const hostId = stringAt(env, "hostId");
        if (path && hostId) return { hostId, path };
      }
      const proj = await orMiss(ctx.bb.sdk.projects.get({ projectId: rt.projectId }), null, isNotFound);
      const sources = Array.isArray((proj as { sources?: unknown } | null)?.sources)
        ? ((proj as { sources: Array<{ hostId?: string; path?: string }> }).sources)
        : [];
      const first = sources.find((s) => Boolean(s?.hostId && s?.path));
      return first?.hostId && first?.path ? { hostId: first.hostId, path: first.path } : null;
    })(),
    null,
  );
}

async function readCheckoutFileText(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  relOrAbs: unknown,
): Promise<string | null> {
  if (!checkout || typeof relOrAbs !== "string" || !relOrAbs.trim()) return null;
  const raw = relOrAbs.trim();
  const cleanRel = raw.startsWith(checkout.path) ? raw.slice(checkout.path.length).replace(/^\/+/, "") : raw.replace(/^\/+/, "");
  if (!cleanRel || cleanRel.includes("..") || cleanRel.includes("\0")) return null;
  return await bestEffort(
    ctx.log,
    "sp checkout read",
    (async () => {
      const file = await orMiss(
        ctx.bb.sdk.files.read({ hostId: checkout.hostId, rootPath: checkout.path, path: `${checkout.path}/${cleanRel}` }),
        null,
        isNotFound,
      );
      const content = file && typeof file === "object" ? (file as { content?: unknown }).content : null;
      return typeof content === "string" ? content : null;
    })(),
    null,
  );
}

async function collectScriptCheckoutFiles(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  args: Row,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!checkout) return out;
  const candidates: unknown[] = [
    args.ads,
    args.clusters,
    args.paid,
    args.organic,
    args.inventory,
    args.redirects,
    args.atoms,
    args.questions,
    args.dir,
    args.file,
    ...(Array.isArray(args.answers) ? args.answers : args.answers ? [args.answers] : []),
  ];
  for (const cand of candidates) {
    if (typeof cand !== "string" || !cand.trim()) continue;
    const key = cand.trim();
    const content = await readCheckoutFileText(ctx, checkout, key);
    if (content !== null) {
      out[key] = content;
      out[key.replace(/^\/+/, "")] = content;
    }
  }
  return out;
}

async function writeCheckoutFile(
  ctx: ServerCore,
  checkout: { hostId: string; path: string } | null,
  relPath: string,
  content: string,
): Promise<string> {
  const cleanRel = relPath.replace(/^\/+/, "");
  if (!checkout || cleanRel.includes("..")) return cleanRel;
  noteEngineWrite(checkout.path, cleanRel);
  await ctx.bb.sdk.files.write({
    hostId: checkout.hostId,
    rootPath: checkout.path,
    path: `${checkout.path}/${cleanRel}`,
    content,
    contentEncoding: "utf8",
    createParents: true,
    expectedSha256: null,
  });
  return cleanRel;
}

/**
 * Registers all 10 deterministic Specialist OS (`sp.*`) action executors onto a `WorkflowEngine`.
 */
export function registerSpExecutors(
  _engine: WorkflowEngine,
  ctx: ServerCore,
  deps: { action: ActionReg },
): void {
  const { db } = ctx;
  const { action } = deps;

  action("sp.load_memory", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    spSweep(db);

    const charterRow = getCharter(db, rt.projectId, domain);
    const activeLocks = listActiveLocks(db, rt.projectId, domain);
    const cursors = listCursors(db, rt.projectId, domain);
    const budgetLeft = getBudgetRemainingUsd(db, rt.projectId, domain);

    let leaseOk = true;
    let tickId = `tick_${c.runId.slice(0, 12)}`;
    if (params.acquireTick === true) {
      const slot = asStr(params.slot, new Date().toISOString().slice(0, 13));
      const scopeId = asStr(params.scopeId, "default");
      const lease = acquireTick(db, { projectId: rt.projectId, domain, scopeId, slotKey: slot, holderRunId: c.runId });
      leaseOk = lease.ok;
      tickId = lease.tickId;
    }

    const rightsRows = db.prepare("SELECT * FROM lane_pilot_sp_autonomy WHERE project_id = ? AND domain = ?").all(rt.projectId, domain);
    const bankStats = loadQuestionBank().stats;
    const recentCommits = db
      .prepare("SELECT summary_json FROM lane_pilot_sp_memory_commit WHERE project_id = ? AND domain = ? ORDER BY created_at DESC LIMIT 5")
      .all(rt.projectId, domain) as Array<{ summary_json: string }>;

    const baseOut: Row = {
      has_charter: Boolean(charterRow),
      lease_ok: leaseOk,
      over_llm_budget: budgetLeft <= 0,
      cold_start: !charterRow,
      tick_id: tickId,
      charter_json: charterRow?.charter_json ?? "{}",
      budget_left_usd: budgetLeft,
      api_budget_left: budgetLeft,
      active_locks_json: JSON.stringify(activeLocks),
      cursors_json: JSON.stringify(cursors),
      open_assumptions_json: "[]",
      recent_hypotheses_json: JSON.stringify(recentCommits.map((r) => parseJsonSafe(r.summary_json, {}))),
      duplicate_of_refuted: false,
      shared_negatives_json: "[]",
      brandcore_json: "{}",
      pools_history_json: "[]",
      telemetry_map_json: "{}",
      previous_panel_path: `.agents/${domain}/memory/panel-latest.json`,
      bank_stats_json: JSON.stringify(bankStats),
      atoms_index_path: `.agents/${domain}/memory/atoms-index.json`,
      rights_json: JSON.stringify(rightsRows),
      matured_forecasts: 20,
      snapshots_index_path: `.agents/${domain}/memory/snapshots-index.json`,
    };
    const out: Row = {};
    for (const f of node.out) {
      out[f.name] =
        baseOut[f.name] !== undefined
          ? baseOut[f.name]
          : f.type === "boolean"
            ? false
            : f.type === "number"
              ? 0
              : f.type === "array"
                ? []
                : "";
    }
    return out;
  });

  action("sp.run_script", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const skill = asStr(params.skill);
    const script = asStr(params.script);
    const args = (params.args && typeof params.args === "object" ? params.args : {}) as Row;
    const timeoutSec = typeof node.timeoutSec === "number" ? node.timeoutSec : typeof params.timeoutSec === "number" ? params.timeoutSec : 90;
    const checkout = await resolveCheckout(ctx, rt);
    const domain = skill.startsWith("seo-") ? "seo" : "marketing";
    const checkoutFiles = await collectScriptCheckoutFiles(ctx, checkout, args);

    const res = await runVerifiedSkillScript({ skill, script, args, timeoutSec, checkoutFiles });
    const reportRel = `.agents/${domain}/reports/${c.workflow.id}-${node.id}.json`;
    await writeCheckoutFile(ctx, checkout, reportRel, JSON.stringify(res.raw, null, 2));
    return mapScriptOutputToDeclaredFields(script, res.raw, node.out, reportRel);
  });

  action("sp.jev_question_triage", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const checkout = await resolveCheckout(ctx, rt);
    const shadowRawJson = await readCheckoutFileText(ctx, checkout, `.agents/${domain}/questions.ext.json`);
    const triaged = triageQuestions(db, {
      projectId: rt.projectId,
      domain,
      mode: asStr(params.mode, "every_tick"),
      ...(typeof params.graphFilter === "string" ? { graphFilter: params.graphFilter } : {}),
      deltas: params.deltas,
      ...(params.context && typeof params.context === "object" ? { context: params.context as Row } : {}),
      shadowRawJson,
      ...(typeof params.maxPerJudgment === "number" ? { maxPerJudgment: params.maxPerJudgment } : {}),
      ...(typeof params.top === "number" ? { top: params.top } : {}),
      ...(typeof params.realP === "number" ? { realP: params.realP } : {}),
    });
    const out: Row = {};
    for (const f of node.out) {
      out[f.name] = (triaged as unknown as Row)[f.name] ?? (f.type === "number" ? 0 : f.type === "array" ? [] : "");
    }
    return out;
  });

  action("sp.breaker_eval", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const emergency = Boolean(params.emergencyInput === true || params.emergencyInput === "true");
    const rawSignals = Array.isArray(params.signals) ? params.signals : [params.signals];
    const triggerCodes: string[] = [];

    if (emergency) triggerCodes.push("owner_emergency_override");
    for (const sig of rawSignals) {
      const parsed = parseJsonSafe<Row>(sig, {});
      if (parsed.critical === true || parsed.verdict === "critical" || parsed.breaker_trip === true) {
        triggerCodes.push(asStr(parsed.code, "critical_telemetry_trip"));
      }
    }

    const fired = triggerCodes.length > 0;
    const now = Date.now();
    db.prepare(
      `INSERT INTO lane_pilot_sp_breaker
        (project_id, domain, breaker_key, state, trigger_codes_json, failure_count, opened_at, cooldown_until, updated_at)
       VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, domain, breaker_key) DO UPDATE SET
        state = excluded.state,
        trigger_codes_json = excluded.trigger_codes_json,
        opened_at = excluded.opened_at,
        updated_at = excluded.updated_at`,
    ).run(rt.projectId, domain, fired ? "open" : "closed", JSON.stringify(triggerCodes), fired ? triggerCodes.length : 0, fired ? now : null, fired ? now + 3_600_000 : null, now);

    const stopPlan = fired ? [{ entity_id: `${domain}_active_spend`, mutation_kind: "emergency_pause", exempt_auto_cutoff: true }] : [];
    return {
      fired,
      trigger_codes: triggerCodes,
      reason: fired ? `Circuit breaker tripped: ${triggerCodes.join(", ")}` : "nominal",
      stop_plan_json: JSON.stringify(stopPlan),
    };
  });

  action("sp.charter_set", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const domain = asDomain(params.domain);
    const charterObj = parseJsonSafe<Row>(params.charter, { domain, goal: "growth" });
    const approvedBy = asStr(params.approvedBy, "owner");
    const saved = upsertCharter(db, { projectId: rt.projectId, domain, charter: charterObj, approvedBy });
    const checkout = await resolveCheckout(ctx, rt);
    await writeCheckoutFile(
      ctx,
      checkout,
      `.agents/${domain}/charter.json`,
      JSON.stringify({ ...charterObj, _version: saved.version, _sha256: saved.sha256 }, null, 2),
    );
    return { version: saved.version, sha256: saved.sha256 };
  });

  action("sp.message_match", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const checkout = await resolveCheckout(ctx, rt);
    const threshold = typeof params.minLemmaOverlap === "number" ? params.minLemmaOverlap : 0.5;
    const mmArgs: Row = {
      ads: params.ads,
      landing: params.capture || { url: asStr(params.target), h1: asStr(params.target), title: asStr(params.target), first_screen: asStr(params.target) },
      threshold,
    };
    const checkoutFiles = await collectScriptCheckoutFiles(ctx, checkout, mmArgs);
    const res = await runVerifiedSkillScript({
      skill: "mkt-landing-cro",
      script: "message_match.py",
      args: mmArgs,
      timeoutSec: 60,
      checkoutFiles,
    });
    const reportRel = `.agents/marketing/reports/${c.workflow.id}-${node.id}.json`;
    await writeCheckoutFile(ctx, checkout, reportRel, JSON.stringify(res.raw, null, 2));
    return {
      min_score: typeof res.raw.min_score === "number" ? res.raw.min_score : 1,
      mismatches: typeof res.raw.mismatches === "number" ? res.raw.mismatches : 0,
      price_mismatch: Boolean(res.raw.price_mismatch ?? false),
      report_path: reportRel,
    };
  });

  action("sp.apply_mutation", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const tier = (params.tier === "R" || params.tier === "D" || params.tier === "S" ? params.tier : "L") as ToolTier;
    const domain = asDomain(params.domain || "marketing");
    const parsedPlan = parseJsonSafe<unknown>(params.plan, []);
    const items: MutationItem[] = Array.isArray(parsedPlan)
      ? (parsedPlan as MutationItem[])
      : parsedPlan && typeof parsedPlan === "object"
        ? [parsedPlan as MutationItem]
        : [{ entity_id: `${c.workflow.id}_entity`, mutation_kind: "live_change" }];

    let nonceToken = typeof params.nonceToken === "string" ? params.nonceToken : undefined;
    const approvalStep = asStr(params.approvalStep);
    if (!nonceToken && tier === "L" && approvalStep) {
      const stepOut = c.resolve(approvalStep) as Row | undefined;
      if (stepOut && (stepOut.answer_kind === "approve" || stepOut.approved === true)) {
        const minted = mintApprovalNonce(db, { projectId: rt.projectId, actionId: `${c.workflow.id}:${node.id}`, payload: items });
        nonceToken = minted.token;
      }
    }

    const emergencyAuthorised = tier === "S" && asStr(params.authorisation) === "charter.emergency_actions";
    const sg = (params.strategyGuard && typeof params.strategyGuard === "object" ? params.strategyGuard : {}) as Row;
    const batchRes = applyMutationsBatch(db, {
      projectId: rt.projectId,
      domain,
      tier,
      items,
      ...(nonceToken ? { nonceToken, actionId: `${c.workflow.id}:${node.id}` } : {}),
      emergencyAuthorised,
      ...(typeof sg.max_step === "number" ? { maxStep: sg.max_step } : {}),
      ...(typeof sg.min_hours_between_edits === "number" ? { minHoursBetweenEdits: sg.min_hours_between_edits } : {}),
      runId: c.runId,
    });

    const checkout = await resolveCheckout(ctx, rt);
    const receiptRel = `.agents/${domain}/receipts/${c.workflow.id}-${node.id}.json`;
    await writeCheckoutFile(ctx, checkout, receiptRel, JSON.stringify(batchRes, null, 2));
    return {
      applied: batchRes.applied,
      failed: batchRes.failed,
      receipt_path: receiptRel,
      mutation_ids: batchRes.mutationIds,
    };
  });

  registerSpCommitAndDispatchExecutors(ctx, { action, resolveCheckout, writeCheckoutFile });
}
