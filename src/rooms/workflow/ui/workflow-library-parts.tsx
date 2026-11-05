import type { z } from "zod";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { WORKFLOW_CATEGORIES, workflowCategory, type WorkflowCategory } from "../categories";

type Listing = z.infer<(typeof rpcContract)["workflow_list"]["output"]>;
export type LibraryRow = Listing["workflows"][number];
export type LibraryView = "grid" | "list";
export interface CategoryGroup {
  cat: WorkflowCategory;
  rows: LibraryRow[];
}

export const STATUS_PILL: Record<LibraryRow["status"], string> = { draft: "lp-pill-muted", tested: "lp-pill-info", published: "lp-pill-success", deprecated: "lp-pill-warning" };

export const shortTime = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

const catName = (cat: WorkflowCategory) => t(`wfCat_${cat}` as I18nKey);
const runs30 = (rows: readonly LibraryRow[]) => rows.reduce((sum, row) => sum + row.stats.runs30d, 0);

/** Rows bucketed by shelf, in WORKFLOW_CATEGORIES order; empty shelves are dropped (a filtered-out group simply is not rendered). */
export function groupByCategory(rows: readonly LibraryRow[]): CategoryGroup[] {
  const byCat = new Map<WorkflowCategory, LibraryRow[]>();
  for (const row of rows) {
    const cat = workflowCategory(row);
    byCat.set(cat, [...(byCat.get(cat) ?? []), row]);
  }
  return WORKFLOW_CATEGORIES.filter((cat) => byCat.has(cat)).map((cat) => ({ cat, rows: byCat.get(cat)! }));
}

/** One chip per category that has graphs, plus «All»; a chip shows the graph count and the 30-day runs of its shelf. */
export function CategoryChips({ groups, focus, onFocus }: { groups: CategoryGroup[]; focus: WorkflowCategory | null; onFocus: (cat: WorkflowCategory | null) => void }) {
  const chip = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
      active ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-state-hover hover:text-foreground"}`;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" data-testid="wf-chips" role="group" aria-label={t("wfCatAll")}>
      <button type="button" data-testid="wf-chip-all" aria-pressed={focus === null} onClick={() => onFocus(null)} className={chip(focus === null)}>{t("wfCatAll")}</button>
      {groups.map(({ cat, rows }) => (
        <button type="button" key={cat} data-testid={`wf-chip-${cat}`} aria-pressed={focus === cat} onClick={() => onFocus(cat)} className={chip(focus === cat)}>
          {catName(cat)}
          <span className="ml-1.5 text-muted-foreground">{t("wfCatGraphs").replace("{n}", String(rows.length))} · {t("wfCatRuns30d").replace("{n}", String(runs30(rows)))}</span>
        </button>
      ))}
    </div>
  );
}

/** The shorter card: name and pills, a 2-line description, one line of metrics. Graphs that never ran are muted but stay clickable. */
export function WorkflowCard({ row, locale, onOpen }: { row: LibraryRow; locale: Locale; onOpen: (id: string) => void }) {
  const stats = row.stats;
  const metrics = [
    `${row.id} · ${t("wfVersion").replace("{n}", String(row.version))}`,
    stats.runs ? (stats.runs === 1 ? t("wfRunCountOne") : t("wfRunCount").replace("{n}", String(stats.runs))) : t("wfNoRuns"),
    t("wfRuns30d").replace("{n}", String(stats.runs30d)),
    stats.successRate !== null ? t("wfSuccessRate").replace("{pct}", String(Math.round(stats.successRate * 100))) : null,
    stats.lastRunAt ? t("wfLastRun").replace("{time}", shortTime(stats.lastRunAt)) : null,
    t("wfSteps").replace("{n}", String(row.nodes)),
    stats.active ? t("wfActiveRuns").replace("{n}", String(stats.active)) : null,
  ].filter((part): part is string => part !== null).join(" · ");
  return (
    <button type="button" data-testid={`wf-row-${row.id}`} aria-label={t("wfOpen").replace("{name}", row.name[locale])} onClick={() => onOpen(row.id)}
      className={`flex h-full w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${stats.runs ? "" : "opacity-60"}`}>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium">{row.name[locale]}</span>
        <span className={`${STATUS_PILL[row.status]} rounded-full px-2 py-0.5 text-[11px] font-medium`} data-testid={`wf-status-${row.id}`}>{t(`wfStatus_${row.status}` as I18nKey)}</span>
        <span className="lp-pill-neutral rounded-full px-2 py-0.5 text-[11px] font-medium" data-testid={`wf-scope-${row.id}`}>{t(`wfScope_${row.scope}` as I18nKey)}</span>
        {row.internal ? <span className="lp-pill-muted rounded-full px-2 py-0.5 text-[11px] font-medium">{t("wfInternal")}</span> : null}
      </span>
      <span className="line-clamp-2 break-words text-xs text-muted-foreground">{row.description[locale]}</span>
      <span className="truncate text-xs text-muted-foreground" data-testid={`wf-stats-${row.id}`}>{metrics}</span>
    </button>
  );
}

const cardsCls = (view: LibraryView) => view === "grid" ? "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" : "divide-y divide-border/60";

/** One shelf: a collapsible header, the «Most used» top-3 by runs30d, then the rest of the shelf's graphs. */
export function CategorySection({ cat, rows, collapsed, focused, onToggle, view, locale, onOpen }: {
  cat: WorkflowCategory; rows: LibraryRow[]; collapsed: boolean; focused: boolean;
  onToggle: () => void; view: LibraryView; locale: Locale; onOpen: (id: string) => void;
}) {
  const top = rows.filter((row) => row.stats.runs30d > 0).sort((a, b) => b.stats.runs30d - a.stats.runs30d).slice(0, 3);
  const topIds = new Set(top.map((row) => row.id));
  const rest = rows.filter((row) => !topIds.has(row.id));
  return (
    <section data-cat={cat} data-focused={focused ? "1" : undefined} data-testid={`wf-category-${cat}`}
      className={focused ? "rounded-xl ring-1 ring-ring ring-offset-2 ring-offset-background" : undefined}>
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} data-testid={`wf-cat-toggle-${cat}`}
        className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg px-1 py-1.5 text-left hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <span aria-hidden className="w-3 shrink-0 text-xs text-muted-foreground">{collapsed ? "▸" : "▾"}</span>
        <span className="text-sm font-medium">{catName(cat)}</span>
        <span className="text-xs text-muted-foreground">{t("wfCatGraphs").replace("{n}", String(rows.length))} · {t("wfCatRuns30d").replace("{n}", String(runs30(rows)))}</span>
      </button>
      {collapsed ? null : (
        <div className="space-y-3 pt-1">
          {top.length ? (
            <div data-testid={`wf-top-${cat}`}>
              <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{t("wfTopTitle")}</p>
              <div className={cardsCls(view)}>
                {top.map((row) => <div key={row.id} data-testid={`wf-top-${row.id}`} className="min-w-0"><WorkflowCard row={row} locale={locale} onOpen={onOpen} /></div>)}
              </div>
            </div>
          ) : null}
          {rest.length ? (
            <div className={cardsCls(view)}>
              {rest.map((row) => <div key={row.id} className="min-w-0"><WorkflowCard row={row} locale={locale} onOpen={onOpen} /></div>)}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
