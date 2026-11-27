import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  ConfirmDialog,
  Icon,
  Input,
  StatusPill,
  Surface,
  SurfaceBody,
} from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import {
  CATEGORY_META,
  MemoryDetailPane,
  classifyRecord,
  formatMemoryDate,
  type MemoryCard,
  type MemoryFilter,
  type MemoryListEntry,
  type MemoryRecord,
  type MemorySearchRecord,
} from "./memory-detail-pane";

export interface MemoryScreenProps {
  projectId: string;
  sectionId?: string | null;
  locale?: Locale;
  onOpenTask?: (runId: string, taskId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

function fallbackRecordFromSearch(hit: MemorySearchRecord): MemoryRecord {
  return {
    id: hit.id,
    kind: hit.kind,
    audience: "subagent",
    content: hit.content,
    concepts: hit.concepts,
    createdAt: 0,
    rule: hit.concepts.includes("rule"),
    useCount: 0,
    acceptedCount: 0,
    originTaskId: null,
    originRunId: null,
    sourceFileId: null,
    noTrace: false,
    origin: "memory",
    scope: [],
    sources: 1,
  };
}

function matchesCardQuery(card: MemoryCard, needle: string): boolean {
  const haystacks = [card.title, card.kind, card.ref ?? "", ...card.concepts];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/** P7 Memory screen: filterable records & knowledge cards, debounced search, detail pane, and confirmed delete for non-rule records. */
export function MemoryScreen({ projectId, sectionId, locale: localeProp, onOpenTask }: MemoryScreenProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [cards, setCards] = useState<MemoryCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filter, setFilter] = useState<MemoryFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState<{
    query: string;
    hits: MemorySearchRecord[];
    nothingRelevant?: boolean;
    weakMatch?: boolean;
    message?: string;
  } | null>(null);
  const [searching, setSearching] = useState(false);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MemoryRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const loadBase = useCallback(async () => {
    setLoadError(null);
    try {
      const [recordsRes, cardsRes] = await Promise.all([
        rpc.call("memory_records_list", { projectId }),
        rpc.call("memory_cards_list", { projectId }),
      ]);
      setRecords(recordsRes.records.filter((row) => !row.concepts.includes("card")));
      setCards(cardsRes.cards);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      setRecords((prev) => prev ?? []);
      setCards((prev) => prev ?? []);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  const executeSearch = useCallback(
    async (query: string) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const res = await rpc.call("session_memory_search", {
          projectId,
          query,
          ...(sectionId ? { chain: [`section:${sectionId}`] } : {}),
        });
        if (searchSeq.current !== seq) return;
        setSearchState({
          query,
          hits: res.records,
          nothingRelevant: res.nothingRelevant,
          weakMatch: res.weakMatch,
          message: res.message,
        });
      } catch (cause) {
        if (searchSeq.current !== seq) return;
        toast.error(cause instanceof Error ? cause.message : String(cause));
        setSearchState({ query, hits: [], nothingRelevant: true });
      } finally {
        if (searchSeq.current === seq) setSearching(false);
      }
    },
    [projectId, sectionId, rpc],
  );

  const trimmedQuery = searchQuery.trim();

  useEffect(() => {
    if (!trimmedQuery) {
      searchSeq.current += 1;
      setSearchState(null);
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => {
      void executeSearch(trimmedQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery, executeSearch]);

  const recordsById = useMemo(
    () => new Map((records ?? []).map((row) => [row.id, row] as const)),
    [records],
  );

  const activeRecords = useMemo<MemoryRecord[]>(() => {
    if (!trimmedQuery) return records ?? [];
    if (!searchState || searchState.query !== trimmedQuery) return records ?? [];
    return searchState.hits.map((hit) => {
      const full = recordsById.get(hit.id);
      return full ? { ...full, content: hit.content, concepts: hit.concepts } : fallbackRecordFromSearch(hit);
    });
  }, [trimmedQuery, searchState, records, recordsById]);

  const activeCards = useMemo<MemoryCard[]>(() => {
    const base = cards ?? [];
    if (!trimmedQuery) return base;
    const needle = trimmedQuery.toLowerCase();
    return base.filter((card) => matchesCardQuery(card, needle));
  }, [cards, trimmedQuery]);

  const categorizedRecords = useMemo(
    () => activeRecords.map((record) => ({ record, category: classifyRecord(record) })),
    [activeRecords],
  );

  const counts = useMemo(() => {
    let facts = 0;
    let decisions = 0;
    let rules = 0;
    let lessons = 0;
    for (const item of categorizedRecords) {
      if (item.category === "fact") facts += 1;
      else if (item.category === "decision") decisions += 1;
      else if (item.category === "rule") rules += 1;
      else lessons += 1;
    }
    const cardsCount = activeCards.length;
    return { all: categorizedRecords.length + cardsCount, facts, decisions, rules, lessons, cards: cardsCount };
  }, [categorizedRecords, activeCards]);

  const visibleItems = useMemo<MemoryListEntry[]>(() => {
    const entries: MemoryListEntry[] = [];
    if (filter !== "cards") {
      for (const { record, category } of categorizedRecords) {
        if (
          filter === "all" ||
          (filter === "facts" && category === "fact") ||
          (filter === "decisions" && category === "decision") ||
          (filter === "rules" && category === "rule") ||
          (filter === "lessons" && category === "lesson")
        ) {
          entries.push({ kind: "record", key: `rec:${record.id}`, record, category });
        }
      }
    }
    if (filter === "all" || filter === "cards") {
      for (const card of activeCards) {
        entries.push({ kind: "card", key: `card:${card.id}`, card });
      }
    }
    return entries;
  }, [filter, categorizedRecords, activeCards]);

  const selectedItem = useMemo(
    () => visibleItems.find((item) => item.key === selectedKey) ?? visibleItems[0] ?? null,
    [visibleItems, selectedKey],
  );

  const handleDeleteConfirm = async (record: MemoryRecord) => {
    setDeletingId(record.id);
    try {
      const result = await rpc.call("memory_record_delete", { projectId, id: record.id });
      if (!result.deleted) {
        toast.error(result.reason === "rule" ? t("memoryRecordIsRule") : t("memoryRecordGone"));
      } else if (result.leftovers.length) {
        toast.error(t("memoryRecordLeftovers").replace("{tables}", result.leftovers.join(", ")));
      }
      await loadBase();
      if (trimmedQuery) await executeSearch(trimmedQuery);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setDeletingId(null);
    }
  };

  const chips: Array<{ id: MemoryFilter; label: string; count: number }> = [
    { id: "all", label: t("consoleMemoryFilterAll"), count: counts.all },
    { id: "facts", label: t("consoleMemoryFilterFacts"), count: counts.facts },
    { id: "decisions", label: t("consoleMemoryFilterDecisions"), count: counts.decisions },
    { id: "rules", label: t("consoleMemoryFilterRules"), count: counts.rules },
    { id: "lessons", label: t("consoleMemoryFilterLessons"), count: counts.lessons },
    { id: "cards", label: t("consoleMemoryFilterCards"), count: counts.cards },
  ];

  const isLoading = records === null && cards === null;

  return (
    <div className="space-y-4" data-testid="memory-screen">
      {loadError ? (
        <Alert variant="destructive" data-testid="memory-load-error">
          <AlertTitle>{t("consoleMemoryLoadError")}</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 sm:max-w-sm">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("consoleMemorySearchPlaceholder")}
            aria-label={t("consoleMemorySearchPlaceholder")}
            data-testid="memory-search"
            className="pl-8"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("consoleMemoryFilterAll")}>
          {chips.map((chip) => {
            const active = filter === chip.id;
            return (
              <Button
                key={chip.id}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                data-testid={`memory-filter-${chip.id}`}
                className="h-7 rounded-full px-2.5 text-xs"
                onClick={() => setFilter(chip.id)}
              >
                <span>{chip.label}</span>
                <span className={active ? "ml-1 opacity-80 tabular-nums" : "ml-1 text-muted-foreground tabular-nums"}>
                  {chip.count}
                </span>
              </Button>
            );
          })}
        </div>
      </div>

      {trimmedQuery && searchState && searchState.query === trimmedQuery ? (
        <p className="text-xs text-muted-foreground" data-testid="memory-search-status">
          {searchState.nothingRelevant
            ? searchState.message ?? t("consoleMemorySearchEmpty")
            : searchState.weakMatch && searchState.message
              ? searchState.message
              : t("consoleMemorySearchHint").replace("{query}", trimmedQuery)}
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="memory-loading">
          {t("consoleMemoryLoading")}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Surface testId="memory-list">
            <SurfaceBody className="divide-y divide-[var(--lp-hairline)] p-0">
              {searching && visibleItems.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t("consoleMemoryLoading")}</p>
              ) : visibleItems.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground" data-testid="memory-empty">
                  {trimmedQuery ? t("consoleMemorySearchEmpty") : t("memoryRecordsEmpty")}
                </p>
              ) : (
                visibleItems.map((item) => {
                  const selected = selectedItem?.key === item.key;
                  if (item.kind === "card") {
                    const { card } = item;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        aria-selected={selected}
                        data-testid={`memory-card-${card.id.slice(0, 12)}`}
                        onClick={() => setSelectedKey(item.key)}
                        className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-state-hover ${
                          selected ? "bg-accent/50" : ""
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusPill tone="accent">{t("consoleMemoryTagCard")}</StatusPill>
                          <Badge variant="outline">{card.kind}</Badge>
                          {card.stale ? (
                            <span data-testid={`memory-card-stale-${card.id.slice(0, 12)}`}>
                              <StatusPill tone="warn">{t("consoleMemoryCardStale")}</StatusPill>
                            </span>
                          ) : null}
                          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                            v{card.version}
                          </span>
                        </div>
                        <p className="text-sm font-medium text-foreground">{card.title}</p>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          {card.verifiedAt ? <span>{formatMemoryDate(card.verifiedAt, locale)}</span> : null}
                          {card.ref ? <span className="truncate">{card.ref}</span> : null}
                        </div>
                      </button>
                    );
                  }
                  const { record, category } = item;
                  const meta = CATEGORY_META[category];
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-selected={selected}
                      data-testid={`memory-item-${record.id.slice(0, 12)}`}
                      onClick={() => setSelectedKey(item.key)}
                      className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-state-hover ${
                        selected ? "bg-accent/50" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={meta.tone}>{t(meta.labelKey)}</StatusPill>
                        {record.sources > 1 ? (
                          <Badge variant="outline">
                            {t("memorySources").replace("{n}", String(record.sources))}
                          </Badge>
                        ) : null}
                        {record.noTrace ? <Badge variant="outline">{t("memoryRecordNoTrace")}</Badge> : null}
                      </div>
                      <p className="line-clamp-2 text-sm text-foreground" style={{ overflowWrap: "anywhere" }}>
                        {record.content}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span>{record.origin}</span>
                        {record.createdAt > 0 ? <span>· {formatMemoryDate(record.createdAt, locale)}</span> : null}
                        {record.useCount > 0 ? (
                          <span>
                            · {t("consoleMemoryFieldUses")}: {record.useCount}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              )}
            </SurfaceBody>
          </Surface>

          <MemoryDetailPane
            selectedItem={selectedItem}
            locale={locale}
            deletingId={deletingId}
            onOpenTask={onOpenTask}
            onRequestDelete={(record) => setPendingDelete(record)}
          />
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("consoleMemoryConfirmDeleteTitle")}
        body={
          pendingDelete ? (
            <div className="space-y-2">
              <p>{t("consoleMemoryConfirmDeleteBody")}</p>
              <p className="rounded border border-border bg-muted/40 p-2 text-xs text-foreground">
                {pendingDelete.content}
              </p>
            </div>
          ) : undefined
        }
        confirmLabel={t("consoleMemoryDelete")}
        cancelLabel={t("cancel")}
        tone="danger"
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={async () => {
          if (pendingDelete) await handleDeleteConfirm(pendingDelete);
        }}
      />
    </div>
  );
}
