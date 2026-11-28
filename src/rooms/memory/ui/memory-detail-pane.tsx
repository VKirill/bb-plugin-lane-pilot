import type { ReactNode } from "react";
import type { z } from "zod";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Button,
  Surface,
  SurfaceBody,
  type StatusPillTone,
} from "@lane-pilot/ui-kit";
import type { MemoryCardsListOutput, rpcContract } from "../../contracts";

export type MemoryRecord = z.infer<(typeof rpcContract)["memory_records_list"]["output"]>["records"][number];
export type MemorySearchRecord = z.infer<(typeof rpcContract)["session_memory_search"]["output"]>["records"][number];
export type MemoryCard = MemoryCardsListOutput["cards"][number];

export type MemoryFilter = "all" | "facts" | "decisions" | "rules" | "lessons" | "cards";
export type RecordCategory = "fact" | "decision" | "rule" | "lesson";

export type MemoryListEntry =
  | { kind: "record"; key: string; record: MemoryRecord; category: RecordCategory }
  /** A search hit absent from the loaded list: only the fields the search returns are known. */
  | { kind: "hit"; key: string; hit: MemorySearchRecord; category: RecordCategory }
  | { kind: "card"; key: string; card: MemoryCard };

export const CATEGORY_META: Record<RecordCategory, { tone: StatusPillTone; labelKey: I18nKey }> = {
  fact: { tone: "muted", labelKey: "consoleMemoryTagFact" },
  decision: { tone: "accent", labelKey: "consoleMemoryTagDecision" },
  rule: { tone: "bad", labelKey: "consoleMemoryTagRule" },
  lesson: { tone: "ok", labelKey: "consoleMemoryTagLesson" },
};

export function isRuleRecord(record: { rule?: boolean; concepts: string[] }): boolean {
  return record.rule === true || record.concepts.includes("rule");
}

export function classifyRecord(record: { rule?: boolean; concepts: string[]; origin?: string }): RecordCategory {
  if (isRuleRecord(record)) return "rule";
  if (record.concepts.includes("lesson") || record.origin === "lesson" || record.origin === "lessons") return "lesson";
  if (record.concepts.includes("decision") || record.origin === "decision") return "decision";
  return "fact";
}

export function formatMemoryDate(ms: number, locale: Locale): string {
  return new Date(ms).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] text-[var(--lp-muted)]">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-[12.5px] text-[var(--lp-ink)]">{children}</dd>
    </div>
  );
}

function DeleteRow({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <div className="border-t border-[var(--lp-hairline)] pt-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="text-[var(--lp-bad)]"
        data-testid="memory-detail-delete"
        disabled={disabled}
        onClick={onClick}
      >
        {t("consoleMemoryDelete")}
      </Button>
    </div>
  );
}

export interface MemoryDetailPaneProps {
  selectedItem: MemoryListEntry | null;
  locale: Locale;
  deletingId: string | null;
  onOpenTask?: (runId: string, taskId: string) => void;
  onRequestDelete: (record: Pick<MemoryRecord, "id" | "content">) => void;
}

