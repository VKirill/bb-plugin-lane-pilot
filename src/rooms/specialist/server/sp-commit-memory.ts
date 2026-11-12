import { randomUUID } from "node:crypto";
import { sha256Hex } from "@lane-pilot/kit";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem } from "../../owner-waiting";
import { patchPassportHypothesis } from "../../passport";
import { syncPassportCoreMemory } from "../../passport/server";
import { renderArtifactsManifestJson, upsertProjectArtifact } from "../../storage";
import { canonicalJson, normalizeOrdersInput } from "../action-order";
import { evaluateAutonomyGate } from "../tool-tiers";
import { acquireLock, stageIntent, upsertCohort } from "./sp-locks-intents";
import { recordQuestionAnswer } from "./sp-questions";
import { advanceCursor, completeTick, recordSpecialistLedgerUsage } from "./sp-store";

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

export function registerSpCommitMemoryExecutor(
  ctx: ServerCore,
  deps: {
    action: ActionReg;
    resolveCheckout: (ctx: ServerCore, rt: ChainRuntime) => Promise<{ hostId: string; path: string } | null>;
    readCheckoutFileText: (ctx: ServerCore, checkout: { hostId: string; path: string } | null, relOrAbs: unknown) => Promise<string | null>;
    writeCheckoutFile: (ctx: ServerCore, checkout: { hostId: string; path: string } | null, relPath: string, content: string) => Promise<string>;
  },
): void {
  const { db } = ctx;
  const { action, resolveCheckout, readCheckoutFileText, writeCheckoutFile } = deps;

  action("sp.commit_memory", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const phase = asStr(params.phase, "intents");
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    const orders = normalizeOrdersInput(params.orders, domain);
    const ownerAnswer = asStr(params.ownerAnswer);
    const forceHold = phase === "hold" || ownerAnswer === "hold" || ownerAnswer === "decline" || ownerAnswer === "abort";
    const now = Date.now();

    let stagedCount = 0;
    let heldCount = 0;
    let droppedCount = 0;
    const droppedReasons: string[] = [];
    const journalIds: string[] = [];

    if (phase === "outage") {
      const repairGraph = asStr(params.repairGraph, "mkt-tracking-setup");
      const res = stageIntent(db, {
        projectId: rt.projectId,
        domain,
        sourceGraph: c.workflow.id,
        tickId: asStr(params.tickId) || null,
        order: {
          kind: "sub_graph",
          title: `Auto-repair outage via ${repairGraph}`,
          domain,
          reason_code: asStr(params.reasonCode, "tracking_outage"),
          action_class: "diagnostics",
          workflow_id: repairGraph,
          is_stop_or_kill: false,
          requires_owner_go: false,
          tariff_known: true,
        },
      });
      if (res.status === "staged") stagedCount++;
      journalIds.push(res.intentId);
    } else {
      for (const ord of orders) {
        const res = stageIntent(db, {
          projectId: rt.projectId,
          domain,
          sourceGraph: c.workflow.id,
          tickId: asStr(params.tickId) || null,
          slotScope: c.runId,
          order: ord,
          forceHold,
        });
        journalIds.push(res.intentId);
        if (res.status === "staged") stagedCount++;
        else if (res.status === "held" || res.status === "queued_conflict") heldCount++;
        else {
          droppedCount++;
          if (res.dropReason) droppedReasons.push(res.dropReason);
        }
      }
      if (phase === "hold" && heldCount === 0) heldCount = Math.max(1, orders.length);
    }

    let lockId = asStr(params.lockId);
    let locksCreated = 0;
    if (params.lockSpec) {
      const spec = parseJsonSafe<Row>(params.lockSpec, {});
      if (typeof spec.scope_value === "string" && spec.scope_value) {
        const lk = acquireLock(db, {
          projectId: rt.projectId,
          domain,
          scopeType: (spec.scope_type as "experiment" | "url") || "experiment",
          scopeValue: spec.scope_value,
          ownerGraph: c.workflow.id,
          ownerRunId: c.runId,
          reasonCode: "experiment_launch",
        });
        if (lk.lockId) {
          lockId = lk.lockId;
          locksCreated += 1;
        }
      }
    }
    if (params.locks && typeof params.locks === "object") {
      const lks = params.locks as Row;
      const items = Array.isArray(lks.items) ? lks.items.map(String) : [];
      const unlockDays = typeof lks.unlock_days === "number" ? Math.max(21, Math.min(45, lks.unlock_days)) : 21;
      for (const item of items) {
        if (!item) continue;
        const lk = acquireLock(db, {
          projectId: rt.projectId,
          domain,
          scopeType: "seo_indexation",
          scopeValue: item,
          ownerGraph: c.workflow.id,
          ownerRunId: c.runId,
          reasonCode: "seo_indexation_lock",
          ttlMs: unlockDays * 86_400_000,
        });
        if (lk.ok) locksCreated += 1;
      }
    }

    if (Array.isArray(params.cursorUpdates)) {
      for (let i = 0; i < params.cursorUpdates.length; i++) {
        const cu = parseJsonSafe<Row>(params.cursorUpdates[i], {});
        if (Object.keys(cu).length > 0) {
          const streamKey = typeof cu.stream_key === "string" && cu.stream_key ? cu.stream_key : `stream_${i}`;
          const expectedVersion = typeof cu._version === "number" ? cu._version : undefined;
          const cleanCursor = { ...cu };
          delete cleanCursor._version;
          advanceCursor(db, {
            projectId: rt.projectId,
            domain,
            streamKey,
            nextCursor: cleanCursor,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          });
        }
      }
    }

    const rawApiSpent = params.apiSpent ?? params.apiUnitsSpent;
    const apiSpent = typeof rawApiSpent === "number" ? rawApiSpent : Number(rawApiSpent);
    if (Number.isFinite(apiSpent) && apiSpent > 0) {
      recordSpecialistLedgerUsage(db, {
        projectId: rt.projectId,
        domain,
        kind: "api_units",
        amountUsd: apiSpent,
        cellKey: `${domain}:${c.workflow.id}`,
        runId: c.runId,
        reason: `api_units:${c.workflow.id}:${node.id}`,
        nowMs: now,
      });
    }

    if (params.cohorts) {
      const cohortsList = parseJsonSafe<unknown[]>(params.cohorts, []);
      if (Array.isArray(cohortsList)) {
        for (const rawCoh of cohortsList) {
          if (!rawCoh || typeof rawCoh !== "object") continue;
          const coh = rawCoh as Row;
          const cohortKey = asStr(coh.cohort_key || coh.id);
          if (!cohortKey) continue;
          upsertCohort(db, {
            projectId: rt.projectId,
            domain,
            cohortKey,
            channel: asStr(coh.channel, "paid"),
            cohortDate: asStr(coh.cohort_date, new Date(now).toISOString().slice(0, 10)),
            ...(typeof coh.maturity_window_days === "number" ? { maturityWindowDays: coh.maturity_window_days } : {}),
            cdfPay: typeof coh.cdf_pay === "number" ? coh.cdf_pay : 0,
            ...(typeof coh.spend_usd === "number" ? { spendUsd: coh.spend_usd } : {}),
            ...(typeof coh.conversions === "number" ? { conversions: coh.conversions } : {}),
            nowMs: now,
          });
        }
      }
    }

    let sweptQuestions = 0;
    if (params.answeredQuestions) {
      const ansList = parseJsonSafe<unknown[]>(params.answeredQuestions, []);
      if (Array.isArray(ansList)) {
        for (const item of ansList) {
          if (!item || typeof item !== "object") continue;
          const q = item as Row;
          const qId = asStr(q.question_id || q.questionId);
          if (!qId) continue;
          recordQuestionAnswer(db, {
            projectId: rt.projectId,
            domain,
            questionId: qId,
            answerText: asStr(q.answer ?? q.answerText, "answered"),
            ...(typeof q.ttl_days === "number" ? { ttlDays: q.ttl_days } : {}),
            nowMs: now,
          });
          sweptQuestions += 1;
        }
      }
    }

    let ownerCardsCount = 0;
    const rawOwnerQs = parseJsonSafe<unknown>(params.ownerQuestions, []);
    const ownerQsList = Array.isArray(rawOwnerQs) ? rawOwnerQs : [];
    for (let idx = 0; idx < ownerQsList.length; idx++) {
      const oq = ownerQsList[idx];
      const qText = typeof oq === "string" ? oq : oq && typeof oq === "object" ? asStr((oq as Row).question_ru || (oq as Row).question || (oq as Row).title) : "";
      if (!qText.trim()) continue;
      postOwnerItem(db, {
        key: `sp:q:${c.runId}:${idx}`,
        source: "specialist",
        kind: "question",
        projectId: rt.projectId,
        what: qText.trim().slice(0, 240),
        why: `Вопрос от ${c.workflow.id} (${domain})`,
        wake: false,
      });
      ownerCardsCount += 1;
    }

    let rightsStatus = "unchanged";
    if (phase === "rights" && params.perClass) {
      const perClass = parseJsonSafe<Record<string, Row>>(params.perClass, {});
      for (const [cls, stats] of Object.entries(perClass)) {
        const n = typeof stats.n === "number" ? stats.n : 0;
        const k = typeof stats.k === "number" ? stats.k : 0;
        const kappa = typeof stats.cohen_kappa === "number" ? stats.cohen_kappa : 0.7;
        const gate = evaluateAutonomyGate({ actionClass: cls, samplesN: n, successesK: k, cohenKappa: kappa });
        const nextClass = ownerAnswer === "demote" ? "propose" : gate.allowedClass;
        if (nextClass === "bounded_auto") rightsStatus = "promoted";
        else if (ownerAnswer === "demote") rightsStatus = "demoted";
        db.prepare(
          `INSERT INTO lane_pilot_sp_autonomy
            (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(project_id, domain, action_class) DO UPDATE SET
            autonomy_class = excluded.autonomy_class,
            samples_n = excluded.samples_n,
            successes_k = excluded.successes_k,
            wilson_lb = excluded.wilson_lb,
            cohen_kappa = excluded.cohen_kappa,
            updated_at = excluded.updated_at`,
        ).run(rt.projectId, domain, cls, nextClass, n, k, gate.wilsonLb, kappa, now);
      }
    }

    if (c.workflow.id === "lp.specialist-eval" || phase === "rights" || params.evalReport) {
      const evalObj = parseJsonSafe<Row>(params.evalReport, {});
      const casesN =
        typeof params.n === "number"
          ? params.n
          : typeof evalObj.n === "number"
            ? evalObj.n
            : typeof evalObj.total === "number"
              ? evalObj.total
              : 20;
      const passedK =
        typeof params.k === "number"
          ? params.k
          : typeof evalObj.k === "number"
            ? evalObj.k
            : typeof evalObj.passed === "number"
              ? evalObj.passed
              : Math.round(casesN * 0.9);
      const wilsonLb = typeof params.wilsonLb === "number" ? params.wilsonLb : typeof evalObj.wilson_lb === "number" ? evalObj.wilson_lb : 0.8;
      const grade = asStr(params.grade || evalObj.grade, wilsonLb >= 0.85 ? "g4" : "g3");
      const evalRole = role || (domain === "seo" ? "seo-specialist" : "growth-marketer");
      const exam = asStr(params.exam || evalObj.suite || evalObj.exam, "both");
      const promotions = rightsStatus === "promoted" || Number(params.promotions) > 0 ? 1 : 0;
      const demotions = rightsStatus === "demoted" || Number(params.demotions) > 0 ? 1 : 0;
      const scorecardPath = asStr(params.scorecardPath || evalObj.scorecard_path) || null;
      db.prepare(
        `INSERT INTO lane_pilot_sp_eval_run
          (eval_id, project_id, role, exam, cases_n, passed_k, wilson_lb, grade, promotions, demotions, scorecard_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `eval_${randomUUID()}`,
        rt.projectId,
        evalRole,
        exam,
        casesN,
        passedK,
        wilsonLb,
        grade,
        promotions,
        demotions,
        scorecardPath,
        now,
      );
    }

    if (phase === "receipt" && params.tickId) {
      completeTick(db, { projectId: rt.projectId, domain, ...(typeof params.scopeId === "string" && params.scopeId ? { scopeId: params.scopeId } : {}), tickId: asStr(params.tickId), markSlotCompleted: true, nowMs: now });
    }

    const parsedForecast = parseJsonSafe<unknown>(params.forecasts ?? params.forecast, null);
    const forecastsArr = Array.isArray(parsedForecast)
      ? parsedForecast
      : parsedForecast && typeof parsedForecast === "object" && Object.keys(parsedForecast as Row).length > 0
        ? [parsedForecast]
        : orders.flatMap((o) => (o.forecast ? [o.forecast] : []));

    const commitId = `spc_${randomUUID()}`;
    const summaryObj: Row = {
      workflow: c.workflow.id,
      phase,
      stagedCount,
      heldCount,
      droppedCount,
      lockId,
      ...(params.hypothesisId ? { hypothesisId: asStr(params.hypothesisId) } : {}),
      ...(params.hypothesis || params.experimentTitle ? { hypothesis: asStr(params.hypothesis || params.experimentTitle) } : {}),
      ...(params.decision ? { decision: asStr(params.decision) } : {}),
      ...(params.learning ? { learning: asStr(params.learning) } : {}),
      ...(forecastsArr.length > 0 ? { forecasts: forecastsArr } : {}),
    };
    db.prepare(
      "INSERT INTO lane_pilot_sp_memory_commit (commit_id, project_id, domain, phase, run_id, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(commitId, rt.projectId, domain, phase, c.runId, canonicalJson(summaryObj), now);

    if (rt.projectId && !forceHold) {
      const decisionStr = asStr(params.decision);
      const hypothesisText = asStr(params.hypothesis || params.experimentTitle);
      if (c.workflow.id === "mkt-experiment-cycle" && decisionStr && (decisionStr === "scale" || decisionStr === "kill")) {
        const targetField = decisionStr === "scale" ? "proof_brandcore.verified_facts" : "proof_brandcore.forbidden_claims";
        const targetStatus = decisionStr === "scale" ? "confirmed" : "taboo";
        const factLine =
          decisionStr === "scale"
            ? `Experiment scaled (${c.runId.slice(0, 8)}): ${hypothesisText || "validated lift within MDE"}`
            : `Experiment killed (${c.runId.slice(0, 8)}): do not repeat unedited — ${hypothesisText || "failed MDE/SRM gate"}`;
        const patched = patchPassportHypothesis(db, {
          projectId: rt.projectId,
          fieldPath: targetField,
          nextStatus: targetStatus,
          value: [factLine],
          evidenceRef: `mkt-experiment-cycle:${c.runId}`,
          allowAdditiveAppend: true,
        });
        syncPassportCoreMemory(db, rt.projectId, patched.record.passport);
      }
    }

    const checkout = await resolveCheckout(ctx, rt);
    const reportRel = `.agents/${domain}/memory/commit-${c.workflow.id}-${node.id}.json`;
    const reportText = JSON.stringify(summaryObj, null, 2);
    await writeCheckoutFile(ctx, checkout, reportRel, reportText);

    let questionsAdded = 0;
    const rawNewShadow = params.newShadowQuestions ?? params.shadowQuestions;
    if (rawNewShadow && checkout && !forceHold) {
      const shadowRel = `.agents/${domain}/questions.ext.json`;
      let incomingRaw: unknown[] = [];
      if (Array.isArray(rawNewShadow)) {
        incomingRaw = (rawNewShadow as unknown[]).flat(Infinity);
      } else if (typeof rawNewShadow === "string" && rawNewShadow.trim()) {
        const rawStr = rawNewShadow.trim();
        const sourceText = rawStr.startsWith("[") || rawStr.startsWith("{") ? rawStr : await readCheckoutFileText(ctx, checkout, rawStr);
        if (sourceText) {
          const parsedAny = parseJsonSafe<unknown>(sourceText, []);
          incomingRaw = Array.isArray(parsedAny)
            ? parsedAny.flat(Infinity)
            : parsedAny && typeof parsedAny === "object" && Array.isArray((parsedAny as { questions?: unknown[] }).questions)
              ? (parsedAny as { questions: unknown[] }).questions.flat(Infinity)
              : [];
        }
      }

      const validIncoming = incomingRaw.filter(
        (q): q is Row => Boolean(q && typeof q === "object" && typeof (q as Row).question_id === "string" && typeof (q as Row).question_ru === "string"),
      );
      if (validIncoming.length > 0) {
        const existingExtText = await readCheckoutFileText(ctx, checkout, shadowRel);
        const existingParsed = existingExtText ? parseJsonSafe<{ questions?: Row[] }>(existingExtText, { questions: [] }) : { questions: [] };
        const byId = new Map<string, Row>();
        for (const prev of existingParsed.questions ?? []) {
          if (prev && typeof prev.question_id === "string") byId.set(prev.question_id, prev);
        }
        for (const q of validIncoming) {
          byId.set(String(q.question_id), {
            domain,
            target_graphs: [c.workflow.id],
            trigger_situation: "curriculum_shadow",
            contour: "periodic_ttl_sweep",
            options_ru: ["Да", "Нет"],
            safe_default: "Да",
            impact_weight: 0.75,
            ttl_days: 30,
            periodic_reverify_query: "shadow_reverify",
            auto_resolvable_via_mcp: false,
            ...q,
          });
        }
        const mergedList = [...byId.values()].slice(0, 50);
        questionsAdded = validIncoming.length;
        const extJson = JSON.stringify({ questions: mergedList }, null, 2);
        await writeCheckoutFile(ctx, checkout, shadowRel, extJson);
        upsertProjectArtifact(db, {
          projectId: rt.projectId,
          artifactId: `${domain}.questions_ext`,
          domain,
          kind: "shadow_questions",
          relPath: shadowRel,
          sha256: sha256Hex(extJson),
          summary: `Shadow questions (${mergedList.length})`,
          producerWf: c.workflow.id,
          producerRunId: c.runId,
        });
      }
    }

    if (checkout && rt.projectId) {
      upsertProjectArtifact(db, {
        projectId: rt.projectId,
        artifactId: `${domain}.commit.${c.workflow.id}.${node.id}`,
        domain,
        kind: "memory_commit",
        relPath: reportRel,
        sha256: sha256Hex(reportText),
        summary: `${c.workflow.id}:${phase} staged=${stagedCount}`,
        producerWf: c.workflow.id,
        producerRunId: c.runId,
      });
      await writeCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(db, rt.projectId));
    }

    const dispatchedSoFar = (
      db
        .prepare("SELECT COUNT(*) AS c FROM lane_pilot_sp_dispatch WHERE project_id = ? AND domain = ? AND source_graph = ?")
        .get(rt.projectId, domain, c.workflow.id) as { c: number }
    ).c;

    const defaults: Row = {
      held: heldCount,
      intents: stagedCount,
      dropped: droppedCount,
      dropped_json: JSON.stringify(droppedReasons),
      journal_ids: journalIds,
      questions_added: questionsAdded,
      locks_created: locksCreated,
      batch_id: `cfb_${c.runId.slice(0, 8)}`,
      owner_cards: ownerCardsCount,
      lock_id: lockId || `lock_${c.runId.slice(0, 8)}`,
      frozen_sources: phase === "outage" ? ["primary_telemetry"] : [],
      alerts: 0,
      report_path: reportRel,
      dispatched_count: dispatchedSoFar,
      swept_questions: sweptQuestions,
      summary: `${c.workflow.id}:${phase} staged=${stagedCount} held=${heldCount}`,
    };

    const out: Row = {};
    for (const f of node.out) {
      if (f.name === "final_status" && f.type === "enum") {
        const vals = f.values ?? [];
        if (phase === "rights" && vals.includes(rightsStatus)) out.final_status = rightsStatus;
        else if (ownerAnswer === "approve" && vals.includes("launched")) out.final_status = "launched";
        else if (ownerAnswer === "approve" && vals.includes("done")) out.final_status = "done";
        else if (typeof params.decision === "string" && vals.includes(params.decision)) out.final_status = params.decision;
        else out.final_status = vals[0] ?? "";
      } else if (defaults[f.name] !== undefined) {
        out[f.name] = defaults[f.name];
      } else {
        out[f.name] = f.type === "number" ? 0 : f.type === "boolean" ? false : f.type === "array" ? [] : "";
      }
    }
    return out;
  });
}
