import type { ReactNode } from "react";
import type { z } from "zod";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Badge,
  Button,
  StatusPill,
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
  | { kind: "card"; key: string; card: MemoryCard };

export const CATEGORY_META: Record<RecordCategory, { tone: StatusPillTone; labelKey: I18nKey }> = {
  fact: { tone: "muted", labelKey: "consoleMemoryTagFact" },
  decision: { tone: "accent", labelKey: "consoleMemoryTagDecision" },
  rule: { tone: "bad", labelKey: "consoleMemoryTagRule" },
  lesson: { tone: "ok", labelKey: "consoleMemoryTagLesson" },
};

export function isRuleRecord(record: Pick<MemoryRecord, "rule" | "concepts">): boolean {
  return record.rule || record.concepts.includes("rule");
}

export function classifyRecord(record: Pick<MemoryRecord, "rule" | "concepts" | "origin">): RecordCategory {
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
    <div className="flex flex-col gap-0.5 border-b border-[var(--lp-hairline)] pb-2 last:border-b-0 last:pb-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-foreground">{children}</dd>
    </div>
  );
}

export interface MemoryDetailPaneProps {
  selectedItem: MemoryListEntry | null;
  locale: Locale;
  deletingId: string | null;
  onOpenTask?: (runId: string, taskId: string) => void;
  onRequestDelete: (record: MemoryRecord) => void;
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
              <StatusPill tone="accent">{t("consoleMemoryTagCard")}</StatusPill>
              <StatusPill tone={selectedItem.card.stale ? "warn" : "ok"}>
                {selectedItem.card.stale ? t("consoleMemoryCardStale") : t("consoleMemoryCardFresh")}
              </StatusPill>
            </div>
            <p className="text-sm font-medium leading-relaxed text-foreground" data-testid="memory-detail-text">
              {selectedItem.card.title}
            </p>
            <dl className="space-y-2">
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
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={CATEGORY_META[selectedItem.category].tone}>
                {t(CATEGORY_META[selectedItem.category].labelKey)}
              </StatusPill>
              <Badge variant={selectedItem.record.kind === "core" ? "secondary" : "outline"}>
                {selectedItem.record.kind === "core" ? t("memoryKindCore") : t("memoryKindNote")}
              </Badge>
            </div>
            <p
              className="whitespace-pre-wrap text-sm leading-relaxed text-foreground"
              style={{ overflowWrap: "anywhere" }}
              data-testid="memory-detail-text"
            >
              {selectedItem.record.content}
            </p>
            <dl className="space-y-2">
              <DetailRow label={t("consoleMemoryFieldOrigin")}>{selectedItem.record.origin}</DetailRow>
              <DetailRow label={t("consoleMemoryFieldTask")}>
                {selectedItem.record.originTaskId ? (
                  <button
                    type="button"
                    data-testid="memory-detail-task-link"
                    className="font-mono underline decoration-input underline-offset-2 hover:decoration-current"
                    onClick={() =>
                      onOpenTask?.(
                        selectedItem.record.originRunId ?? selectedItem.record.originTaskId!,
                        selectedItem.record.originTaskId!,
                      )
                    }
                  >
                    {selectedItem.record.originTaskId}
                  </button>
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
              <div className="border-t border-[var(--lp-hairline)] pt-3">
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  data-testid="memory-detail-delete"
                  disabled={deletingId === selectedItem.record.id}
                  onClick={() => onRequestDelete(selectedItem.record)}
                >
                  {t("consoleMemoryDelete")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SurfaceBody>
    </Surface>
  );
}
