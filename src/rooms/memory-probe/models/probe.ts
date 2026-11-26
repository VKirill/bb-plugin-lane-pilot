import type { MemoryPath, ProbeKind } from "../../memory";

export const PROBE_ANCHOR = "lp-probe/memory";

export type MemoryProbeRow = { path: string; found: boolean; negativeOk: boolean | null; latencyMs: number; detail: string };
export type MemoryProbeReport = {
  ok: boolean; projectId: string; token: string; anchor: string; lpVersion: string; at: number; kept: boolean;
  tokens: Record<ProbeKind, string>; planted: Record<ProbeKind, boolean>;
  results: MemoryProbeRow[]; skipped: Array<{ path: string; reason: string }>; problems: string[];
};

export type Probe = {
  delivered: string;
  /** The same path for a task or a query that has nothing to do with the probe; null when there is no such case. */
  negative: string | null;
  /** Records the gibberish query pulled. */
  pulled?: number;
};

/** Found: every kind the path carries is in the text. Negative: no kind outside `alwaysOn` in the unrelated case, and nothing pulled by a gibberish query. */
export function judge(entry: MemoryPath, probe: Probe, tokens: Record<ProbeKind, string>, latencyMs: number): MemoryProbeRow {
  const missing = entry.carries.filter((kind) => !probe.delivered.includes(tokens[kind]));
  const stray = probe.negative === null ? [] : (["note", "core"] as const).filter((kind) => !entry.alwaysOn.includes(kind) && probe.negative!.includes(tokens[kind]));
  const negativeOk = probe.negative === null ? null : stray.length === 0 && (probe.pulled ?? 0) === 0;
  const detail = [
    `carries ${entry.carries.join("+")}: ${missing.length ? `MISSING ${missing.join("+")}` : "all found"}`,
    `${probe.delivered.length} chars`,
    ...(negativeOk === false ? [`negative case pulled ${stray.length ? stray.join("+") : `${probe.pulled} record(s)`}`] : []),
  ].join("; ");
  return { path: entry.id, found: missing.length === 0, negativeOk, latencyMs, detail };
}
