import { isOffered, type StoredWorkflow } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "../storage";
import { ERRAND_EPISODE_TABLE } from "../contracts/server";
import { errandStem, errandTitle, kindOf, routeConfidence } from "./logic";
import { errandOutcome, type ErrandOutcome, type ErrandVerifiedOutcome } from "../contracts/server";
import { latestErrandEpisodeRows, listErrandEpisodeRunIds } from "../storage";
import { listWfRunsByIdsOrdered, listWfRunsSince } from "@lane-pilot/workflow-engine";

/**
 * The errand diagnosis (stage-1 stream F, plan R7): what the errands of a period came to, what they cost, where they
 * repeat, where the router almost had a graph, which offered skills went unused and which fixture graphs litter the
 * catalog. Read-only: every number carries its N. The phase-B columns of the episode table (stream D) are read through
 * a column check, so a database without them answers «нет данных» for those sections instead of failing.
 */
const DAY_MS = 86_400_000;
const USD = 1_000_000;
const NEAR_MISS_LO = 60;
const NEAR_MISS_HI = 89;
const REPEAT_TOP = 5;
const SKILL_TOP = 10;
const FIXTURE_ID = /^(?:pm-)?fixture-/u;

type Db = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown } };

const parse = <T,>(text: string | null | undefined, fallback: T): T => { try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; } };

export type DiagnosisShare = { count: number; of: number };
export type DiagnosisKindCost = { kind: string; runs: number; costUsd: number; medianUsd: number | null; medianMinutes: number | null };
export type ErrandsDiagnosis = {
  days: number;
  projectId: string | null;
  /** Errand-originated runs in the window: the `errand` graph's own plus the ones the router sent to another graph (they carry an episode row). */
  runs: number;
  ended: number;
  outcomes: Record<ErrandOutcome, number>;
  verified: Record<ErrandVerifiedOutcome, number>;
  /** `verified === "unknown"` among the ended runs — the share the acceptance asks to see. */
  unknownVerified: DiagnosisShare;
  cost: { totalUsd: number; medianUsd: number | null; medianMinutes: number | null; byKind: DiagnosisKindCost[] };
  /** Episode `failure_class` counts; `available` false when the column is not there yet. */
  failureClasses: { available: boolean; counts: Array<{ name: string; count: number }> };
  repeats: {
    /** Groups of ≥ 2 runs by process_key, else process_key_proposed, else the title stem. */
    groups: number;
    /** Groups with ≥ 2 runs of the same kind — the only ones «second cheaper than first» means anything on. */
    comparable: number;
    cheaperSecond: DiagnosisShare;
    top: Array<{ key: string; kind: string; runs: number; costUsd: number }>;
  };
  /** `routeTop` confidence 60–89: the router had a candidate but not a sure one. `of` counts the runs that carried a routeTop at all. */
  nearMisses: { count: number; of: number; byTarget: Array<{ name: string; count: number }> };
  /** Skills the episodes were offered but never used (summary_json.skills); `available` false without the column. */
  skillsUnused: { available: boolean; of: number; counts: Array<{ name: string; count: number }> };
  /** Published user graphs (not built-in, not deprecated) whose id is a pm-fixture-/fixture- test leftover. */
  catalog: { available: boolean; count: number; ids: string[] };
};

type RunDiagRow = {
  id: string; project_id: string | null; workflow_id: string; status: string; reason: string | null;
  inputs_json: string; output_json: string | null; tokens_used: number; cost_micro_usd: number; created_at: number; updated_at: number;
  process_key: string | null; process_key_proposed: string | null; failure_class: string | null; summary_json: string | null;
};

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The episode table's columns, or an empty set when the table itself is not there (a pre-episode database). */
function episodeColumns(db: Db): Set<string> {
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(ERRAND_EPISODE_TABLE) as { name: string } | undefined;
    if (!table) return new Set();
    return new Set((db.prepare(`PRAGMA table_info(${ERRAND_EPISODE_TABLE})`).all() as Array<{ name: string }>).map((row) => row.name));
  } catch { return new Set(); }
}

