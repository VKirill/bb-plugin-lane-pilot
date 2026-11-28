import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  ConfirmDialog,
  Icon,
  Input,
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
  initialRecordId?: string | null;
  onOpenTask?: (runId: string, taskId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
type RecordEntry = Exclude<MemoryListEntry, { kind: "card" }>;
/** Records listed before «Show more»: a project keeps hundreds, and the owner reads the newest first. */
const RECORDS_PAGE = 25;

function matchesCardQuery(card: MemoryCard, needle: string): boolean {
  const haystacks = [card.title, card.kind, card.ref ?? "", ...card.concepts];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

/** P7 Memory screen: filterable records & knowledge cards, debounced search, detail pane, and confirmed delete for non-rule records. */
export function MemoryScreen({ projectId, sectionId, locale: localeProp, initialRecordId, onOpenTask }: MemoryScreenProps) {
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

  const [selectedKey, setSelectedKey] = useState<string | null>(initialRecordId ? `rec:${initialRecordId}` : null);
  const [pendingDelete, setPendingDelete] = useState<Pick<MemoryRecord, "id" | "content"> | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [shown, setShown] = useState(RECORDS_PAGE);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (initialRecordId) setSelectedKey(`rec:${initialRecordId}`);
  }, [initialRecordId]);

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

  const recordEntries = useMemo<RecordEntry[]>(() => {
    const fromRecord = (record: MemoryRecord): RecordEntry =>
      ({ kind: "record", key: `rec:${record.id}`, record, category: classifyRecord(record) });
    if (!trimmedQuery || !searchState || searchState.query !== trimmedQuery) return (records ?? []).map(fromRecord);
    return searchState.hits.map((hit) => {
      const full = recordsById.get(hit.id);
      return full
        ? fromRecord({ ...full, content: hit.content, concepts: hit.concepts })
        : { kind: "hit", key: `rec:${hit.id}`, hit, category: classifyRecord(hit) };
    });
  }, [trimmedQuery, searchState, records, recordsById]);

  const activeCards = useMemo<MemoryCard[]>(() => {
    const base = cards ?? [];
    if (!trimmedQuery) return base;
    const needle = trimmedQuery.toLowerCase();
    return base.filter((card) => matchesCardQuery(card, needle));
  }, [cards, trimmedQuery]);

  const counts = useMemo(() => {
    let facts = 0;
    let decisions = 0;
    let rules = 0;
    let lessons = 0;
    for (const item of recordEntries) {
      if (item.category === "fact") facts += 1;
      else if (item.category === "decision") decisions += 1;
      else if (item.category === "rule") rules += 1;
      else lessons += 1;
    }
    const cardsCount = activeCards.length;
    return { all: recordEntries.length + cardsCount, facts, decisions, rules, lessons, cards: cardsCount };
  }, [recordEntries, activeCards]);

  const visibleItems = useMemo<MemoryListEntry[]>(() => {
    const entries: MemoryListEntry[] = [];
    if (filter !== "cards") {
      for (const entry of recordEntries) {
        const { category } = entry;
        if (
          filter === "all" ||
          (filter === "facts" && category === "fact") ||
          (filter === "decisions" && category === "decision") ||
          (filter === "rules" && category === "rule") ||
          (filter === "lessons" && category === "lesson")
        ) {
          entries.push(entry);
        }
      }
    }
    if (filter === "all" || filter === "cards") {
      for (const card of activeCards) {
        entries.push({ kind: "card", key: `card:${card.id}`, card });
      }
    }
    return entries;
  }, [filter, recordEntries, activeCards]);

  useEffect(() => {
    setShown(RECORDS_PAGE);
  }, [filter, trimmedQuery]);

  const selectedItem = useMemo(
    () => visibleItems.find((item) => item.key === selectedKey) ?? visibleItems[0] ?? null,
    [visibleItems, selectedKey],
  );

  const handleDeleteConfirm = async (record: Pick<MemoryRecord, "id">) => {
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

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="lp-wm-search">
          <Icon name="Search" className="pointer-events-none size-[15px] shrink-0 text-[var(--lp-muted)]" aria-hidden />
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("consoleMemorySearchPlaceholder")}
            aria-label={t("consoleMemorySearchPlaceholder")}
            data-testid="memory-search"
            className="h-auto border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("consoleMemoryFilterAll")}>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={filter === chip.id}
              data-testid={`memory-filter-${chip.id}`}
              className="lp-wm-chip"
              onClick={() => setFilter(chip.id)}
            >
              <span>{chip.label}</span>
              <span>{chip.count}</span>
            </button>
          ))}
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
        <div className="grid items-start gap-[18px] lg:grid-cols-[minmax(0,1fr)_360px]">
          <Surface testId="memory-list" className="overflow-hidden">
            <SurfaceBody className="space-y-0 p-0">
              {searching && visibleItems.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">{t("consoleMemoryLoading")}</p>
              ) : visibleItems.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground" data-testid="memory-empty">
                  {trimmedQuery ? t("consoleMemorySearchEmpty") : t("memoryRecordsEmpty")}
                </p>
              ) : (
                visibleItems.slice(0, shown).map((item) => {
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
                        className="lp-wm-rec"
                      >
                        <span className="lp-wm-type" data-tone="warn">{t("consoleMemoryTagCard")}</span>
                        <span className="min-w-0 space-y-1">
                          <span className="lp-wm-rec-text">{card.title}</span>
                          <span className="lp-wm-rec-meta">
                            <span>{card.kind}</span>
                            <span>v{card.version}</span>
                            {card.verifiedAt ? <span>{formatMemoryDate(card.verifiedAt, locale)}</span> : null}
                            {card.ref ? <span className="truncate">{card.ref}</span> : null}
                            {card.stale ? (
                              <span className="font-semibold text-[var(--lp-warn)]" data-testid={`memory-card-stale-${card.id.slice(0, 12)}`}>
                                {t("consoleMemoryCardStale")}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    );
                  }
                  const meta = CATEGORY_META[item.category];
                  const { id, content } = item.kind === "record" ? item.record : item.hit;
                  const record = item.kind === "record" ? item.record : null;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-selected={selected}
                      data-testid={`memory-item-${id.slice(0, 12)}`}
                      onClick={() => setSelectedKey(item.key)}
                      className="lp-wm-rec"
                    >
                      <span className="lp-wm-type" data-tone={meta.tone}>{t(meta.labelKey)}</span>
                      <span className="min-w-0 space-y-1">
                        <span className="lp-wm-rec-text lp-wm-rec-clamp" style={{ overflowWrap: "anywhere" }}>{content}</span>
                        {record ? <span className="lp-wm-rec-meta">
                          <span>{record.origin}</span>
                          {record.createdAt > 0 ? <span>{formatMemoryDate(record.createdAt, locale)}</span> : null}
                          {record.useCount > 0 ? <span>{t("consoleMemoryFieldUses")}: {record.useCount}</span> : null}
                          {record.sources > 1 ? <span>{t("memorySources").replace("{n}", String(record.sources))}</span> : null}
                          {record.noTrace ? <span>{t("memoryRecordNoTrace")}</span> : null}
                        </span> : null}
                      </span>
                    </button>
                  );
                })
              )}
              {visibleItems.length > shown ? (
                <div className="p-3">
                  <button type="button" className="lp-wm-more" data-testid="memory-more" onClick={() => setShown((n) => n + RECORDS_PAGE)}>
                    {t("consoleShowMore").replace("{n}", String(visibleItems.length - shown))}
                  </button>
                </div>
              ) : null}
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
