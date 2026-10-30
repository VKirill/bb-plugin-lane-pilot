import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { scheduleIsolated, type ServerCore, type Services } from "../../core/server";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";

export const MODEL_REBENCH_WORKFLOW = "lp.model-rebench";
export const MODEL_REBENCH_SCHEDULE = "model-rebench-monthly";

export type ModelRebenchRow = {
  id: string;
  projectId: string;
  month: string;
  evaluatedCount: number;
  accuracy: number;
  winRate: number;
  reportJson: string;
  recordedAt: number;
};

export type ModelRebenchMetrics = {
  month: string;
  evaluatedDecisions: number;
  agreedOutcomes: number;
  accuracy: number;
  winRate: number;
  byModel: Record<string, { total: number; accepted: number; rate: number }>;
  recommendations: string[];
};

const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

type Db = Pick<Database.Database, "prepare" | "transaction">;

/**
 * Evaluates Jev model routing choices ('writer.model' and 'route.workflow') against actual task/workflow outcomes
 * over the past 30 days. Compares whether tasks dispatched with Jev-selected models succeeded, calculates model win rates,
 * and derives routing recommendations.
 */
export function evaluateModelRouting(
  db: Db,
  options: { projectId?: string; sinceMs?: number; now?: number } = {},
): ModelRebenchMetrics {
  const now = options.now ?? Date.now();
  const since = options.sinceMs ?? (now - 30 * 86_400_000);
  const month = monthOf(now);

  const query = options.projectId
    ? db.prepare(`
        SELECT r.id, r.judgment, r.decision, r.decided_by, r.model, r.subject, r.project_id, r.outcome, a.state as attempt_state
        FROM lane_pilot_jev_receipt r
        LEFT JOIN lane_pilot_attempt a ON a.task_id = r.subject
        WHERE r.judgment IN ('writer.model', 'route.workflow') AND r.at >= ? AND r.project_id = ?
        ORDER BY r.at DESC
      `).all(since, options.projectId) as any[]
    : db.prepare(`
        SELECT r.id, r.judgment, r.decision, r.decided_by, r.model, r.subject, r.project_id, r.outcome, a.state as attempt_state
        FROM lane_pilot_jev_receipt r
        LEFT JOIN lane_pilot_attempt a ON a.task_id = r.subject
        WHERE r.judgment IN ('writer.model', 'route.workflow') AND r.at >= ?
        ORDER BY r.at DESC
      `).all(since) as any[];

  let evaluated = 0;
  let agreed = 0;
  let acceptedAttempts = 0;
  let totalWithAttempt = 0;
  const byModel: Record<string, { total: number; accepted: number; rate: number }> = {};

  for (const row of query) {
    evaluated++;
    let modelKey = "unknown";
    if (typeof row.decision === "string") {
      try {
        const parsed = JSON.parse(row.decision);
        modelKey = parsed.key || parsed.model || parsed.choice || row.model || "default";
      } catch {
        modelKey = row.decision || row.model || "default";
      }
    } else if (row.model) {
      modelKey = row.model;
    }

    if (!byModel[modelKey]) {
      byModel[modelKey] = { total: 0, accepted: 0, rate: 0 };
    }
    byModel[modelKey].total++;

    const isAccepted = row.attempt_state === "accepted";
    const isAgree = typeof row.outcome === "string" && row.outcome.startsWith("agree");

    if (row.attempt_state) {
      totalWithAttempt++;
      if (isAccepted) {
        acceptedAttempts++;
        byModel[modelKey].accepted++;
      }
    } else if (isAgree) {
      byModel[modelKey].accepted++;
    }

    if (isAccepted || isAgree) {
      agreed++;
    }
  }

  for (const stats of Object.values(byModel)) {
    stats.rate = stats.total > 0 ? stats.accepted / stats.total : 0;
  }

  const accuracy = evaluated > 0 ? agreed / evaluated : 1.0;
  const winRate = totalWithAttempt > 0 ? acceptedAttempts / totalWithAttempt : accuracy;
  const recommendations: string[] = [];

  for (const [model, stats] of Object.entries(byModel)) {
    if (stats.total >= 3 && stats.rate < 0.5) {
      recommendations.push(`Demote ${model}: success rate ${(stats.rate * 100).toFixed(0)}% across ${stats.total} tasks`);
    } else if (stats.total >= 3 && stats.rate >= 0.8) {
      recommendations.push(`Keep ${model}: strong win rate ${(stats.rate * 100).toFixed(0)}% across ${stats.total} tasks`);
    }
  }
  if (!recommendations.length) {
    recommendations.push("Routing performance healthy; no model adjustment required this month");
  }

  return {
    month,
    evaluatedDecisions: evaluated,
    agreedOutcomes: agreed,
    accuracy,
    winRate,
    byModel,
    recommendations,
  };
}

