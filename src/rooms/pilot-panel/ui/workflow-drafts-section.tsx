import { Badge, Button } from "@lane-pilot/ui-kit";
import type { PilotWorkflowDraftItem, PilotWorkflowEvolution } from "../index";
import { PanelSection } from "./layout";

function statusLabel(item: PilotWorkflowDraftItem): string {
  if (item.status === "published") return "опубликован";
  if (item.status === "tested") return item.testedGreen ? "тесты зелёные" : "тесты не пройдены";
  return "черновик";
}

function versionBadgeText(item: PilotWorkflowDraftItem): string {
  if (item.status === "published" && item.canRollback && item.publishedVersion && item.publishedVersion > 1) {
    return `v${item.publishedVersion - 1} → v${item.publishedVersion}`;
  }
  if (item.status === "published" && item.publishedVersion !== null && item.version > item.publishedVersion) {
    return `v${item.publishedVersion} → v${item.version}`;
  }
  return `v${item.publishedVersion ?? item.version}`;
}

export function PilotWorkflowDraftsSection({
  evolution,
  busy,
  onPublish,
  onRollback,
}: {
  evolution: PilotWorkflowEvolution | undefined;
  busy: boolean;
  onPublish: (draftId: string) => void;
  onRollback: (draftId: string) => void;
}) {
  if (!evolution || evolution.items.length === 0) return null;

  return (
    <PanelSection
      label="Эволюция графов"
      title="Эволюция графов"
      aside={
        <div className="flex flex-wrap items-center gap-1.5">
          {evolution.pendingApprovalCount > 0 && (
            <Badge variant="outline" className="text-[11px]">
              Ждут публикации: {evolution.pendingApprovalCount}
            </Badge>
          )}
          {evolution.autoPublishedCount > 0 && (
            <Badge variant="secondary" className="text-[11px]">
              Автообновлено: {evolution.autoPublishedCount}
            </Badge>
          )}
        </div>
      }
    >
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0" data-testid="pilot-workflow-drafts-list">
        {evolution.items.map((item) => (
          <li
            key={item.draftId}
            className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/30 p-3"
            data-testid={`pilot-workflow-draft-${item.workflowId}`}
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <strong className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{item.title}</strong>
              <Badge variant={item.status === "published" ? "secondary" : "outline"} className="shrink-0 text-[11px]">
                {versionBadgeText(item)} · {statusLabel(item)}
              </Badge>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <code className="truncate">{item.workflowId}</code>
              <span>{item.scope === "global" ? "глобальный" : "проектный"}</span>
            </div>
            <p className="m-0 text-xs text-muted-foreground">{item.summary}</p>
            {(item.canPublish || item.canRollback) && (
              <div className="flex min-w-0 flex-wrap gap-2 pt-0.5">
                {item.canPublish && (
                  <Button type="button" size="sm" disabled={busy} onClick={() => onPublish(item.draftId)}>
                    Опубликовать граф
                  </Button>
                )}
                {item.canRollback && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onRollback(item.draftId)}
                  >
                    Откатить версию
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </PanelSection>
  );
}
