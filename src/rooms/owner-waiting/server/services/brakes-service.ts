import { BRAKE_IDS, type BrakeId, type BrakeState, type BrakesOutput, type StopAllOutput } from "../../../contracts";

export interface SchedulesBrakePort {
  getState: () => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  setState: (paused: boolean, reason?: string) => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  activeCount: () => Promise<number> | number;
}

export interface ConveyorBrakePort {
  getState: () => Promise<{ on: boolean; since: string | null; reason: string | null }>;
  setState: (on: boolean, reason?: string) => Promise<{ on: boolean; since: string | null; reason: string | null }>;
  queuedCount: () => Promise<number> | number;
}

export interface GraphsBrakePort {
  getState: () => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  setState: (paused: boolean, reason?: string) => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  triggeredCount: () => Promise<number> | number;
}

export interface StaffBrakePort {
  getState: () => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  setState: (paused: boolean, reason?: string) => Promise<{ paused: boolean; since: number | null; reason: string | null }>;
  activeSpecialistCount: () => Promise<number> | number;
}

export interface BrakesLog {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface BrakesDeps {
  schedules?: SchedulesBrakePort | null;
  conveyor?: ConveyorBrakePort | null;
  graphs?: GraphsBrakePort | null;
  staff?: StaffBrakePort | null;
  listActiveRunIds?: () => Promise<string[]> | string[];
  haltRun?: (runId: string) => Promise<{ ok: boolean }>;
  log?: BrakesLog;
}

const IMPACT_LABELS: Record<BrakeId, string> = {
  schedules: "active schedules",
  conveyor: "queued writer attempts",
  graphs: "triggered workflows",
  staff: "specialists with active schedules",
};

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampCount(raw: number): number {
  return Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
}

function unavailableBrake(id: BrakeId): BrakeState {
  return {
    id,
    paused: false,
    since: null,
    reason: "unavailable",
    impact: { label: IMPACT_LABELS[id], count: 0 },
  };
}

/**
 * Coordinates the four independent owner brakes (`schedules`, `conveyor`, `graphs`, `staff`) and `stop_all`.
 * Backing stores are injected so every brake fails closed/degrades to `unavailable` without crashing the others.
 */
export function createBrakesService(deps: BrakesDeps) {
  const warn = (message: string) => deps.log?.warn?.(message);
  const info = (message: string) => deps.log?.info?.(message);

  async function safeCount(id: BrakeId, read: (() => Promise<number> | number) | undefined): Promise<number> {
    if (!read) return 0;
    try {
      return clampCount(await read());
    } catch (cause) {
      warn(`[brakes] impact id=${id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 0;
    }
  }

  async function readBrake(id: BrakeId): Promise<BrakeState> {
    const label = IMPACT_LABELS[id];
    try {
      switch (id) {
        case "schedules": {
          if (!deps.schedules) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return unavailableBrake(id);
          }
          const [state, count] = await Promise.all([
            deps.schedules.getState(),
            safeCount(id, deps.schedules.activeCount),
          ]);
          return { id, paused: state.paused, since: state.since, reason: state.reason, impact: { label, count } };
        }
        case "conveyor": {
          if (!deps.conveyor) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return unavailableBrake(id);
          }
          const [state, count] = await Promise.all([
            deps.conveyor.getState(),
            safeCount(id, deps.conveyor.queuedCount),
          ]);
          return {
            id,
            paused: !state.on,
            since: parseIsoMs(state.since),
            reason: state.reason ?? null,
            impact: { label, count },
          };
        }
        case "graphs": {
          if (!deps.graphs) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return unavailableBrake(id);
          }
          const [state, count] = await Promise.all([
            deps.graphs.getState(),
            safeCount(id, deps.graphs.triggeredCount),
          ]);
          return { id, paused: state.paused, since: state.since, reason: state.reason, impact: { label, count } };
        }
        case "staff": {
          if (!deps.staff) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return unavailableBrake(id);
          }
          const [state, count] = await Promise.all([
            deps.staff.getState(),
            safeCount(id, deps.staff.activeSpecialistCount),
          ]);
          return { id, paused: state.paused, since: state.since, reason: state.reason, impact: { label, count } };
        }
      }
    } catch (cause) {
      warn(`[brakes] brake=${id} unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
      return unavailableBrake(id);
    }
  }

  async function applyBrake(id: BrakeId, paused: boolean, reason?: string): Promise<void> {
    const cleanReason = reason?.trim().slice(0, 300) || undefined;
    info(`[brakes] set id=${id} paused=${paused} by=rpc reason=${cleanReason ?? "-"}`);
    try {
      switch (id) {
        case "schedules":
          if (!deps.schedules) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return;
          }
          await deps.schedules.setState(paused, cleanReason);
          return;
        case "conveyor":
          if (!deps.conveyor) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return;
          }
          await deps.conveyor.setState(!paused, cleanReason);
          return;
        case "graphs":
          if (!deps.graphs) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return;
          }
          await deps.graphs.setState(paused, cleanReason);
          return;
        case "staff":
          if (!deps.staff) {
            warn(`[brakes] brake=${id} unavailable: backing store missing`);
            return;
          }
          await deps.staff.setState(paused, cleanReason);
          return;
      }
    } catch (cause) {
      warn(`[brakes] brake=${id} unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function get(): Promise<BrakesOutput> {
    const brakes = await Promise.all(BRAKE_IDS.map((id) => readBrake(id)));
    return { brakes };
  }

  async function set(input: { id: BrakeId; paused: boolean; reason?: string }): Promise<BrakesOutput> {
    await applyBrake(input.id, input.paused, input.reason);
    return await get();
  }

  async function stopAll(input: { reason: string }): Promise<StopAllOutput> {
    const cleanReason = input.reason.trim().slice(0, 300);
    for (const id of BRAKE_IDS) {
      await applyBrake(id, true, cleanReason);
    }

    let runIds: string[] = [];
    if (deps.listActiveRunIds) {
      try {
        runIds = [...new Set(await deps.listActiveRunIds())];
      } catch (cause) {
        warn(`[brakes] stop_all listActiveRunIds failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }

    const halted: StopAllOutput["halted"] = [];
    for (const runId of runIds) {
      if (!deps.haltRun) {
        warn(`[brakes] stop_all halt_run unavailable for runId=${runId}`);
        halted.push({ runId, ok: false });
        continue;
      }
      try {
        const res = await deps.haltRun(runId);
        const ok = Boolean(res?.ok);
        if (!ok) warn(`[brakes] stop_all halt_run returned ok=false runId=${runId}`);
        halted.push({ runId, ok });
      } catch (cause) {
        warn(`[brakes] stop_all halt_run failed runId=${runId}: ${cause instanceof Error ? cause.message : String(cause)}`);
        halted.push({ runId, ok: false });
      }
    }

    const haltedCount = halted.filter((item) => item.ok).length;
    const failedCount = halted.length - haltedCount;
    info(`[brakes] stop_all halted=${haltedCount} failed=${failedCount}`);

    const { brakes } = await get();
    return { brakes, halted };
  }

  return { get, set, stopAll };
}