/** Right-hand detail pane for the selected memory record or knowledge card. */
export function MemoryDetailPane({
  selectedItem,
  locale,
  deletingId,
  onOpenTask,
  onRequestDelete,
}: MemoryDetailPaneProps) {
  return (
    <Surface testId="memory-detail">
      <SurfaceBody className="space-y-4">
        {!selectedItem ? (
          <p className="text-sm text-muted-foreground" data-testid="memory-detail-empty">
            {t("consoleMemoryDetailEmpty")}
          </p>
        ) : selectedItem.kind === "card" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="lp-wm-type" data-tone="warn">{t("consoleMemoryTagCard")}</span>
              <span className="lp-wm-type" data-tone={selectedItem.card.stale ? "warn" : "ok"}>
                {selectedItem.card.stale ? t("consoleMemoryCardStale") : t("consoleMemoryCardFresh")}
              </span>
            </div>
            <p className="text-[15px] font-semibold leading-snug text-[var(--lp-ink)]" data-testid="memory-detail-text">
              {selectedItem.card.title}
            </p>
            <dl className="space-y-3">
              <DetailRow label={t("consoleMemoryFieldKind")}>{selectedItem.card.kind}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldVersion")}>v{selectedItem.card.version}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldVerifiedAt")}>
                {selectedItem.card.verifiedAt ? formatMemoryDate(selectedItem.card.verifiedAt, locale) : "—"}
              </DetailRow>
              <DetailRow label={t("consoleMemoryFieldTtl")}>
                {selectedItem.card.ttlDays !== null
                  ? t("consoleMemoryTtlDays").replace("{n}", String(selectedItem.card.ttlDays))
                  : "—"}
              </DetailRow>
              <DetailRow label={t("consoleMemoryFieldRef")}>{selectedItem.card.ref ?? "—"}</DetailRow>
              {selectedItem.card.concepts.length > 0 ? (
                <DetailRow label={t("consoleMemoryFieldConcepts")}>
                  {selectedItem.card.concepts.join(" · ")}
                </DetailRow>
              ) : null}
            </dl>
          </>
        ) : selectedItem.kind === "hit" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="lp-wm-type" data-tone={CATEGORY_META[selectedItem.category].tone}>
                {t(CATEGORY_META[selectedItem.category].labelKey)}
              </span>
              <span className="lp-wm-type" data-tone={selectedItem.hit.kind === "core" ? "accent" : "muted"}>
                {selectedItem.hit.kind === "core" ? t("memoryKindCore") : t("memoryKindNote")}
              </span>
            </div>
            <p
              className="whitespace-pre-wrap text-[13px] font-medium leading-snug text-[var(--lp-ink)]"
              style={{ overflowWrap: "anywhere" }}
              data-testid="memory-detail-text"
            >
              {selectedItem.hit.content}
            </p>
            {selectedItem.hit.concepts.length > 0 ? (
              <dl className="space-y-3">
                <DetailRow label={t("consoleMemoryFieldConcepts")}>{selectedItem.hit.concepts.join(" · ")}</DetailRow>
              </dl>
            ) : null}
            {!isRuleRecord(selectedItem.hit) ? (
              <DeleteRow disabled={deletingId === selectedItem.hit.id} onClick={() => onRequestDelete(selectedItem.hit)} />
            ) : null}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="lp-wm-type" data-tone={CATEGORY_META[selectedItem.category].tone}>
                {t(CATEGORY_META[selectedItem.category].labelKey)}
              </span>
              <span className="lp-wm-type" data-tone={selectedItem.record.kind === "core" ? "accent" : "muted"}>
                {selectedItem.record.kind === "core" ? t("memoryKindCore") : t("memoryKindNote")}
              </span>
            </div>
            <p
              className={`whitespace-pre-wrap leading-snug text-[var(--lp-ink)] ${selectedItem.record.content.length > 160 ? "text-[13px] font-medium" : "text-[15px] font-semibold"}`}
              style={{ overflowWrap: "anywhere" }}
              data-testid="memory-detail-text"
            >
              {selectedItem.record.content}
            </p>
            <dl className="space-y-3">
              <DetailRow label={t("consoleMemoryFieldOrigin")}>{selectedItem.record.origin}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldTask")}>
                {selectedItem.record.originTaskId && selectedItem.record.originRunId ? (
                  <button
                    type="button"
                    data-testid="memory-detail-task-link"
                    className="font-mono underline decoration-input underline-offset-2 hover:decoration-current"
                    onClick={() =>
                      onOpenTask?.(selectedItem.record.originRunId!, selectedItem.record.originTaskId!)
                    }
                  >
                    {selectedItem.record.originTaskId}
                  </button>
                ) : selectedItem.record.originTaskId ? (
                  // The task route needs its run; without one the id is shown, not linked.
                  <span className="font-mono">{selectedItem.record.originTaskId}</span>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label={t("consoleMemoryFieldSources")}>{selectedItem.record.sources}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldScope")}>
                {selectedItem.record.scope.length
                  ? selectedItem.record.scope.join(" / ")
                  : t("consoleMemoryScopeProject")}
              </DetailRow>
              <DetailRow label={t("consoleMemoryFieldUses")}>{selectedItem.record.useCount}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldAccepted")}>{selectedItem.record.acceptedCount}</DetailRow>
              {selectedItem.record.concepts.length > 0 ? (
                <DetailRow label={t("consoleMemoryFieldConcepts")}>
                  {selectedItem.record.concepts.join(" · ")}
                </DetailRow>
              ) : null}
            </dl>
            {!isRuleRecord(selectedItem.record) ? (
              <DeleteRow disabled={deletingId === selectedItem.record.id} onClick={() => onRequestDelete(selectedItem.record)} />
            ) : null}
          </>
        )}
      </SurfaceBody>
    </Surface>
  );
}