/** The errand runs of the window with their episode facts; routed runs enter through their pending episode row. */
function diagRuns(db: Db, input: { days: number; projectId?: string | undefined }): { rows: RunDiagRow[]; columns: Set<string> } {
  const since = Date.now() - input.days * DAY_MS;
  const columns = episodeColumns(db);
  const has = (name: string) => columns.has(name);
  const episodeCols = ["process_key", "process_key_proposed", "failure_class", "summary_json"].filter(has);
  const join = columns.size
    ? `LEFT JOIN ${ERRAND_EPISODE_TABLE} e ON e.run_id = r.id
       AND e.extractor_version = (SELECT MAX(e2.extractor_version) FROM ${ERRAND_EPISODE_TABLE} e2 WHERE e2.run_id = r.id)`
    : "";
  const episodeSelect = episodeCols.length ? `, ${episodeCols.map((name) => `e.${name}`).join(", ")}` : "";
  const select = episodeSelect;
  const routed = columns.size ? "OR e.run_id IS NOT NULL" : "";
  const errandRows = listWfRunsSince(db as never, { since, projectId: input.projectId ?? null });
  const errandIds = new Set(errandRows.map((row) => row.id));
  const routedIds = columns.size ? [...listErrandEpisodeRunIds(db as never)].filter((id) => !errandIds.has(id)) : [];
  const all = [...errandRows, ...listWfRunsByIdsOrdered(db as never, routedIds, input.projectId ?? null).filter((row) => row.created_at >= since)].sort((a, b) => a.created_at - b.created_at);
  const episodes = columns.size ? latestErrandEpisodeRows(db as never, all.map((row) => row.id)) : new Map<string, Record<string, unknown>>();
  const rows = all.map((row) => {
    const episode = episodes.get(row.id);
    const extra = Object.fromEntries(episodeCols.map((name) => [name, episode?.[name] ?? null]));
    return { ...row, ...extra } as unknown as RunDiagRow;
  });
  return { rows, columns };
}

/** The kind a run repeats under: the errand kind, or the graph it was routed to (its inputs carry no kind). */
const runKind = (row: RunDiagRow, inputs: Record<string, unknown>): string => {
  const kind = kindOf(inputs.kind);
  return kind === "none" && row.workflow_id !== "errand" ? row.workflow_id : kind;
};

/**
 * The diagnosis of the period. `workflows` is the catalog store's `list()` (pass `store.peek()?.list() ?? []` where a
 * synchronous read is needed); without it the catalog section reports itself unavailable.
 */
