import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as BbIcon,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalThreadTabProps,
} from "@get-bb/plugin-sdk/app";
import { Badge, Button, cn } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "../../ui-shell/ui";
import type {
  PilotDelegationChoice,
  PilotPanelAction,
  PilotPanelSnapshot,
  pilotPanelRpcMethods,
} from "../index";
import { PilotDelegationSection } from "./delegation-section";
import { PanelCallout, PanelDisclosure, PanelSection, StatusDot } from "./layout";
import { PilotReadinessSection } from "./readiness-section";

export const PILOT_THREAD_TAB_ID = "pilot-panel";

function stateSummaryText(snapshot: PilotPanelSnapshot, busy: boolean): string {
  if (snapshot.session.pendingQuestions && snapshot.session.pendingQuestions > 0) {
    return `ожидает ответа: ${snapshot.session.pendingQuestions}`;
  }
  if (busy) return "агент работает";
  if (snapshot.session.threadState === "error") return "ошибка выполнения";
  return "агент свободен";
}

export function PilotThreadPanel({
  threadId,
  environment,
}: Pick<ExperimentalThreadTabProps, "threadId"> & { environment?: { id?: string | null } | null }) {
  const rpc = useRpc<typeof pilotPanelRpcMethods>();
  const navigate = useBbNavigate();
  const [targetPlan, setTargetPlan] = useState<string | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<PilotPanelSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const sendingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    setTargetPlan(undefined);
    setSnapshot(null);
    setNotice("");
    setError("");
  }, [threadId]);

  const refresh = useCallback(
    async (force = false, explicitPlan?: string) => {
      const id = ++seqRef.current;
      try {
        const next = await rpc.call("pilot_panel_status", {
          threadId,
          ...(explicitPlan !== undefined ? { targetPlan: explicitPlan } : targetPlan !== undefined ? { targetPlan } : {}),
          ...(force ? { force: true } : {}),
        });
        if (mountedRef.current && id === seqRef.current) {
          setSnapshot(next);
          setError("");
        }
      } catch (cause) {
        if (mountedRef.current && id === seqRef.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (mountedRef.current && id === seqRef.current) setLoading(false);
      }
    },
    [rpc, threadId, targetPlan],
  );

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useLpRealtime(snapshot?.project.id ?? null, ["helpers", "rules", "workflow"], () => {
    void refresh();
  });

  useRealtime("pilot-panel-changed", (payload: unknown) => {
    if ((payload as { threadId?: string } | null)?.threadId === threadId) {
      void refresh();
    }
  });

  async function handleRunAction(action: PilotPanelAction) {
    if (!snapshot || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const res = await rpc.call("pilot_panel_run_action", {
        threadId,
        actionId: action.id,
        ...(snapshot.plans.selected ? { targetPlan: snapshot.plans.selected.path } : {}),
        fingerprint: snapshot.fingerprint,
        requestId: crypto.randomUUID(),
      });
      if (mountedRef.current) {
        setNotice(res.message);
        if (res.threadId && res.threadId !== threadId) {
          navigate.toThread(res.threadId);
        }
      }
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) {
        setSending(false);
        void refresh(true);
      }
    }
  }

  async function handleToggleSkip(stepId: "quality" | "ci", skipped: boolean) {
    setError("");
    try {
      await rpc.call("pilot_panel_set_readiness_skip", { threadId, stepId, skipped });
      await refresh(true);
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleSaveDelegation(choice: PilotDelegationChoice) {
    await rpc.call("pilot_panel_set_delegation", { threadId, choice });
    setNotice("Настройки делегирования и .agents/pilot/config.json сохранены.");
    await refresh(true);
  }

  const busy = Boolean(snapshot && !["idle", "error", "stopped", "completed", "archived"].includes(snapshot.session.threadState));
  const awaitingAnswer = Boolean(snapshot?.session.pendingQuestions && snapshot.session.pendingQuestions > 0);
  const selectedPlan = snapshot?.plans.selected ?? null;
  const planDoneCount = selectedPlan ? selectedPlan.tasks.filter((t) => t.state === "done").length : 0;
  const planPct = selectedPlan && selectedPlan.tasks.length > 0 ? Math.round((planDoneCount / selectedPlan.tasks.length) * 100) : 0;
  const nextActions = snapshot?.actions.filter((a) => a.group === "next") ?? [];
  const maintenanceActions = snapshot?.actions.filter((a) => a.group === "maintenance") ?? [];
  const primaryActionId = nextActions.find((a) => a.available)?.id ?? maintenanceActions.find((a) => a.available)?.id;

  return (
    <div
      className="h-full min-h-0 overflow-y-auto overscroll-contain p-4 pb-8 text-sm text-foreground [overflow-wrap:anywhere]"
      data-bb-plugin="lane-pilot"
      data-testid="pilot-thread-panel"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <header className="sticky -top-4 z-10 -mx-4 -mt-4 flex min-h-11 items-center gap-2 border-b border-border bg-background/90 px-4 py-2.5 backdrop-blur">
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <BbIcon name="Compass" className="size-3.5" />
          </span>
          <strong className="text-base font-semibold tracking-tight whitespace-nowrap">Lane Pilot</strong>
          {snapshot && (
            <Badge variant="secondary" className="truncate font-medium">
              v{snapshot.pluginVersion}
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-1">
            <span className="inline-flex" title="Открыть полный Cockpit Lane Pilot">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => navigate.toPluginPanel("lane-pilot-cockpit")}
              >
                Cockpit
              </Button>
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="Обновить панель Lane Pilot"
              onClick={() => void refresh(true)}
            >
              <BbIcon name="RotateCcw" className="size-4" />
            </Button>
          </span>
        </header>

        {loading && !snapshot && (
          <div role="status" aria-label="Читаю состояние проекта…" className="h-24 animate-pulse rounded-lg bg-muted" />
        )}
        {error && <PanelCallout tone="error" role="alert">{error}</PanelCallout>}
        {notice && <PanelCallout role="status">{notice}</PanelCallout>}

        {snapshot && (
          <>
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

            <PilotReadinessSection
              snapshot={snapshot}
              awaitingAnswer={awaitingAnswer}
              sending={sending}
              onRunAction={(action) => void handleRunAction(action)}
              onToggleSkip={handleToggleSkip}
            />

            <PanelSection label="Текущая сессия и задачи" title="Сейчас в сессии">
              <p className="m-0 flex flex-wrap items-center gap-2">
                <StatusDot tone={busy ? "live" : snapshot.session.threadState === "error" ? "error" : "idle"} />
                <span className="font-medium">
                  {snapshot.session.role === "pm"
                    ? "PM-координатор"
                    : snapshot.session.role === "writer"
                      ? "Дорожка писателя"
                      : "Рабочий чат"}
                  <span className="font-normal text-muted-foreground"> · {stateSummaryText(snapshot, busy)}</span>
                </span>
              </p>

              {snapshot.session.activeRun && (
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                  <span className="min-w-0 truncate">
                    Активный ран: <b className="font-medium">{snapshot.session.activeRun.runId}</b> · {snapshot.session.activeRun.state}
                  </span>
                  {snapshot.session.activeRun.pmThreadId && snapshot.session.activeRun.pmThreadId !== threadId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => navigate.toThread(snapshot.session.activeRun!.pmThreadId!)}
                    >
                      К PM-чату
                    </Button>
                  )}
                </div>
              )}

              {snapshot.session.runItems.length > 0 && (
                <PanelDisclosure
                  summary={`Задачи конвейера · ${snapshot.session.runItems.filter((i) => i.column === "done").length}/${snapshot.session.runItems.length}`}
                  defaultOpen
                >
                  <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                    {snapshot.session.runItems.map((item) => (
                      <li key={item.key} className="flex min-w-0 items-center gap-2 text-xs">
                        <StatusDot
                          tone={
                            item.column === "done"
                              ? "done"
                              : item.column === "blocked"
                                ? "error"
                                : item.column === "running" || item.column === "checking"
                                  ? "live"
                                  : "idle"
                          }
                        />
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{item.phase}</span>
                        {item.threadId && (
                          <button
                            type="button"
                            className="shrink-0 rounded px-1 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => navigate.toThread(item.threadId!, { split: true })}
                            title="Открыть тред задачи"
                          >
                            ↗
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </PanelDisclosure>
              )}

              {snapshot.plans.candidates.length > 0 && (
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  План проекта (`.agents/pilot/plans/`)
                  <select
                    aria-label="Выбранный план проекта"
                    value={selectedPlan?.path ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      setTargetPlan(val);
                      void refresh(false, val);
                    }}
                    className="h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {!selectedPlan && <option value="">Выберите план</option>}
                    {snapshot.plans.candidates.map((cand) => (
                      <option key={cand.path} value={cand.path}>
                        {cand.title} ({cand.done}/{cand.total})
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selectedPlan && (
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <strong className="min-w-0 truncate font-medium">{selectedPlan.title}</strong>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {planDoneCount}/{selectedPlan.tasks.length} задач
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuenow={planPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div className="h-full bg-primary transition-all" style={{ width: `${planPct}%` }} />
                  </div>
                  <PanelDisclosure summary="Задачи плана">
                    {selectedPlan.tasks.length > 0 ? (
                      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                        {selectedPlan.tasks.map((task) => (
                          <li key={task.id} className="grid grid-cols-[16px_minmax(0,1fr)] gap-2 text-xs">
                            <BbIcon
                              name={
                                task.state === "done"
                                  ? "CircleCheck"
                                  : task.state === "in_progress"
                                    ? "Clock"
                                    : task.state === "failed"
                                      ? "CircleAlert"
                                      : "Circle"
                              }
                              className={cn(
                                "mt-px size-4",
                                task.state === "done"
                                  ? "text-primary"
                                  : task.state === "failed"
                                    ? "text-destructive"
                                    : "text-muted-foreground",
                              )}
                            />
                            <span className={cn("min-w-0", task.state === "done" && "text-muted-foreground")}>
                              {task.title}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="m-0 text-xs text-muted-foreground">Чекбоксы задач в файле плана пока не добавлены.</p>
                    )}
                  </PanelDisclosure>
                </div>
              )}

              {nextActions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {nextActions.map((action) => (
                    <span key={action.id} className="inline-flex" title={`${action.reason}\n${action.command}`}>
                      <Button
                        type="button"
                        size="sm"
                        variant={action.id === primaryActionId ? "default" : "outline"}
                        disabled={sending || awaitingAnswer || !action.available}
                        onClick={() => void handleRunAction(action)}
                      >
                        {action.label}
                      </Button>
                    </span>
                  ))}
                </div>
              )}

              {maintenanceActions.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {maintenanceActions.map((action) => {
                    const direct = action.id === "prepare-project" || action.id === "activate-pilot";
                    return (
                      <span key={action.id} className="inline-flex" title={action.reason}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={sending || (!direct && awaitingAnswer) || !action.available}
                          onClick={() => void handleRunAction(action)}
                        >
                          {action.label}
                        </Button>
                      </span>
                    );
                  })}
                </div>
              )}
            </PanelSection>

            <PilotDelegationSection
              view={snapshot.delegation}
              environmentId={environment?.id ?? snapshot.project.environmentId}
              hostId={snapshot.project.hostId}
              busy={busy}
              hasWorkspace={Boolean(snapshot.project.rootPath)}
              onSave={handleSaveDelegation}
            />

            {snapshot.projectSkills.items.length > 0 && (
              <PanelDisclosure
                summary={`Скиллы в проекте (${snapshot.projectSkills.rootRelPath}) · ${snapshot.projectSkills.synced}/${snapshot.projectSkills.total}`}
              >
                <p className="m-0 text-xs text-muted-foreground">
                  Все системные скиллы лежат локально внутри репозитория в `.bb/skills/`, автоматически подхватываются BB для этого проекта и читаются чистыми субтредами с диска.
                </p>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
                  {snapshot.projectSkills.items.map((sk) => (
                    <li key={sk.name} className="flex min-w-0 items-center justify-between gap-2">
                      <code className="truncate">{sk.name}</code>
                      <Badge
                        variant={sk.state === "synced" ? "secondary" : "outline"}
                        className="shrink-0 text-[11px]"
                      >
                        {sk.state === "synced" ? "актуален" : sk.state === "outdated" ? "обновить" : "отсутствует"}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </PanelDisclosure>
            )}

            {snapshot.diagnostics.length > 0 && (
              <PanelDisclosure summary={`Примечания · ${snapshot.diagnostics.length}`}>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs text-muted-foreground">
                  {snapshot.diagnostics.map((diag, idx) => (
                    <li key={idx}>{diag}</li>
                  ))}
                </ul>
              </PanelDisclosure>
            )}

            <footer className="border-t border-border pt-3 text-xs text-muted-foreground">
              Обновлено {new Date(snapshot.collectedAt).toLocaleTimeString("ru")} ·{" "}
              {busy
                ? "агент работает — нажатые шаги ставятся в очередь текущего чата"
                : "кнопки шагов отправляют команду в текущий чат"}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
