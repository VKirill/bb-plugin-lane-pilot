import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  PageHeader,
  Skeleton,
} from "@lane-pilot/ui-kit";
import { toast } from "sonner";
import type { rpcContract } from "../../contracts";
import { type AgentListItem, type ListedProject } from "../../contracts/ui";
import {
  buildInitialIntakeValues,
  collectIntakeInputs,
  filterHireAgents,
  filterHireProjects,
  flattenHireSections,
  intakeWorkflowIdOf,
  isCharteredAgent,
  type HireStep,
  type SectionRow,
  type WorkflowInputField,
  type WorkflowRunResult,
} from "./hire-wizard-helpers";
import {
  HireIntakeStep,
  HireNextCard,
  HireProjectStep,
  HireRoleStep,
} from "./hire-wizard-parts";
import { errorText, resolveRoleName } from "./staff-list-parts";

export type ScheduleFormView = ComponentType<{
  projectId: string | null;
  projects: ReadonlyArray<{ id: string; name: string }>;
  hosts: Array<{ id: string; name: string; connected: boolean }>;
  initial?: {
    kind?: "workflow" | "errand" | "script" | "agent";
    agentId?: string;
    projectId?: string;
    name?: string;
    task?: string;
  };
  locale: Locale;
  onSaved: () => void;
  onCancel: () => void;
}>;

export interface HireWizardProps {
  projectId: string | null;
  sectionId?: string | null;
  projects?: ReadonlyArray<ListedProject>;
  hiddenProjectIds?: ReadonlySet<string>;
  locale?: Locale;
  ScheduleForm: ScheduleFormView;
  go: (next: {
    section: "staff" | "decisions";
    view?: string;
    projectId?: string;
    sectionId?: string;
    staffRef?: { projectId: string; domain: string };
  }) => void;
}

