import type Database from "better-sqlite3";

/** Only `prepare` is needed — any room's narrowed db view (WallDb, tests) fits. */
export type WatchDb = Pick<Database.Database, "prepare">;

/**
 * Jaggedness watch over `lane_pilot_jev_receipt` (audit C11): a judgment can be fine on average and broken on a slice —
 * one project, after a model or prompt change, or after going silent. The report slices the receipts by judgment and
 * project, compares the window against the same slice's baseline, and names the slices that moved: accuracy_drop,
 * error_spike, escalation_spike, latency_spike, went_dead (was asked, now silent or all errors) and new (a slice the
 * baseline never saw, informational).
 *
 * Read-only: nothing here writes or changes a threshold. `bb lane-pilot jev watch` prints it; the wall morning gets one
 * line from `watchMorningLine`.
 */

export type WatchFindingKind = "accuracy_drop" | "error_spike" | "escalation_spike" | "latency_spike" | "went_dead" | "new_slice";

export type WatchSlice = {
  judgment: string; project: string;
  calls: number; escalated: number; fellBack: number; errors: number;
  labeled: number; agree: number; disagree: number;
  /** agree / labeled of the window; null with no labels. */
  accuracy: number | null;
  /** Baseline accuracy of the same slice; null when the baseline had no labels. */
  baselineAccuracy: number | null;
  baselineCalls: number;
  meanLatencyMs: number | null; baselineLatencyMs: number | null;
  tokensIn: number;
};

export type WatchFinding = { kind: WatchFindingKind; judgment: string; project: string; detail: string };
export type WatchReport = { sinceMs: number; baselineSinceMs: number; slices: WatchSlice[]; findings: WatchFinding[] };

const MIN_CALLS = 5;
const MIN_BASELINE_CALLS = 3;
const DROP = 0.2;
const ERR_SPIKE = 0.2;
const ESC_SPIKE = 0.3;
const LAT_RATIO = 2;

type Row = {
  judgment: string; project_id: string | null; status: string; decided_by: string; outcome: string | null;
  latency_ms: number | null; tokens_in: number | null;
};

type Agg = { calls: number; escalated: number; fellBack: number; errors: number; labeled: number; agree: number; disagree: number; latency: number; latencyN: number; tokensIn: number };

const blank = (): Agg => ({ calls: 0, escalated: 0, fellBack: 0, errors: 0, labeled: 0, agree: 0, disagree: 0, latency: 0, latencyN: 0, tokensIn: 0 });

function fold(agg: Agg, row: Row): Agg {
  if (row.status === "ok") {
    agg.calls += 1;
    if (row.decided_by === "escalated") agg.escalated += 1;
    if (row.decided_by === "fallback") agg.fellBack += 1;
    if (row.latency_ms !== null) { agg.latency += row.latency_ms; agg.latencyN += 1; }
    if (row.tokens_in !== null) agg.tokensIn += row.tokens_in;
  } else if (row.status !== "disabled") {
    agg.errors += 1;
  }
  const outcome = row.outcome ?? "";
  if (outcome.startsWith("agree")) { agg.labeled += 1; agg.agree += 1; }
  else if (outcome.startsWith("disagree")) { agg.labeled += 1; agg.disagree += 1; }
  return agg;
}

const key = (row: Row) => `${row.judgment}${row.project_id ?? ""}`;
const pct = (a: Agg) => (a.calls ? a.escalated / a.calls : 0);
const errRate = (a: Agg) => (a.calls + a.errors ? a.errors / (a.calls + a.errors) : 0);
const acc = (a: Agg) => (a.labeled ? a.agree / a.labeled : null);
const meanLat = (a: Agg) => (a.latencyN ? Math.round(a.latency / a.latencyN) : null);
const round2 = (n: number) => Math.round(n * 100) / 100;
const name = (judgment: string, project: string) => (project === "—" ? judgment : `${judgment} @${project}`);

/**
 * The report over the receipts: `sinceMs` starts the window, `baselineSinceMs` the baseline that ends at the window's
 * start (default: `baselineDays` before the window).
 */
