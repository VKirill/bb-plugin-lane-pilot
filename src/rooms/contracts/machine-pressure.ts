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

export type FlakyEvidence = {
  /** The first failure: the exit code and the end of its output; the re-run's pass no longer hides it. */
  firstFailure: { exitCode: number; outputTail: string };
  classification: "machine_pressure" | "unexplained";
  /** Why, in numbers, and what the reading can and cannot show. */
  basis: string;
  /** Taken just before the failing attempt and just before the re-run; null when the host could not say. */
  readings: { beforeFirst: MachineReading | null; beforeRerun: MachineReading | null };
};
