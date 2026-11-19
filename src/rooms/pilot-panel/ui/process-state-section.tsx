import { Badge } from "@lane-pilot/ui-kit";
import type { PilotPanelSnapshot, PilotProcessState } from "../index";
import { PanelDisclosure, PanelSection } from "./layout";

export function PilotProcessStateSection({
  processState,
}: {
  processState: PilotProcessState | null | undefined;
}) {
  if (!processState) return null;
  const baseline = processState.approvedDesignBaseline;

  return (
    <PanelSection
      label="Состояние процесса"
      title="Состояние процесса"
      aside={
        <Badge variant="outline" className="max-w-[55%] truncate font-medium">
          {processState.stage}
        </Badge>
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5 text-xs">
        {processState.workflowId && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
            <span>Граф:</span>
            <code className="truncate text-foreground">{processState.workflowId}</code>
          </div>
        )}
        {baseline && (
          <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <span className="truncate font-medium text-foreground">
              {baseline.label ?? "Утверждённый дизайн-бейзлайн"}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
              <code className="truncate">{baseline.path}</code>
              <span className="shrink-0 tabular-nums">#{baseline.sha256.slice(0, 8)}</span>
            </span>
          </div>
        )}
        {processState.activeSkills.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1.5 pt-0.5">
            {processState.activeSkills.map((skill) => (
              <Badge key={skill} variant="secondary" className="max-w-full truncate text-[11px]">
                {skill}
              </Badge>
            ))}
          </div>
        )}
        {processState.notes && <p className="m-0 text-xs text-muted-foreground">{processState.notes}</p>}
      </div>
      {processState.rejectedVariants.length > 0 && (
        <PanelDisclosure summary={`Отклонённые варианты · ${processState.rejectedVariants.length}`}>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
            {processState.rejectedVariants.map((variant, idx) => (
              <li key={idx} className="min-w-0 break-words">
                {variant}
              </li>
            ))}
          </ul>
        </PanelDisclosure>
      )}
    </PanelSection>
  );
}

export function PilotProjectSkillsDisclosure({
  projectSkills,
}: {
  projectSkills: PilotPanelSnapshot["projectSkills"];
}) {
  if (projectSkills.items.length === 0) return null;
  return (
    <PanelDisclosure
      summary={`Скиллы в проекте (${projectSkills.rootRelPath}) · ${projectSkills.synced}/${projectSkills.total}`}
    >
      <p className="m-0 text-xs text-muted-foreground">
        Все системные скиллы лежат локально внутри репозитория в `.bb/skills/`, автоматически подхватываются BB для этого проекта и читаются чистыми субтредами с диска.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
        {projectSkills.items.map((sk) => (
          <li key={sk.name} className="flex min-w-0 items-center justify-between gap-2">
            <code className="truncate">{sk.name}</code>
            <Badge variant={sk.state === "synced" ? "secondary" : "outline"} className="shrink-0 text-[11px]">
              {sk.state === "synced" ? "актуален" : sk.state === "outdated" ? "обновить" : "отсутствует"}
            </Badge>
          </li>
        ))}
      </ul>
    </PanelDisclosure>
  );
}

export function PilotProjectSummaryCard({
  snapshot,
}: {
  snapshot: PilotPanelSnapshot;
}) {
  return (
    <PanelSection
      label="Текущий проект"
      title="Текущий проект"
      aside={
        <Badge variant="outline" className="truncate font-normal">
          {snapshot.session.serviceTierPolicy} · чистые субтреды
        </Badge>
      }
    >
      <div className="flex min-w-0 flex-col gap-1">
        <strong className="truncate text-sm font-semibold">
          {snapshot.project.name ?? snapshot.project.id ?? "Проект не выбран"}
        </strong>
        {snapshot.project.rootPath && (
          <code className="block truncate text-xs text-muted-foreground" title={snapshot.project.rootPath}>
            {snapshot.project.rootPath}
          </code>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
        {snapshot.project.gitBranch && (
          <span>
            Git <b className="font-semibold text-foreground">{snapshot.project.gitBranch}</b>
            {snapshot.project.gitDirty ? " · есть изменения" : " · чисто"}
          </span>
        )}
        <span>
          Скиллы в проекте{" "}
          <b className="font-semibold text-foreground">
            {snapshot.projectSkills.synced}/{snapshot.projectSkills.total}
          </b>
        </span>
      </div>
    </PanelSection>
  );
}
