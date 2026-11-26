export type WriterReuseStats = {
  /** Writer tasks dispatched in the period, and how many of them ended accepted. */
  tasks: number; accepted: number;
  /** Writer threads started: each is a cold session that re-reads the project. */
  coldThreads: number;
  /** Attempts that continued an existing writer thread (an area's next task or a redo in place). */
  continued: number;
  /** Cold threads per accepted task; 1 or less is a writer per task, SelfyStudio's page port was 2.2. */
  coldPerAccepted: number | null;
  /** Share of tasks that named an area, and accepted tasks per area. */
  areaShare: number | null; tasksPerArea: number | null;
  /** Median minutes from dispatch to acceptance. */
  medianMinutesToAccept: number | null;
};

export type TaskAcceptanceRow = { createdAt: number; acceptedAt: number | null; area: string | null };
export type WriterThreadTurnRow = { turns: number };

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Aggregate task acceptance and writer-thread reuse rows. */
export function computeWriterReuseStats(
  tasks: readonly TaskAcceptanceRow[],
  threads: readonly WriterThreadTurnRow[],
): WriterReuseStats {
  const accepted = tasks.filter((row) => row.acceptedAt !== null);
  const continued = threads.reduce((sum, row) => sum + row.turns - 1, 0);
  const waits = accepted.map((row) => (row.acceptedAt! - row.createdAt) / 60_000).sort((a, b) => a - b);
  const areas = new Set(accepted.map((row) => row.area?.trim().toLowerCase()).filter(Boolean));
  const withArea = tasks.filter((row) => row.area).length;
  return {
    tasks: tasks.length, accepted: accepted.length, coldThreads: threads.length, continued,
    coldPerAccepted: accepted.length ? round1(threads.length / accepted.length) : null,
    areaShare: tasks.length ? Math.round(100 * withArea / tasks.length) : null,
    tasksPerArea: areas.size ? round1(accepted.filter((row) => row.area).length / areas.size) : null,
    medianMinutesToAccept: waits.length ? Math.round(waits[Math.floor((waits.length - 1) / 2)]!) : null,
  };
}
