/**
 * A check that fails once and passes on the re-run is called flaky, and «load» used to be the usual guess. Matvey Maslov's
 * flaky-evidence (MIT, agent-dev-tools) keeps what the guess needs: the first failure itself (the re-run's pass used to replace it),
 * a machine reading taken just before the failing attempt, and the basis of the verdict. The reading is one sample BEFORE the
 * attempt, never during it: a spike in the middle of the run is invisible, so a quiet reading proves nothing and the verdict
 * then stays «unexplained» (possible race or order dependence). The reading is taken on the machine the check runs on.
 */

/** What the host that runs the check says about itself right before an attempt; null where it cannot tell (never a made-up zero). */
export type MachineReading = {
  /** The machine the numbers describe. */
  hostId: string;
  at: number;
  /** 1-minute load average and the CPU count: load per CPU above 1 means runnable work was queueing. Null on Windows (no load average). */
  load1: number | null;
  cpuCount: number | null;
  /** Memory a new program can get without swapping: free + cache on Linux, free + inactive + speculative on macOS (its `freemem` is always near zero). */
  memFreeBytes: number | null;
  memTotalBytes: number | null;
  /** The volume of the check's workspace: a full disk made checks fail (OVH 2026-10-03, the Mac mini). */
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
};

/** Where a reading counts as pressure; the same numbers are written into the verdict. */
export const PRESSURE_LIMITS = { loadPerCpu: 1.5, memFreeShare: 0.05, memFreeBytes: 1024 ** 3, diskFreeBytes: 3 * 1024 ** 3, diskFreeShare: 0.02 } as const;

export type FlakyEvidence = {
  /** The first failure: the exit code and the end of its output; the re-run's pass no longer hides it. */
  firstFailure: { exitCode: number; outputTail: string };
  classification: "machine_pressure" | "unexplained";
  /** Why, in numbers, and what the reading can and cannot show. */
  basis: string;
  /** Taken just before the failing attempt and just before the re-run; null when the host could not say. */
  readings: { beforeFirst: MachineReading | null; beforeRerun: MachineReading | null };
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const SAMPLING_NOTE = "readings are one sample just before each attempt, not during it";

/** The readings of one sample that crossed a limit, in words; empty when none did or none was available. */
export function pressureOf(reading: MachineReading): string[] {
  const found: string[] = [];
  if (reading.load1 !== null && reading.cpuCount) {
    const perCpu = reading.load1 / reading.cpuCount;
    if (perCpu >= PRESSURE_LIMITS.loadPerCpu) found.push(`load average ${reading.load1.toFixed(1)} on ${reading.cpuCount} CPUs (${perCpu.toFixed(1)} per CPU, limit ${PRESSURE_LIMITS.loadPerCpu})`);
  }
  if (reading.memFreeBytes !== null && reading.memTotalBytes) {
    const share = reading.memFreeBytes / reading.memTotalBytes;
    if (share <= PRESSURE_LIMITS.memFreeShare && reading.memFreeBytes < PRESSURE_LIMITS.memFreeBytes) found.push(`available memory ${gb(reading.memFreeBytes)} of ${gb(reading.memTotalBytes)} (${Math.round(share * 100)} %)`);
  }
  if (reading.diskFreeBytes !== null) {
    const share = reading.diskTotalBytes ? reading.diskFreeBytes / reading.diskTotalBytes : 1;
    if (reading.diskFreeBytes < PRESSURE_LIMITS.diskFreeBytes || share <= PRESSURE_LIMITS.diskFreeShare) found.push(`free disk ${gb(reading.diskFreeBytes)}${reading.diskTotalBytes ? ` of ${gb(reading.diskTotalBytes)}` : ""}`);
  }
  return found;
}

/** One line for the reading that was taken, for a verdict that finds no pressure in it. */
function describe(reading: MachineReading): string {
  const parts = [
    reading.load1 !== null && reading.cpuCount ? `load ${(reading.load1 / reading.cpuCount).toFixed(1)} per CPU` : null,
    reading.memFreeBytes !== null && reading.memTotalBytes ? `${Math.round(reading.memFreeBytes / reading.memTotalBytes * 100)} % memory available` : null,
    reading.diskFreeBytes !== null ? `${gb(reading.diskFreeBytes)} disk free` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "no number in it";
}

/** One sentence on a single reading, for a place that has no pass to compare with (the regression pass's «red at its merge commit as well»); never names load without a reading. */
export function readingNote(reading: MachineReading | null): string {
  if (!reading) return `no machine reading was available before the run, so no load is claimed (${SAMPLING_NOTE})`;
  const pressure = pressureOf(reading);
  return pressure.length ? `machine pressure before the run on ${reading.hostId}: ${pressure.join("; ")} (${SAMPLING_NOTE})` : `no limit crossed before the run on ${reading.hostId} (${describe(reading)}; ${SAMPLING_NOTE})`;
}

/** The verdict on a failure that passed on the re-run, from the reading before the failing attempt only; never names load without a reading. */
export function flakyEvidence(first: { exitCode: number; outputTail: string }, beforeFirst: MachineReading | null, beforeRerun: MachineReading | null): FlakyEvidence {
  const pressure = beforeFirst ? pressureOf(beforeFirst) : [];
  const where = beforeFirst ? ` on ${beforeFirst.hostId}` : "";
  const basis = pressure.length
    ? `before the failing attempt${where}: ${pressure.join("; ")}; ${SAMPLING_NOTE}`
    : beforeFirst
      ? `no limit crossed before the failing attempt${where} (${describe(beforeFirst)}), so the machine is not shown to be the cause; a spike during the run is not seen (${SAMPLING_NOTE}); possible race or order dependence`
      : "no machine reading was available before the failing attempt, so no load is claimed; possible race or order dependence";
  return { firstFailure: first, classification: pressure.length ? "machine_pressure" : "unexplained", basis, readings: { beforeFirst, beforeRerun } };
}

/** A reading from the host's `diskFree` answer (asked with `machine: true`); null when the host did not answer. */
export function readingFrom(answer: { hostId: string; freeBytes: number; totalBytes: number; machine?: { load1: number | null; cpuCount: number | null; memFreeBytes: number | null; memTotalBytes: number | null } } | null | undefined, at = Date.now()): MachineReading | null {
  if (!answer || typeof answer.freeBytes !== "number") return null;
  return { hostId: answer.hostId, at, load1: answer.machine?.load1 ?? null, cpuCount: answer.machine?.cpuCount ?? null, memFreeBytes: answer.machine?.memFreeBytes ?? null,
    memTotalBytes: answer.machine?.memTotalBytes ?? null, diskFreeBytes: answer.freeBytes, diskTotalBytes: answer.totalBytes || null };
}

const TAIL_CHARS = 2000;
/** The end of a failed check's output, bounded: the first failure is kept for the audit, not for a retry brief. */
export function outputTail(result: { stdout?: string; stderr?: string }): string {
  return `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().slice(-TAIL_CHARS);
}
