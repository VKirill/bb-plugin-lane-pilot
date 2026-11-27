import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  CONTROL_H,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  Switch,
} from "@lane-pilot/ui-kit";
import type { AgentListItem, ListedProject } from "../../contracts/ui";
import { HireCustomRoleForm } from "./hire-custom-role";
import {
  intakeWorkflowIdOf,
  type WorkflowInputField,
  type WorkflowRunResult,
} from "./hire-wizard-helpers";
import { resolveRoleName } from "./staff-list-parts";

/** Right-hand preview card explaining what happens after hiring for the selected role kind. */
export function HireNextCard({ chartered }: { chartered: boolean }) {
  const steps = chartered
    ? [
        t("consoleHireNextChartered1"),
        t("consoleHireNextChartered2"),
        t("consoleHireNextChartered3"),
        t("consoleHireNextChartered4"),
        t("consoleHireNextChartered5"),
      ]
    : [
        t("consoleHireNextTask1"),
        t("consoleHireNextTask2"),
        t("consoleHireNextTask3"),
      ];

  return (
    <Surface testId="hire-next-card">
      <SurfaceHeader>
        <h2 className="text-sm font-semibold text-foreground">{t("consoleHireNextBoxTitle")}</h2>
      </SurfaceHeader>
      <SurfaceBody>
        <ol className="space-y-2.5 text-xs text-muted-foreground">
          {steps.map((line, index) => (
            <li key={line} className="flex items-start gap-2.5">
              <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--lp-well)] text-[11px] font-semibold text-foreground">
                {index + 1}
              </span>
              <span className="leading-relaxed">{line}</span>
            </li>
          ))}
        </ol>
      </SurfaceBody>
    </Surface>
  );
}

/** Step 1: Role selector grouped into "On retainer" (chartered) and "By task" + inline custom role. */
export function HireRoleStep({
  charteredAgents,
  taskAgents,
  selectedRoleId,
  locale,
  customOpen,
  customBusy,
  customError,
  existingIds,
  onSelectRole,
  onToggleCustom,
  onSaveCustom,
}: {
  charteredAgents: ReadonlyArray<AgentListItem>;
  taskAgents: ReadonlyArray<AgentListItem>;
  selectedRoleId: string | null;
  locale: Locale;
  customOpen: boolean;
  customBusy: boolean;
  customError: string | null;
  existingIds: ReadonlySet<string>;
  onSelectRole: (id: string) => void;
  onToggleCustom: (open: boolean) => void;
  onSaveCustom: (draft: { id: string; description: string; prompt: string }) => void;
}) {
  return (
    <div className="space-y-6" data-testid="hire-step-role">
      <section className="space-y-2.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("consoleHireGroupChartered")} · {t("consoleHireGroupCharteredHint")}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {charteredAgents.map((agent) => {
            const active = selectedRoleId === agent.id;
            const intakeId = intakeWorkflowIdOf(agent);
            return (
              <button
                key={agent.id}
                type="button"
                data-testid={`hire-role-${agent.id}`}
                aria-pressed={active}
                onClick={() => onSelectRole(agent.id)}
                className={`flex flex-col justify-between rounded-xl border p-4 text-left transition ${
                  active
                    ? "border-[var(--lp-accent,#2563eb)] bg-[var(--lp-card)] ring-1 ring-[var(--lp-accent,#2563eb)]"
                    : "border-[var(--lp-hairline)] bg-[var(--lp-card)] hover:border-[var(--lp-outline)]"
                }`}
              >
                <div className="flex w-full items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {resolveRoleName(agent, agent.id, locale)}
                  </span>
                  <StatusPill tone={active ? "accent" : "muted"}>
                    {active ? t("consoleHireSelected") : t("consoleHireGroupChartered")}
                  </StatusPill>
                </div>
                <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  {agent.summary || agent.description}
                </p>
                <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                  {t("consoleHireIntakeGraph").replace("{id}", intakeId)}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2.5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("consoleHireGroupTask")} · {t("consoleHireGroupTaskHint")}
        </div>
        <div className="flex flex-wrap gap-2">
          {taskAgents.map((agent) => {
            const active = selectedRoleId === agent.id;
            return (
              <Button
                key={agent.id}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                data-testid={`hire-role-${agent.id}`}
                onClick={() => onSelectRole(agent.id)}
              >
                {resolveRoleName(agent, agent.id, locale)}
              </Button>
            );
          })}
          <Button
            type="button"
            size="sm"
            variant={customOpen ? "secondary" : "outline"}
            data-testid="hire-custom-role-btn"
            onClick={() => onToggleCustom(!customOpen)}
          >
            {t("consoleHireCustomRoleBtn")}
          </Button>
        </div>

        {customOpen ? (
          <HireCustomRoleForm
            existingIds={existingIds}
            busy={customBusy}
            error={customError}
            onSave={onSaveCustom}
            onCancel={() => onToggleCustom(false)}
          />
        ) : null}
      </section>
    </div>
  );
}

