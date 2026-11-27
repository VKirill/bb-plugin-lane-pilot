import { wfRunMetaByIds, type WfRunMetaRow } from "@lane-pilot/workflow-engine";
import type { SpecialistDetailOutput } from "../../../contracts";
import { createScheduleStore, fireTimes, taskOf } from "../../../schedule";
import type { ScheduleService } from "../../../schedule/server";
import type { LanePilotDatabase } from "../../../storage";

const RECENT_SHIFTS_LIMIT = 10;

export type WfRunMetaReader = (
  db: LanePilotDatabase,
  runIds: readonly string[],
) => Map<string, WfRunMetaRow>;

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function scheduleMatchesDomain(
  schedule: { name: string; description: string; task: ReturnType<typeof taskOf> },
  domain: string,
): boolean {
  const dom = domain.trim().toLowerCase();
  if (!dom) return false;
  const { task } = schedule;
  if (task.kind === "workflow") {
    const inputsDomain = asText(task.inputs?.domain)?.toLowerCase();
    if (inputsDomain) return inputsDomain === dom;
    const wfId = task.workflowId.toLowerCase();
    if (schedule.name.toLowerCase().startsWith(`sp:${dom}:`)) return true;
    if (dom === "seo" && (wfId.startsWith("seo-") || wfId.startsWith("seo."))) return true;
    if (dom === "marketing" && (wfId.startsWith("mkt-") || wfId.startsWith("mkt."))) return true;
    if (wfId.startsWith(`${dom}-`) || wfId.startsWith(`${dom}.`)) return true;
    return schedule.description.toLowerCase().includes(`(${dom})`);
  }
  if (task.kind === "agent") {
    const agentId = task.agentId.toLowerCase();
    if (dom === "seo") return agentId === "seo-specialist";
    if (dom === "marketing") return agentId === "growth-marketer";
    return agentId === dom || agentId === `${dom}-specialist`;
  }
  return schedule.name.toLowerCase().startsWith(`sp:${dom}:`) || schedule.description.toLowerCase().includes(`(${dom})`);
}

function shiftDepthOf(
  task: ReturnType<typeof taskOf>,
  wfInputs?: Record<string, unknown>,
): string {
  const wfDepth = asText(wfInputs?.mode) ?? asText(wfInputs?.depth);
  if (wfDepth) return wfDepth;
  if (task.kind === "workflow") {
    return (
      asText(task.inputs?.mode) ??
      asText(task.inputs?.depth) ??
      (task.workflowId === "sp-specialist-tick" ? "daily_sweep" : task.workflowId)
    );
  }
  return task.kind;
}

/** Collects recent and upcoming scheduled shifts for a `(projectId, domain)` specialist. */
export function buildSpecialistShifts(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  nowMs: number,
  schedulesDep?: Pick<ScheduleService, "list" | "runs">,
  wfRunMetaDep?: WfRunMetaReader,
): SpecialistDetailOutput["shifts"] {
  type ShiftCandidate = SpecialistDetailOutput["shifts"]["recent"][number] & { sortKey: number; seq: string };

  const store = schedulesDep ? null : createScheduleStore(db, () => nowMs);
  const scheduleEntries = schedulesDep
    ? schedulesDep.list({ projectId }).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        state: s.state,
        task: s.task as ReturnType<typeof taskOf>,
        nextFires: s.nextFires,
        runs: () => schedulesDep.runs(s.id, RECENT_SHIFTS_LIMIT, 0),
      }))
    : store!
        .list({ projectId })
        .map((row) => {
          const task = taskOf(row);
          const nextFires =
            row.state !== "active"
              ? []
              : row.trigger_type === "once"
                ? row.run_at && row.run_at >= nowMs
                  ? [row.run_at]
                  : []
                : row.cron
                  ? fireTimes(row.cron, row.timezone || "UTC", nowMs - 1, { limit: 1 })
                  : [];
          return {
            id: row.id,
            name: row.name,
            description: row.description,
            state: row.state,
            task,
            nextFires,
            runs: () =>
              store!.runsOf(row.id, RECENT_SHIFTS_LIMIT, 0).map((r) => ({
                id: r.id,
                scheduledAt: r.scheduled_at,
                queuedAt: r.queued_at,
                startedAt: r.started_at,
                finishedAt: r.finished_at,
                status: r.status,
                refKind: r.ref_kind,
                refId: r.ref_id,
              })),
          };
        });

  const matching = scheduleEntries.filter((s) => scheduleMatchesDomain(s, domain));
  if (matching.length === 0) {
    return { last: null, next: null, recent: [] };
  }

  let next: { at: number; depth: string } | null = null;
  for (const sched of matching) {
    if (sched.state !== "active" || sched.nextFires.length === 0) continue;
    const at = sched.nextFires[0]!;
    if (!next || at < next.at) {
      next = { at, depth: shiftDepthOf(sched.task) };
    }
  }

  const rawRuns = matching.flatMap((sched) =>
    sched.runs().map((run) => ({
      sched,
      run,
    })),
  );
  const wfRunIds = rawRuns
    .filter(({ run }) => run.refKind === "workflow_run" && typeof run.refId === "string")
    .map(({ run }) => run.refId!);
  const readMeta = wfRunMetaDep ?? ((database: LanePilotDatabase, ids: readonly string[]) => wfRunMetaByIds(database as never, ids));
  const wfRunMeta = wfRunIds.length > 0 ? readMeta(db, wfRunIds) : new Map<string, WfRunMetaRow>();

  const candidates: ShiftCandidate[] = rawRuns.map(({ sched, run }) => {
    const wfMeta = run.refKind === "workflow_run" && run.refId ? wfRunMeta.get(run.refId) : undefined;
    const at = run.finishedAt ?? run.startedAt ?? run.scheduledAt;
    const workflowId =
      wfMeta?.workflowId ??
      (sched.task.kind === "workflow" ? sched.task.workflowId : sched.task.kind === "agent" ? "agent-routine" : null);
    const runId = run.refKind === "workflow_run" ? run.refId : run.refId ?? null;
    return {
      at,
      depth: shiftDepthOf(sched.task, wfMeta ? parseJsonObject(wfMeta.inputsJson) : undefined),
      outcome: run.status,
      workflowId,
      runId,
      sortKey: run.scheduledAt,
      seq: run.id,
    };
  });

  candidates.sort((a, b) => b.at - a.at || b.sortKey - a.sortKey || b.seq.localeCompare(a.seq));
  const recent = candidates.slice(0, RECENT_SHIFTS_LIMIT).map(({ sortKey: _s, seq: _q, ...shift }) => shift);
  const last = recent.find((shift) => shift.outcome !== "skipped") ?? recent[0] ?? null;

  return { last, next, recent };
}