export function jevWatch(db: WatchDb, input: { sinceMs: number; now?: number; baselineDays?: number }): WatchReport {
  const now = input.now ?? Date.now();
  const baselineSince = now - (input.baselineDays ?? 30) * 86_400_000;
  const rows = db.prepare(`SELECT judgment, project_id, status, decided_by, outcome, latency_ms, tokens_in, at FROM lane_pilot_jev_receipt WHERE at >= ? AND at < ?`).all(baselineSince, now + 1) as Array<Row & { at: number }>;
  const window = new Map<string, Agg>(), baseline = new Map<string, Agg>(), labels = new Map<string, { judgment: string; project: string }>();
  for (const row of rows) {
    const k = key(row);
    labels.set(k, { judgment: row.judgment, project: row.project_id ?? "—" });
    fold(row.at >= input.sinceMs ? window.get(k) ?? window.set(k, blank()).get(k)! : baseline.get(k) ?? baseline.set(k, blank()).get(k)!, row);
  }
  const slices: WatchSlice[] = [], findings: WatchFinding[] = [];
  for (const [k, { judgment, project }] of [...labels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const w = window.get(k) ?? blank(), b = baseline.get(k) ?? blank();
    const slice: WatchSlice = {
      judgment, project, calls: w.calls, escalated: w.escalated, fellBack: w.fellBack, errors: w.errors,
      labeled: w.labeled, agree: w.agree, disagree: w.disagree,
      accuracy: acc(w), baselineAccuracy: acc(b), baselineCalls: b.calls,
      meanLatencyMs: meanLat(w), baselineLatencyMs: meanLat(b), tokensIn: w.tokensIn,
    };
    if (!w.calls && !w.errors && !b.calls) continue;
    slices.push(slice);
    const find = (kind: WatchFindingKind, detail: string) => findings.push({ kind, judgment, project, detail });
    const baseAcc = acc(b), winAcc = acc(w);
    if (b.calls >= MIN_BASELINE_CALLS && w.calls + w.errors === 0) find("went_dead", `was asked ${b.calls}× in the baseline, silent in the window`);
    else if (b.calls >= MIN_BASELINE_CALLS && w.calls === 0 && w.errors > 0) find("went_dead", `was asked ${b.calls}× in the baseline, the window is all errors (${w.errors})`);
    if (winAcc !== null && baseAcc !== null && w.labeled >= MIN_CALLS && b.labeled >= MIN_CALLS && winAcc <= baseAcc - DROP)
      find("accuracy_drop", `agreement ${round2(winAcc)} vs baseline ${round2(baseAcc)} (${w.labeled} labels)`);
    if (w.calls >= MIN_CALLS && errRate(w) >= 0.3 && errRate(w) >= errRate(b) + ERR_SPIKE)
      find("error_spike", `error rate ${round2(errRate(w))} vs baseline ${round2(errRate(b))} (${w.errors}/${w.calls + w.errors})`);
    if (w.calls >= MIN_CALLS && pct(w) >= 0.5 && pct(w) >= pct(b) + ESC_SPIKE)
      find("escalation_spike", `escalated ${round2(pct(w))} of calls vs baseline ${round2(pct(b))}`);
    if (w.latencyN >= MIN_CALLS && b.latencyN >= MIN_CALLS && meanLat(w)! >= 2000 && meanLat(w)! >= LAT_RATIO * meanLat(b)!)
      find("latency_spike", `mean latency ${meanLat(w)}ms vs baseline ${meanLat(b)}ms`);
    if (!b.calls && w.calls > 0) find("new_slice", `first ${w.calls} call${w.calls === 1 ? "" : "s"} — no baseline to compare`);
  }
  return { sinceMs: input.sinceMs, baselineSinceMs: baselineSince, slices, findings };
}

/** One line for the wall morning (`bb lane-pilot wall morning`): what the receipts say, and whether any slice moved. */
export function watchMorningLine(db: WatchDb, now: number = Date.now()): string {
  const report = jevWatch(db, { sinceMs: now - 86_400_000, now });
  const calls = report.slices.reduce((sum, row) => sum + row.calls, 0);
  const errors = report.slices.reduce((sum, row) => sum + row.errors, 0);
  const escalated = report.slices.reduce((sum, row) => sum + row.escalated, 0);
  const hard = report.findings.filter((row) => row.kind !== "new_slice");
  const tail = hard.length ? ` деградаций ${hard.length} (${hard.map((row) => `${name(row.judgment, row.project)}:${row.kind}`).join(", ")}).` : " деградаций не видно.";
  return `Jev: вызовов ${calls} (эскалаций ${escalated}, сбоев ${errors});${tail}`;
}

const clip = (value: string, width: number) => (value.length > width ? `${value.slice(0, width - 1)}…` : value.padEnd(width));
const num = (value: number | null) => (value === null ? "  —" : String(value).padStart(3));

/** The report as a fixed-width table the CLI prints: findings first, then every slice. */
export function renderWatch(report: WatchReport): string {
  const lines = [`Jev watch since ${new Date(report.sinceMs).toISOString().slice(0, 10)} (baseline from ${new Date(report.baselineSinceMs).toISOString().slice(0, 10)}):`];
  if (!report.slices.length) lines.push("  no receipts in the window or the baseline");
  for (const row of report.findings) lines.push(`  ${row.kind.padEnd(18)} ${name(row.judgment, row.project)}: ${row.detail}`);
  if (report.slices.length) {
    lines.push(`  ${"judgment @project".padEnd(38)} ${"calls".padStart(5)} ${"err".padStart(3)} ${"esc".padStart(4)} ${"acc".padStart(5)} ${"base".padStart(5)} ${"lat".padStart(6)}`);
    for (const row of report.slices) {
      const accText = (value: number | null) => (value === null ? "   — " : `${Math.round(value * 100)}%`.padStart(5));
      lines.push(`  ${clip(name(row.judgment, row.project), 38)} ${String(row.calls).padStart(5)} ${num(row.errors)} ${String(row.escalated).padStart(4)} ${accText(row.accuracy)} ${accText(row.baselineAccuracy)} ${String(row.meanLatencyMs ?? "—").padStart(6)}`);
    }
  }
  return lines.join("\n");
}
