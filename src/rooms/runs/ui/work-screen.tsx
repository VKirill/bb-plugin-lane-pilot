import type { ComponentType } from "react";
import { t, type Locale } from "@lane-pilot/i18n";
import { Segments } from "@lane-pilot/ui-kit";
import { BigProjects, type InputsFormView } from "./big-projects";
import { TaskBoard, type AcceptanceCardView } from "./task-board";

export type WorkView = "tasks" | "projects" | "errands";

export interface WorkScreenProps {
  view?: string;
  projectId: string | null;
  sectionId?: string | null;
  projects: Array<{ id: string; name: string }>;
  serviceProjectIds: readonly string[];
  locale: Locale;
  compact: boolean;
  AcceptanceCard: AcceptanceCardView;
  /** Injected by the page layer: `runs` must not import the `errands` or `workflow` rooms. */
  Errands: ComponentType<{ projects: Array<{ id: string; name: string }>; locale: Locale }>;
  InputsForm: InputsFormView;
  go: (next: {
    section: "work";
    view?: WorkView;
    projectId?: string;
    sectionId?: string;
    taskRef?: { runId: string; taskId: string };
  }) => void;
}

function resolveWorkView(view: string | undefined): WorkView {
  if (view === "projects" || view === "errands") return view;
  return "tasks";
}

/** P5 Work section: tasks board/list, big project workflow runs, and errands. */
export function WorkScreen({
  view,
  projectId,
  sectionId,
  projects,
  serviceProjectIds,
  locale,
  compact,
  AcceptanceCard,
  Errands,
  InputsForm,
  go,
}: WorkScreenProps) {
  const activeView = resolveWorkView(view);
  const scopedScope = {
    ...(projectId ? { projectId } : {}),
    ...(sectionId ? { sectionId } : {}),
  };

  return (
    <div className="space-y-4" data-testid="console-work">
      <Segments
        testId="work-view"
        label={t("consoleNavWork")}
        compact={compact}
        value={activeView}
        onChange={(next) =>
          go({
            section: "work",
            view: next as WorkView,
            ...scopedScope,
          })
        }
        items={[
          { id: "tasks", label: t("consoleWorkViewTasks") },
          { id: "projects", label: t("consoleWorkViewProjects") },
          { id: "errands", label: t("consoleWorkViewErrands") },
        ]}
      />
      {activeView === "projects" ? (
        <BigProjects projectId={projectId} projects={projects} locale={locale} InputsForm={InputsForm} />
      ) : activeView === "errands" ? (
        <Errands projects={projects} locale={locale} />
      ) : (
        <TaskBoard
          key={projectId ?? "all"}
          projects={projects}
          serviceProjectIds={serviceProjectIds}
          lockedProjectId={projectId}
          locale={locale}
          AcceptanceCard={AcceptanceCard}
          onOpen={(item) =>
            go({
              section: "work",
              ...scopedScope,
              taskRef: { runId: item.runId, taskId: item.taskId ?? item.runId },
            })
          }
        />
      )}
    </div>
  );
}
