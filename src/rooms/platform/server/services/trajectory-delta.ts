import type { TrajectoryInterventionKind } from "@lane-pilot/contracts";

export type TrajectoryDeltaLogSink = {
  debug?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
};

export type TrajectoryDeltaEntry = {
  readonly id?: string;
  readonly projectId?: string | null;
  readonly threadId?: string | null;
  readonly workflowId?: string | null;
  readonly stageArchetype?: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly rawSummary: string;
  readonly resolvedSkills?: readonly string[];
  readonly ownerAccepted?: boolean;
  readonly now?: number;
};

export type TrajectoryDeltaRunFilter = {
  readonly projectId?: string | null;
  readonly workflowId?: string | null;
  readonly threadId?: string | null;
  readonly since?: number;
  readonly until?: number;
  readonly onlyAccepted?: boolean;
  readonly limit?: number;
};

export type TrajectoryDeltaStoredRow = {
  readonly id: string;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly workflowId: string | null;
  readonly stageArchetype: string;
  readonly interventionKind: TrajectoryInterventionKind;
  readonly resolvedSkills: string[];
  readonly maskedSummary: string;
  readonly ownerAccepted: boolean;
  readonly processedAt: number | null;
  readonly createdAt: number;
};

export type TrajectoryDeltaRecorder = (
  db: never,
  input: TrajectoryDeltaEntry,
) => { status?: string; reason?: string } | unknown;

export type TrajectoryDeltaReader = (
  db: never,
  filter: TrajectoryDeltaRunFilter,
) => TrajectoryDeltaStoredRow[];

const recordersByDb = new WeakMap<object, TrajectoryDeltaRecorder>();
const readersByDb = new WeakMap<object, TrajectoryDeltaReader>();

/** Binds the `errands` trajectory-delta writer for a database so other rooms record interventions without an import cycle. */
export function bindTrajectoryDeltaRecorder(db: object, recorder: TrajectoryDeltaRecorder): void {
  recordersByDb.set(db, recorder);
}

/** Binds the `errands` trajectory-delta reader for a database so other rooms read run interventions without an import cycle. */
export function bindTrajectoryDeltaReader(db: object, reader: TrajectoryDeltaReader): void {
  readersByDb.set(db, reader);
}

/** Reads trajectory deltas associated with a run via the bound `errands` reader, returning empty when unbound. */
export function listTrajectoryDeltasForRunSafe(
  db: object,
  filter: TrajectoryDeltaRunFilter,
  options?: { reader?: TrajectoryDeltaReader | undefined; log?: TrajectoryDeltaLogSink | undefined },
): TrajectoryDeltaStoredRow[] {
  const reader = options?.reader ?? readersByDb.get(db);
  if (!reader) return [];
  try {
    return reader(db as never, filter);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    options?.log?.warn?.(`trajectory delta read failed: ${message}`);
    return [];
  }
}

/** Fire-and-forget trajectory delta recording through the bound writer, with uniform DEBUG/WARN logging. */
export function recordTrajectoryDeltaSafe(
  db: object,
  input: TrajectoryDeltaEntry,
  options?: {
    recorder?: TrajectoryDeltaRecorder | undefined;
    log?: TrajectoryDeltaLogSink | undefined;
    runId?: string | null | undefined;
    graphId?: string | null | undefined;
  },
): void {
  const recorder = options?.recorder ?? recordersByDb.get(db);
  if (!recorder) return;
  const runLabel = options?.runId ?? "none";
  const graphLabel = options?.graphId ?? input.workflowId ?? "none";
  try {
    const res = recorder(db as never, input) as { status?: string; reason?: string } | undefined;
    if (res && res.status === "rejected") {
      options?.log?.warn?.(`trajectory delta write failed: ${res.reason ?? "rejected"}`);
      return;
    }
    options?.log?.debug?.(`trajectory delta kind=${input.interventionKind} run=${runLabel} graph=${graphLabel}`);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    options?.log?.warn?.(`trajectory delta write failed: ${message}`);
  }
}