/** Three-step employee hire wizard (P3a): role, project/section, and intake or schedule setup. */
export function HireWizard({
  projectId,
  sectionId,
  projects: initialProjects = [],
  hiddenProjectIds,
  locale: localeProp,
  ScheduleForm,
  go,
}: HireWizardProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const scopedProjectId =
    projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  const scopedBase = useMemo(
    () => ({
      ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
      ...(sectionId ? { sectionId } : {}),
    }),
    [scopedProjectId, sectionId],
  );

  const [step, setStep] = useState<HireStep>(1);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  const [customOpen, setCustomOpen] = useState(false);
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const [projects, setProjects] = useState<ListedProject[]>(() =>
    filterHireProjects(initialProjects, hiddenProjectIds),
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string>(scopedProjectId ?? "");
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(sectionId ?? null);

  const [intakeFields, setIntakeFields] = useState<WorkflowInputField[]>([]);
  const [intakeValues, setIntakeValues] = useState<Record<string, string | boolean>>({});
  const [intakeBusy, setIntakeBusy] = useState(false);
  const [intakeRefused, setIntakeRefused] = useState<WorkflowRunResult | null>(null);
  const [intakeError, setIntakeError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setLoadingAgents(true);
    setAgentsError(null);
    try {
      const res = await rpc.call("list_agents", {});
      const list = filterHireAgents(res.agents as AgentListItem[]);
      setAgents(list);
      setSelectedRoleId((current) => {
        if (current && list.some((a) => a.id === current)) return current;
        const firstChartered = list.find(isCharteredAgent);
        return firstChartered?.id ?? list[0]?.id ?? null;
      });
    } catch (cause) {
      setAgentsError(errorText(cause));
    } finally {
      setLoadingAgents(false);
    }
  }, [rpc]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  useEffect(() => {
    let alive = true;
    void rpc
      .call("list_projects", {})
      .then((res) => {
        if (!alive) return;
        const visible = filterHireProjects(res.projects, hiddenProjectIds);
        setProjects(visible);
        setSelectedProjectId((current) => {
          if (current && visible.some((p) => p.id === current)) return current;
          if (scopedProjectId && visible.some((p) => p.id === scopedProjectId)) return scopedProjectId;
          return visible[0]?.id ?? "";
        });
      })
      .catch(() => {
        // Keep initialProjects fallback if list_projects is unavailable.
      });
    return () => {
      alive = false;
    };
  }, [rpc, scopedProjectId, hiddenProjectIds]);

  useEffect(() => {
    if (!selectedProjectId) {
      setSections([]);
      return;
    }
    let alive = true;
    void rpc
      .call("list_sections", { projectId: selectedProjectId })
      .then((res) => {
        if (!alive) return;
        setSections(res.sections);
        setSelectedSectionId((current) =>
          current && res.sections.some((item) => item.id === current) ? current : null,
        );
      })
      .catch(() => {
        if (alive) setSections([]);
      });
    return () => {
      alive = false;
    };
  }, [rpc, selectedProjectId]);

  const charteredAgents = useMemo(() => agents.filter(isCharteredAgent), [agents]);
  const taskAgents = useMemo(() => agents.filter((agent) => !isCharteredAgent(agent)), [agents]);
  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === selectedRoleId) ?? null,
    [agents, selectedRoleId],
  );
  const existingAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const flatSections = useMemo(() => flattenHireSections(sections), [sections]);
  const selectedProjectName =
    projects.find((item) => item.id === selectedProjectId)?.name ?? selectedProjectId;

  useEffect(() => {
    if (step !== 3 || !selectedAgent || !selectedProjectId || !isCharteredAgent(selectedAgent)) return;
    let alive = true;
    setIntakeRefused(null);
    setIntakeError(null);
    const wfId = intakeWorkflowIdOf(selectedAgent);
    setIntakeFields([]);
    setIntakeValues({});
    void rpc
      .call("workflow_get", { id: wfId, projectId: selectedProjectId })
      .then((res) => {
        if (!alive || !res.workflow) return;
        setIntakeFields(res.workflow.inputs);
        setIntakeValues(buildInitialIntakeValues(res.workflow.inputs));
      })
      .catch(() => {
        // Allow direct onboarding start even if workflow_get is unavailable.
      });
    return () => {
      alive = false;
    };
  }, [step, selectedAgent, selectedProjectId, rpc]);

  const handleSaveCustom = async (draft: { id: string; description: string; prompt: string }) => {
    setCustomBusy(true);
    setCustomError(null);
    try {
      const result = await rpc.call("save_agent_profile", {
        id: draft.id,
        description: draft.description,
        prompt: draft.prompt,
        expectedSourceHash: "",
        resourceModes: {
          tools: "inherit",
          disallowedTools: "inherit",
          skills: "inherit",
          mcpServers: "inherit",
        },
      });
      if (!result.ok) {
        setCustomError(t("owned03"));
        return;
      }
      const synthetic: AgentListItem = {
        id: draft.id,
        description: draft.description,
        displayName: draft.description,
        kind: "specialist",
        custom: true,
        prompt: draft.prompt,
        sourceHash: result.sourceHash,
        sourceVersion: "lp-owned-1",
        edited: true,
      };
      try {
        const refreshed = await rpc.call("list_agents", {});
        const filtered = filterHireAgents(refreshed.agents as AgentListItem[]);
        setAgents(filtered.some((item) => item.id === draft.id) ? filtered : [...filtered, synthetic]);
      } catch {
        setAgents((current) => (current.some((item) => item.id === draft.id) ? current : [...current, synthetic]));
      }
      setSelectedRoleId(draft.id);
      setCustomOpen(false);
    } catch (cause) {
      setCustomError(errorText(cause));
    } finally {
      setCustomBusy(false);
    }
  };

  const handleStartIntake = async () => {
    if (!selectedAgent || !selectedProjectId) return;
    const wfId = intakeWorkflowIdOf(selectedAgent);
    setIntakeBusy(true);
    setIntakeRefused(null);
    setIntakeError(null);
    try {
      const inputs = collectIntakeInputs(intakeFields, intakeValues);
      const result = await rpc.call("workflow_run", {
        id: wfId,
        projectId: selectedProjectId,
        inputs,
        source: "manual",
      });
      if (!result.ok) {
        setIntakeRefused(result);
        return;
      }
      toast.success(t("consoleHireIntakeStartedToast"));
      go({
        section: "decisions",
        view: "waiting",
        projectId: selectedProjectId,
        ...(selectedSectionId ? { sectionId: selectedSectionId } : {}),
      });
    } catch (cause) {
      setIntakeError(errorText(cause));
    } finally {
      setIntakeBusy(false);
    }
  };

  const stepSubtitle =
    step === 1
      ? t("consoleHireStepSub1")
      : step === 2
        ? t("consoleHireStepSub2")
        : t("consoleHireStepSub3");

  const goBackToStaff = () => go({ section: "staff", ...scopedBase });

  return (
    <div className="space-y-5" data-testid="staff-hire-wizard">
      <PageHeader
        title={t("consoleHireTitle")}
        subtitle={stepSubtitle}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="hire-back-to-staff"
            onClick={goBackToStaff}
          >
            {t("consoleStaffBackToList")}
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2" data-testid="hire-steps">
        {([
          [1, t("consoleHireStep1")],
          [2, t("consoleHireStep2")],
          [3, t("consoleHireStep3")],
        ] as const).map(([num, label]) => {
          const active = step === num;
          const reachable =
            num === 1 || (num === 2 && Boolean(selectedAgent)) || (num === 3 && Boolean(selectedAgent && selectedProjectId));
          return (
            <Button
              key={num}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              disabled={!reachable && !active}
              data-testid={`hire-step-${num}`}
              onClick={() => {
                if (reachable) setStep(num);
              }}
            >
              {label}
            </Button>
          );
        })}
      </div>

      {agentsError ? (
        <Alert variant="destructive" data-testid="hire-load-error">
          <AlertTitle>{t("consoleStaffLoadError")}</AlertTitle>
          <AlertDescription>{agentsError}</AlertDescription>
        </Alert>
      ) : null}

      {loadingAgents ? (
        <div className="space-y-3" data-testid="hire-loading">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="min-w-0 space-y-4">
            {step === 1 ? (
              <>
                <HireRoleStep
                  charteredAgents={charteredAgents}
                  taskAgents={taskAgents}
                  selectedRoleId={selectedRoleId}
                  locale={locale}
                  customOpen={customOpen}
                  customBusy={customBusy}
                  customError={customError}
                  existingIds={existingAgentIds}
                  onSelectRole={(id) => {
                    setSelectedRoleId(id);
                    setCustomOpen(false);
                  }}
                  onToggleCustom={setCustomOpen}
                  onSaveCustom={(draft) => void handleSaveCustom(draft)}
                />
                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="hire-cancel"
                    onClick={goBackToStaff}
                  >
                    {t("consoleHireCancelBtn")}
                  </Button>
                  <Button
                    type="button"
                    disabled={!selectedAgent}
                    data-testid="hire-next-project"
                    onClick={() => setStep(2)}
                  >
                    {t("consoleHireNextProjectBtn")}
                  </Button>
                </div>
              </>
            ) : null}

            {step === 2 ? (
              <>
                <HireProjectStep
                  projects={projects}
                  sections={flatSections}
                  selectedProjectId={selectedProjectId}
                  selectedSectionId={selectedSectionId}
                  onSelectProject={setSelectedProjectId}
                  onSelectSection={setSelectedSectionId}
                />
                <div className="flex flex-wrap justify-end gap-2 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="hire-back-step1"
                    onClick={() => setStep(1)}
                  >
                    {t("consoleHireBackBtn")}
                  </Button>
                  <Button
                    type="button"
                    disabled={!selectedProjectId}
                    data-testid="hire-next-start"
                    onClick={() => setStep(3)}
                  >
                    {t("consoleHireNextStartBtn")}
                  </Button>
                </div>
              </>
            ) : null}

            {step === 3 && selectedAgent ? (
              isCharteredAgent(selectedAgent) ? (
                <HireIntakeStep
                  workflowId={intakeWorkflowIdOf(selectedAgent)}
                  projectName={selectedProjectName}
                  fields={intakeFields}
                  values={intakeValues}
                  busy={intakeBusy}
                  refused={intakeRefused}
                  error={intakeError}
                  onChangeValue={(name, value) =>
                    setIntakeValues((current) => ({ ...current, [name]: value }))
                  }
                  onStart={() => void handleStartIntake()}
                  onBack={() => setStep(2)}
                />
              ) : (
                <div data-testid="hire-schedule-form-wrap">
                  <ScheduleForm
                    projectId={selectedProjectId}
                    projects={projects}
                    hosts={[]}
                    initial={{
                      kind: "agent",
                      agentId: selectedAgent.id,
                      projectId: selectedProjectId,
                      name: resolveRoleName(selectedAgent, selectedAgent.id, locale),
                    }}
                    locale={locale}
                    onSaved={() => {
                      toast.success(t("consoleHireScheduleSavedToast"));
                      goBackToStaff();
                    }}
                    onCancel={() => setStep(2)}
                  />
                </div>
              )
            ) : null}
          </div>

          <aside className="space-y-4">
            <HireNextCard chartered={selectedAgent ? isCharteredAgent(selectedAgent) : true} />
          </aside>
        </div>
      )}
    </div>
  );
}