export function saveModelRebenchResult(
  db: Db,
  runId: string,
  projectId: string,
  metrics: ModelRebenchMetrics,
  now: number = Date.now(),
): void {
  db.prepare(`
    INSERT OR REPLACE INTO lane_pilot_model_rebench
      (id, project_id, month, evaluated_count, accuracy, win_rate, report_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    runId,
    projectId,
    metrics.month,
    metrics.evaluatedDecisions,
    metrics.accuracy,
    metrics.winRate,
    JSON.stringify(metrics),
    now,
  );
}

export function latestModelRebenchSummary(
  db: Db,
  sinceMs: number = 0,
  now: number = Date.now(),
): { evaluated: number; accuracy: number; winRate: number; count: number } | null {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(evaluated_count), 0) as evaluated,
        AVG(accuracy) as avg_accuracy,
        AVG(win_rate) as avg_win_rate
      FROM lane_pilot_model_rebench
      WHERE recorded_at >= ? AND recorded_at <= ?
    `).get(sinceMs, now) as {
      count: number;
      evaluated: number;
      avg_accuracy: number | null;
      avg_win_rate: number | null;
    } | undefined;

    if (!row || row.count === 0) return null;
    return {
      count: row.count,
      evaluated: row.evaluated,
      accuracy: row.avg_accuracy ?? 1.0,
      winRate: row.avg_win_rate ?? 1.0,
    };
  } catch {
    return null;
  }
}

/**
 * Morning line for the wall morning summary.
 */
export function modelRebenchMorningLine(
  db: Db,
  now: number = Date.now(),
  windowMs: number = 24 * 3_600_000,
): string | null {
  const summary = latestModelRebenchSummary(db, now - windowMs, now);
  if (!summary || summary.evaluated === 0) return null;
  const acc = Math.round(summary.accuracy * 100);
  const win = Math.round(summary.winRate * 100);
  return `Месячный бенч маршрутизации моделей: оценено ${summary.evaluated} решений Jev (точность ${acc}%, успешность выбранных моделей ${win}%).`;
}

/**
 * Registers the workflow executors and schedule for the monthly model rebench.
 */
export function mountModelRebenchGraph(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;

  engine.register<ChainRuntime>("lp.model_rebench_eval", {
    reentrant: true,
    run: async (c) => {
      const projectId = String(c.resolve("$inputs.project_id") ?? c.runtime?.projectId ?? "*");
      const metrics = evaluateModelRouting(ctx.db as never, { projectId: projectId === "*" ? undefined : projectId });
      return {
        output: {
          status: "evaluated",
          evaluated_count: metrics.evaluatedDecisions,
          accuracy: metrics.accuracy,
          win_rate: metrics.winRate,
          report: JSON.stringify(metrics),
        },
      };
    },
  } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.model_rebench_report", {
    reentrant: true,
    run: async (c) => {
      const projectId = String(c.resolve("$inputs.project_id") ?? c.runtime?.projectId ?? "*");
      const rawReport = String(c.resolve("eval.report") ?? "{}");
      let metrics: ModelRebenchMetrics;
      try {
        metrics = JSON.parse(rawReport);
      } catch {
        metrics = evaluateModelRouting(ctx.db as never, { projectId: projectId === "*" ? undefined : projectId });
      }
      saveModelRebenchResult(ctx.db as never, c.runId, projectId, metrics);
      const acc = Math.round(metrics.accuracy * 100);
      const win = Math.round(metrics.winRate * 100);
      const summaryText = `Model rebench ${metrics.month}: evaluated ${metrics.evaluatedDecisions} choices, accuracy ${acc}%, win rate ${win}%. Recommendations: ${metrics.recommendations.join("; ")}`;
      return {
        output: {
          status: "done",
          summary: summaryText,
        },
      };
    },
  } as NodeExecutor<ChainRuntime>);

  // Monthly cron on the 1st of each month at 05:30 UTC
  scheduleIsolated(ctx.bb, MODEL_REBENCH_SCHEDULE, "30 5 1 * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const settings = (await Promise.resolve().then(() => ctx.effectiveProjectSettings("*")).catch(() => null))?.values ?? {};
    if (String(settings["bench.model_rebench"] ?? "off") !== "on") return;
    const workflow = builtinWorkflow(MODEL_REBENCH_WORKFLOW);
    if (!workflow) return;
    const month = monthOf(Date.now());
    const key = `model-rebench:global:${month}`;
    const prior = ctx.db.prepare("SELECT status FROM lane_pilot_wf_run WHERE idem_key=?").get(key) as { status: string } | undefined;
    if (prior) return;

    await engine.start({
      workflow,
      key,
      link: { projectId: "*" },
      runtime: { ctx, services, pmThreadId: null, projectId: "*", runId: null, origin: "schedule" } satisfies ChainRuntime,
      inputs: { project_id: "*" },
    }).done.catch((cause: unknown) => ctx.log(`monthly model rebench failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  }, { timeoutMs: 30 * 60_000 });
}