export function errandsDiagnosis(db: LanePilotDatabase, input: { days: number; projectId?: string | undefined }, deps: { workflows?: readonly StoredWorkflow[] } = {}): ErrandsDiagnosis {
  const { rows, columns } = diagRuns(db, input);

  const outcomes: Record<ErrandOutcome, number> = { running: 0, done: 0, blocked: 0, failed: 0, canceled: 0 };
  const verified: Record<ErrandVerifiedOutcome, number> = { done_checked: 0, done_unchecked: 0, blocked: 0, unknown: 0 };
  let ended = 0, unknownVerified = 0;
  const costs: number[] = [], minutes: number[] = [];
  const byKind = new Map<string, { runs: number; costs: number[]; minutes: number[]; total: number }>();
  const failureCounts = new Map<string, number>();
  const unusedSkills = new Map<string, number>();
  let skillSummaries = 0;
  const nearOf = new Map<string, number>();
  let nearCount = 0, routedWithTop = 0;
  const groups = new Map<string, Array<{ kind: string; costUsd: number; at: number }>>();

  for (const row of rows) {
    const inputs = parse<Record<string, unknown>>(row.inputs_json, {});
    const output = parse<{ state?: unknown; reason?: unknown; verified?: unknown } | null>(row.output_json, null);
    const { outcome, verified: ver } = errandOutcome(row.status, output, row.reason);
    outcomes[outcome] += 1;
    verified[ver] += 1;
    const isEnded = outcome !== "running";
    if (isEnded) { ended += 1; if (ver === "unknown") unknownVerified += 1; }
    const costUsd = row.cost_micro_usd / USD;
    const mins = isEnded ? Math.max(0, (row.updated_at - row.created_at) / 60_000) : null;
    if (isEnded) { costs.push(costUsd); if (mins !== null) minutes.push(mins); }
    const kind = runKind(row, inputs);
    const bucket = byKind.get(kind) ?? { runs: 0, costs: [], minutes: [], total: 0 };
    bucket.runs += 1; bucket.total += row.cost_micro_usd;
    if (isEnded) { bucket.costs.push(costUsd); if (mins !== null) bucket.minutes.push(mins); }
    byKind.set(kind, bucket);

    if (row.failure_class) failureCounts.set(row.failure_class, (failureCounts.get(row.failure_class) ?? 0) + 1);
    const summary = parse<{ skills?: unknown } | null>(row.summary_json, null);
    if (summary && Array.isArray(summary.skills)) {
      skillSummaries += 1;
      for (const item of summary.skills as Array<{ name?: unknown; offered?: unknown; used?: unknown }>) {
        if (item?.offered === true && item?.used !== true && typeof item.name === "string" && item.name) {
          unusedSkills.set(item.name, (unusedSkills.get(item.name) ?? 0) + 1);
        }
      }
    }

    const routeTop = typeof inputs.routeTop === "string" ? inputs.routeTop.trim() : "";
    if (routeTop) {
      routedWithTop += 1;
      const confidence = routeConfidence(routeTop);
      if (confidence >= NEAR_MISS_LO && confidence <= NEAR_MISS_HI) {
        nearCount += 1;
        const target = routeTop.replace(/:\d+\s*$/u, "");
        nearOf.set(target, (nearOf.get(target) ?? 0) + 1);
      }
    }

    const key = row.process_key || row.process_key_proposed || (() => { const stem = errandStem(errandTitle(inputs)); return stem ? `title:${stem}` : ""; })();
    if (key) {
      const list = groups.get(key) ?? [];
      list.push({ kind, costUsd, at: row.created_at });
      groups.set(key, list);
    }
  }

  // Repeats: a group repeats when it has ≥ 2 runs; «second cheaper than first» is judged only inside one kind.
  let repeatGroups = 0, comparable = 0, cheaper = 0;
  const repeatTop: ErrandsDiagnosis["repeats"]["top"] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    repeatGroups += 1;
    const byKindRuns = new Map<string, typeof list>();
    for (const item of list) { const bucket = byKindRuns.get(item.kind) ?? []; bucket.push(item); byKindRuns.set(item.kind, bucket); }
    const sameKind = [...byKindRuns.values()].sort((a, b) => b.length - a.length)[0]!;
    const cost = list.reduce((sum, item) => sum + item.costUsd, 0);
    if (repeatTop.length < REPEAT_TOP || cost > repeatTop[repeatTop.length - 1]!.costUsd) {
      repeatTop.push({ key, kind: sameKind[0]!.kind, runs: list.length, costUsd: cost });
      repeatTop.sort((a, b) => b.costUsd - a.costUsd);
      repeatTop.length = Math.min(repeatTop.length, REPEAT_TOP);
    }
    if (sameKind.length < 2) continue;
    comparable += 1;
    sameKind.sort((a, b) => a.at - b.at);
    if (sameKind[1]!.costUsd < sameKind[0]!.costUsd) cheaper += 1;
  }

  const catalogItems = deps.workflows ?? null;
  const litter = catalogItems === null ? { available: false, count: 0, ids: [] as string[] }
    : (() => {
        const ids = catalogItems.filter((item) => item.origin !== "builtin" && FIXTURE_ID.test(item.workflow.id) && isOffered(item.workflow)).map((item) => item.workflow.id).sort();
        return { available: true, count: ids.length, ids };
      })();

  return {
    days: input.days, projectId: input.projectId ?? null, runs: rows.length, ended,
    outcomes, verified,
    unknownVerified: { count: unknownVerified, of: ended },
    cost: {
      totalUsd: rows.reduce((sum, row) => sum + row.cost_micro_usd, 0) / USD,
      medianUsd: median(costs), medianMinutes: median(minutes),
      byKind: [...byKind.entries()].map(([kind, bucket]) => ({
        kind, runs: bucket.runs, costUsd: bucket.total / USD, medianUsd: median(bucket.costs), medianMinutes: median(bucket.minutes),
      })).sort((a, b) => b.runs - a.runs),
    },
    failureClasses: {
      available: columns.has("failure_class"),
      counts: [...failureCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    },
    repeats: { groups: repeatGroups, comparable, cheaperSecond: { count: cheaper, of: comparable }, top: repeatTop },
    nearMisses: { count: nearCount, of: routedWithTop, byTarget: [...nearOf.entries()].map(([id, count]) => ({ name: id, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 5) },
    skillsUnused: {
      available: columns.has("summary_json"),
      of: skillSummaries,
      counts: [...unusedSkills.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, SKILL_TOP),
    },
    catalog: litter,
  };
}

const pct = (share: DiagnosisShare): string => (share.of ? `${Math.round((share.count / share.of) * 100)}%` : "—");
const list = (counts: Array<{ name: string; count: number }>): string => counts.map((row) => `${row.name} ×${row.count}`).join(", ");

/** The diagnosis as plain-Russian lines for `bb lane-pilot errands diagnose` (no ids a non-programmer cannot use; fixture graph ids stay — they are the litter itself). */
export function diagnosisLines(d: ErrandsDiagnosis): string[] {
  const lines: string[] = [];
  lines.push(`Поручений за ${d.days} дн.: ${d.runs} (завершено ${d.ended}). Сделано ${d.outcomes.done}, остановилось ${d.outcomes.blocked}, сбой ${d.outcomes.failed}, отменено ${d.outcomes.canceled}, идёт ${d.outcomes.running}.`);
  lines.push(`Итог без проверки известен у ${d.ended - d.unknownVerified.count} из ${d.ended} завершённых (${pct({ count: d.ended - d.unknownVerified.count, of: d.ended })}); неизвестно — ${d.unknownVerified.count} из ${d.unknownVerified.of}.`);
  lines.push(`Цена: всего $${d.cost.totalUsd.toFixed(2)}, медиана на поручение $${d.cost.medianUsd === null ? "—" : d.cost.medianUsd.toFixed(2)}, медиана времени ${d.cost.medianMinutes === null ? "—" : `${Math.round(d.cost.medianMinutes)} мин`}.`);
  for (const row of d.cost.byKind.filter((item) => item.runs > 0).slice(0, 6)) {
    lines.push(`  ${row.kind}: ${row.runs} шт., $${row.costUsd.toFixed(2)}, медиана $${row.medianUsd === null ? "—" : row.medianUsd.toFixed(2)}, ${row.medianMinutes === null ? "—" : `${Math.round(row.medianMinutes)} мин`}`);
  }
  lines.push(d.failureClasses.available
    ? `Причины сбоев: ${d.failureClasses.counts.length ? list(d.failureClasses.counts) : "нет"}.`
    : "Причины сбоев: нет данных (колонки эпизодов ещё не развёрнуты).");
  lines.push(`Повторяющиеся процессы: групп ${d.repeats.groups}; второй прогон дешевле первого — ${d.repeats.cheaperSecond.count} из ${d.repeats.cheaperSecond.of} сопоставимых.`);
  for (const row of d.repeats.top) lines.push(`  ${row.key} (${row.kind}): ${row.runs} раз, $${row.costUsd.toFixed(2)}`);
  lines.push(`Роутер чуть не попал (уверенность 60–89): ${d.nearMisses.count} из ${d.nearMisses.of} с маршрутом.${d.nearMisses.byTarget.length ? ` Чаще всего: ${list(d.nearMisses.byTarget)}.` : ""}`);
  lines.push(d.skillsUnused.available
    ? `Навыки предлагались, но не применялись: ${d.skillsUnused.counts.length ? list(d.skillsUnused.counts) : "нет"} (${d.skillsUnused.of} эпизодов с разбором).`
    : "Навыки: нет данных (колонки эпизодов ещё не развёрнуты).");
  lines.push(d.catalog.available
    ? `Заготовки в каталоге графов (pm-fixture-/fixture-, опубликованные): ${d.catalog.count}${d.catalog.count ? ` — ${d.catalog.ids.join(", ")}` : ""}.`
    : "Каталог графов: нет данных.");
  return lines;
}

/** The one morning line: null under 5 errands in the last week, else the headline numbers of the diagnosis. */
export function errandsDiagnosisMorningLine(db: LanePilotDatabase): string | null {
  const d = errandsDiagnosis(db, { days: 7 });
  if (d.runs < 5) return null;
  const cheaper = d.repeats.cheaperSecond.of ? `, второй прогон дешевле у ${d.repeats.cheaperSecond.count} из ${d.repeats.cheaperSecond.of}` : "";
  return `Поручения за неделю: ${d.runs} (${d.outcomes.done} сделано, ${d.outcomes.failed} сбоев), цена $${d.cost.totalUsd.toFixed(2)}, итог без проверки неизвестен у ${d.unknownVerified.count} из ${d.ended}, повторов ${d.repeats.groups}${cheaper}.`;
}
