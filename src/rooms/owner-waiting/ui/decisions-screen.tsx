import type { ComponentType } from "react";
import { t, type Locale } from "@lane-pilot/i18n";
import { PageHeader, Segments, usePanelLayout } from "@lane-pilot/ui-kit";
import { useLpRpcQuery } from "../../ui-shell/ui";
import type { OwnerWaiting } from "../models/owner-item";
import { OwnerWaitingBoard } from "./owner-waiting-board";

export type DecisionsView = "waiting" | "desk" | "autonomous";

export interface DecisionsDeskProps {
  week?: string;
  onWeekChange?: (week: string | undefined) => void;
  onOpenTask?: (runId: string, taskId: string) => void;
  locale?: Locale;
}

export interface DecisionsActionsLogProps {
  projectId: string | null;
  locale?: Locale;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
}

export interface DecisionsScreenProps {
  view?: string;
  week?: string;
  onViewChange: (next: DecisionsView) => void;
  onWeekChange?: (week: string | undefined) => void;
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
  onOpenSettings?: () => void;
  ReviewDesk?: ComponentType<DecisionsDeskProps>;
  ActionsLog?: ComponentType<DecisionsActionsLogProps>;
  locale?: Locale;
  compact?: boolean;
}

/** Decisions section (P2): waiting queue, weekly review desk, and autonomous actions log. */
export function DecisionsScreen({
  view,
  week,
  onViewChange,
  onWeekChange,
  projectId,
  projects,
  onOpenTask,
  onOpenWork,
  onOpenSettings,
  ReviewDesk,
  ActionsLog,
  locale,
  compact,
}: DecisionsScreenProps) {
  const { stackControls } = usePanelLayout();
  const activeView: DecisionsView = view === "desk" || view === "autonomous" ? view : "waiting";
  const waitingQuery = useLpRpcQuery("owner_waiting", {}, { pollMs: 30_000 });
  const waiting = (waitingQuery.data ?? null) as OwnerWaiting | null;
  const waitingCount = waiting
    ? (projectId ? waiting.items.filter((item) => item.projectId === projectId && item.tier === "now").length : waiting.now)
    : undefined;

  return (
    <div className="space-y-4" data-testid="console-decisions">
      <PageHeader title={t("consoleNavDecisions")} subtitle={t("consoleDecisionsSubtitle")} />
      <Segments
        testId="decisions-view"
        label={t("consoleNavDecisions")}
        compact={compact ?? stackControls}
        value={activeView}
        onChange={(next) => onViewChange(next as DecisionsView)}
        badge={waitingCount && waitingCount > 0 ? { waiting: waitingCount } : undefined}
        items={[
          { id: "waiting", label: t("consoleDecisionsTabWaiting") },
          { id: "desk", label: t("consoleDecisionsTabDesk") },
          { id: "autonomous", label: t("consoleDecisionsTabAutonomous") },
        ]}
      />
      {activeView === "desk" ? (
        ReviewDesk ? (
          <ReviewDesk week={week} onWeekChange={onWeekChange} onOpenTask={onOpenTask} locale={locale} />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="decisions-desk-placeholder">
            {t("consoleDecisionsDeskPlaceholder")}
          </p>
        )
      ) : activeView === "autonomous" ? (
        ActionsLog ? (
          <ActionsLog
            projectId={projectId}
            locale={locale}
            onOpenTask={onOpenTask}
            onOpenWork={onOpenWork}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="decisions-autonomous-placeholder">
            {t("consoleDecisionsAutonomousPlaceholder")}
          </p>
        )
      ) : (
        <OwnerWaitingBoard
          projects={projects}
          projectId={projectId}
          onOpenTask={onOpenTask}
          onOpenWork={onOpenWork}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );
}