/** Step 2: Project and optional section selection. */
export function HireProjectStep({
  projects,
  sections,
  selectedProjectId,
  selectedSectionId,
  onSelectProject,
  onSelectSection,
}: {
  projects: ReadonlyArray<ListedProject>;
  sections: ReadonlyArray<{ id: string; name: string; depth: number }>;
  selectedProjectId: string;
  selectedSectionId: string | null;
  onSelectProject: (id: string) => void;
  onSelectSection: (id: string | null) => void;
}) {
  return (
    <Surface testId="hire-step-project">
      <SurfaceBody className="space-y-4">
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("consoleHireNoProjects")}</p>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="hire-project-select" className="text-xs font-medium">
              {t("consoleHireProjectLabel")}
            </Label>
            <Select value={selectedProjectId} onValueChange={onSelectProject}>
              <SelectTrigger
                id="hire-project-select"
                className={`${CONTROL_H} w-full`}
                data-testid="hire-project-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem
                    key={project.id}
                    value={project.id}
                    data-testid={`hire-project-option-${project.id}`}
                  >
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="hire-section-select" className="text-xs font-medium">
            {t("consoleHireSectionLabel")}
          </Label>
          <Select
            value={selectedSectionId ?? "__whole__"}
            onValueChange={(value) => onSelectSection(value === "__whole__" ? null : value)}
          >
            <SelectTrigger
              id="hire-section-select"
              className={`${CONTROL_H} w-full`}
              data-testid="hire-section-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__whole__" data-testid="hire-section-option-whole">
                {t("consoleHireWholeProject")}
              </SelectItem>
              {sections.map((section) => (
                <SelectItem
                  key={section.id}
                  value={section.id}
                  data-testid={`hire-section-option-${section.id}`}
                >
                  {`${" ".repeat(Math.max(0, section.depth - 1))}${section.name}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SurfaceBody>
    </Surface>
  );
}

/** Step 3a: Chartered onboarding trigger with optional workflow inputs and preflight refusal details. */
export function HireIntakeStep({
  workflowId,
  projectName,
  fields,
  values,
  busy,
  refused,
  error,
  onChangeValue,
  onStart,
  onBack,
}: {
  workflowId: "mkt-project-intake" | "seo-project-intake";
  projectName: string;
  fields: ReadonlyArray<WorkflowInputField>;
  values: Record<string, string | boolean>;
  busy: boolean;
  refused: WorkflowRunResult | null;
  error: string | null;
  onChangeValue: (name: string, value: string | boolean) => void;
  onStart: () => void;
  onBack: () => void;
}) {
  const reasonKey = refused?.reason ? (`wfRunReason_${refused.reason}` as I18nKey) : null;
  const reasonLabel =
    reasonKey && t(reasonKey) !== reasonKey ? t(reasonKey) : refused?.message ?? refused?.reason ?? "";

  const issueMessages = (refused?.issues ?? []).map(
    (issue) => issue.message || `${issue.kind}: ${issue.name}`,
  );
  const missingItems = refused?.missing ?? [];
  const envItems = (refused?.envRequests ?? []).map((req) => `${req.name}: ${req.purpose}`);
  const requirementList = [...new Set([...issueMessages, ...missingItems, ...envItems])];

  return (
    <Surface testId="hire-step-intake">
      <SurfaceBody className="space-y-4">
        <p className="text-sm text-foreground">
          {t("consoleHireIntakeSummary")
            .replace("{workflow}", workflowId)
            .replace("{project}", projectName)}
        </p>

        {fields.length > 0 ? (
          <div className="space-y-3">
            {fields.map((field) => {
              const id = `hire-intake-input-${field.name}`;
              const val = values[field.name];
              return (
                <div key={field.name} className="space-y-1">
                  <Label htmlFor={id} className="text-xs font-medium">
                    {field.name}
                    {field.required ? " *" : ""}
                  </Label>
                  {field.type === "boolean" ? (
                    <div className="pt-0.5">
                      <Switch
                        id={id}
                        checked={val === true}
                        onCheckedChange={(next) => onChangeValue(field.name, next)}
                        data-testid={id}
                        aria-label={field.name}
                      />
                    </div>
                  ) : field.type === "enum" && field.values ? (
                    <Select
                      value={typeof val === "string" ? val : ""}
                      onValueChange={(next) => onChangeValue(field.name, next)}
                    >
                      <SelectTrigger id={id} className={`${CONTROL_H} w-full`} data-testid={id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {field.values.map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      id={id}
                      className={`${CONTROL_H} w-full`}
                      data-testid={id}
                      value={typeof val === "string" ? val : ""}
                      onChange={(event) => onChangeValue(field.name, event.target.value)}
                    />
                  )}
                  {field.note ? <p className="text-xs text-muted-foreground">{field.note}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}

        {refused && !refused.ok ? (
          <Alert variant="destructive" data-testid="hire-workflow-refused">
            <AlertTitle>{t("consoleHireIntakeRefusedTitle")}</AlertTitle>
            <AlertDescription className="space-y-2">
              {reasonLabel ? <p>{reasonLabel}</p> : null}
              {refused.message && refused.message !== reasonLabel ? <p>{refused.message}</p> : null}
              {requirementList.length > 0 ? (
                <ul className="list-disc space-y-1 pl-4" data-testid="hire-refusal-requirements">
                  {requirementList.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive" data-testid="hire-workflow-error">
            <AlertTitle>{t("consoleHireIntakeRefusedTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={busy}
            data-testid="hire-start-intake"
            onClick={onStart}
          >
            {busy ? t("consoleHireStartingIntake") : t("consoleHireStartIntakeBtn")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="hire-back-step2"
            onClick={onBack}
          >
            {t("consoleHireBackBtn")}
          </Button>
        </div>
      </SurfaceBody>
    </Surface>
  );
}
