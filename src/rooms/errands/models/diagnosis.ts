import type { ErrandOutcome, ErrandVerifiedOutcome } from "../../contracts";

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
