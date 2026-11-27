import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type I18nKey } from "@lane-pilot/i18n";
import { Icon, StatusPill, type StatusPillTone } from "@lane-pilot/ui-kit";
import type { RepoTrustOutput, TaskHistoryRow, ThreadScope, rpcContract } from "../../contracts";
import { useLpRpcQuery } from "../../ui-shell/ui";
import {
  ChatHistoryTab,
  ChatMemoryTab,
  ChatTasksTab,
  formatCountsSummary,
  mergeScopeTasks,
  type ChatMemoryRecord,
} from "./chat-panel-tabs";
import type { TaskBoardItem } from "./task-shared";
import { ThreadLiveFollowup, type ThreadLiveData } from "./thread-live-followup";
import { useThreadRowStatus } from "./thread-row-status";

type ChatTabId = "tasks" | "memory" | "history" | "helpers";
type ScopeMode = "section" | "project";

const POLL_MS = 8_000;
const HISTORY_LIMIT = 20;

const GATE_LABELS: Record<RepoTrustOutput["gate"]["state"], { key: I18nKey; tone: StatusPillTone }> = {
  passed: { key: "consoleChatGate_passed", tone: "ok" },
  failed: { key: "consoleChatGate_failed", tone: "bad" },
  running: { key: "consoleChatGate_running", tone: "accent" },
  not_run: { key: "consoleChatGate_not_run", tone: "muted" },
  none: { key: "consoleChatGate_none", tone: "muted" },
};

const RULE_ACTION_LABELS: Record<string, I18nKey> = {
  merge_without_owner: "consoleChatRuleAction_merge_without_owner",
  migrations: "consoleChatRuleAction_migrations",
  deploy: "consoleChatRuleAction_deploy",
};

const RULE_MODE_LABELS: Record<RepoTrustOutput["rules"][number]["mode"], { key: I18nKey; toneClass: string }> = {
  auto: { key: "consoleChatRuleMode_auto", toneClass: "lp-text-success" },
  ask: { key: "consoleChatRuleMode_ask", toneClass: "lp-text-warning" },
  owner_only: { key: "consoleChatRuleMode_owner_only", toneClass: "text-destructive" },
};

function repoDisplayName(root: string | null | undefined): string {
  if (!root) return "";
  const trimmed = root.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function formatRemoteName(scopeRepo: ThreadScope["repo"], trustRepo: RepoTrustOutput["repo"] | undefined): string | null {
  if (scopeRepo?.githubRepoId) return scopeRepo.githubRepoId;
  const raw = trustRepo?.remote ?? scopeRepo?.remote ?? null;
  if (!raw) return null;
  return raw.replace(/^https?:\/\/[^/]+\//, "").replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
}

function filterMemoryBySection(records: readonly ChatMemoryRecord[], sectionId: string | null): ChatMemoryRecord[] {
  const nonCards = records.filter((record) => !record.concepts.includes("card"));
  if (!sectionId) return nonCards;
  const scopedTag = `section:${sectionId}`;
  return nonCards.filter(
    (record) => record.scope.length === 0 || record.scope.includes(sectionId) || record.scope.includes(scopedTag),
  );
}

export interface ChatPanelProps {
  threadId: string;
  locale?: string;
  /** Injected by the entry/page layer: `runs` must not import `native-agent` directly (room graph cycle guard). */
  HelpersList?: ComponentType<{ threadId: string; className?: string }>;
}

/** C1 Chat right panel: scope switch, repo trust, Tasks/Memory/History/Helpers tabs, autonomy rules, and follow-up. */
export function ChatPanel({ threadId, locale: localeProp, HelpersList }: ChatPanelProps) {
  const locale = localeProp ?? detectLocale();
  const rpc = useRpc<typeof rpcContract>();

  const [scope, setScope] = useState<ThreadScope | null>(null);
  const [scopeStatus, setScopeStatus] = useState<"loading" | "ready" | "error">("loading");
  const [scopeMode, setScopeMode] = useState<ScopeMode>("section");
  const [activeTab, setActiveTab] = useState<ChatTabId>("tasks");

  const [repoTrust, setRepoTrust] = useState<RepoTrustOutput | null>(null);
  const [memoryRecords, setMemoryRecords] = useState<ChatMemoryRecord[] | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<TaskHistoryRow[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setScopeStatus("loading");
    setScope(null);
    setRepoTrust(null);
    setMemoryRecords(null);
    setHistoryRows(null);
    void rpc
      .call("thread_scope", { threadId })
      .then((res) => {
        if (!alive) return;
        setScope(res);
        setScopeMode(res.sectionId ? "section" : "project");
        setScopeStatus("ready");
      })
      .catch(() => {
        if (!alive) return;
        setScope(null);
        setScopeStatus("error");
      });
    return () => {
      alive = false;
    };
  }, [rpc, threadId]);

  const projectId = scope?.projectId ?? null;
  const hasSection = Boolean(projectId && scope?.sectionId);
  const activeSectionId = hasSection && scopeMode === "section" ? scope!.sectionId : null;
  const noProjectLinked = scopeStatus === "ready" && projectId === null;

  const liveQuery = useLpRpcQuery<ThreadLiveData>("thread_live", { threadId }, { pollMs: POLL_MS });
  const live = liveQuery.data ?? null;
  useThreadRowStatus(threadId, live?.items ?? null);

  const boardQuery = useLpRpcQuery<{ items?: TaskBoardItem[] }>(
    "task_board",
    projectId ? { projectId, doneHours: 24 } : { doneHours: 24 },
    { pollMs: POLL_MS, enabled: Boolean(projectId) },
  );

  useEffect(() => {
    if (!projectId) {
      setRepoTrust(null);
      return;
    }
    let alive = true;
    void rpc
      .call("repo_trust", { projectId, ...(activeSectionId ? { sectionId: activeSectionId } : {}) })
      .then((res) => {
        if (alive) setRepoTrust(res);
      })
      .catch(() => {
        if (alive) setRepoTrust(null);
      });
    return () => {
      alive = false;
    };
  }, [rpc, projectId, activeSectionId]);

  useEffect(() => {
    if (!projectId || activeTab !== "memory") return;
    let alive = true;
    setMemoryLoading(true);
    setMemoryError(null);
    void rpc
      .call("memory_records_list", { projectId })
      .then((res) => {
        if (!alive) return;
        setMemoryRecords(res.records as ChatMemoryRecord[]);
        setMemoryLoading(false);
      })
      .catch((cause) => {
        if (!alive) return;
        setMemoryError(cause instanceof Error ? cause.message : String(cause));
        setMemoryRecords([]);
        setMemoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [rpc, projectId, activeTab]);

  useEffect(() => {
    if (!projectId || activeTab !== "history") return;
    let alive = true;
    setHistoryLoading(true);
    setHistoryError(null);
    void rpc
      .call("task_history", {
        projectId,
        ...(activeSectionId ? { sectionId: activeSectionId } : {}),
        limit: HISTORY_LIMIT,
      })
      .then((res) => {
        if (!alive) return;
        setHistoryRows(res.rows);
        setHistoryLoading(false);
      })
      .catch((cause) => {
        if (!alive) return;
        setHistoryError(cause instanceof Error ? cause.message : String(cause));
        setHistoryRows([]);
        setHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [rpc, projectId, activeSectionId, activeTab]);

  const mergedTasks = useMemo(
    () =>
      mergeScopeTasks({
        liveItems: live?.items ?? [],
        boardItems: projectId ? (boardQuery.data?.items ?? []) : [],
        projectId,
        sectionId: activeSectionId,
        threadId,
      }),
    [live?.items, boardQuery.data?.items, projectId, activeSectionId, threadId],
  );

  const scopedMemory = useMemo(
    () => (memoryRecords ? filterMemoryBySection(memoryRecords, activeSectionId) : null),
    [memoryRecords, activeSectionId],
  );

  const tasksBadge = formatCountsSummary(mergedTasks);
  const rootPath = repoTrust?.repo.root ?? scope?.repo?.root ?? null;
  const rootName = repoDisplayName(rootPath);
  const remoteLabel = formatRemoteName(scope?.repo ?? null, repoTrust?.repo);
  const gateMeta = repoTrust ? GATE_LABELS[repoTrust.gate.state] : null;

  const tabs: Array<{ id: ChatTabId; label: string; count?: number }> = [
    { id: "tasks", label: t("consoleChatTabTasks"), ...(tasksBadge > 0 ? { count: tasksBadge } : {}) },
    { id: "memory", label: t("consoleChatTabMemory") },
    { id: "history", label: t("consoleChatTabHistory") },
    { id: "helpers", label: t("consoleChatTabHelpers") },
  ];

  return (
    <div
      className="flex h-full min-h-0 flex-col justify-between gap-3 p-3"
      data-bb-plugin="lane-pilot"
      data-testid="thread-live-panel"
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {noProjectLinked ? (
          <div className="space-y-3" data-testid="chat-panel-unlinked">
            <div
              className="lp-card px-3 py-2 text-xs text-muted-foreground"
              data-testid="chat-panel-no-project"
            >
              {t("consoleChatNoProject")}
            </div>
            <div className="space-y-2" data-testid="chat-panel-helpers-only">
              <div className="px-0.5 text-xs font-semibold text-foreground">{t("consoleChatTabHelpers")}</div>
              {HelpersList ? <HelpersList threadId={threadId} className="p-0" /> : (
                <p className="text-xs text-muted-foreground">{t("helperPanelEmpty")}</p>
              )}
            </div>
          </div>
        ) : (
          <>
            {projectId ? (
              <header className="space-y-2" data-testid="chat-panel-header">
                {hasSection ? (
                  <div
                    className="lp-seg w-full"
                    role="group"
                    aria-label={t("consoleChatScopeAria")}
                    data-testid="chat-panel-scope"
                  >
                    {(["section", "project"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={scopeMode === mode}
                        data-testid={`chat-scope-${mode}`}
                        onClick={() => setScopeMode(mode)}
                        className="lp-seg-item h-7 flex-1 cursor-pointer px-2.5 text-xs"
                      >
                        {t(mode === "section" ? "consoleChatScopeSection" : "consoleChatScopeProject")}
                      </button>
                    ))}
                  </div>
                ) : null}

                {scope?.repo !== null ? (
                  <div className="lp-card space-y-1.5 px-3 py-2 text-xs" data-testid="chat-panel-repo">
                    <div className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                      <Icon name="GitBranch" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 truncate" title={rootPath ?? undefined}>
                        {remoteLabel ?? rootName}
                      </span>
                      {remoteLabel && rootName && !remoteLabel.endsWith(rootName) ? (
                        <span className="shrink-0 text-muted-foreground">· {rootName}</span>
                      ) : null}
                    </div>
                    {repoTrust ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {gateMeta ? (
                          <StatusPill tone={gateMeta.tone} className="text-[10px] leading-4">
                            {t(gateMeta.key)}
                          </StatusPill>
                        ) : null}
                        {repoTrust.tests.lastCount !== null ? (
                          <span>{t("consoleChatRepoTests").replace("{n}", String(repoTrust.tests.lastCount))}</span>
                        ) : null}
                        <span>{t("consoleChatRepoRollbacks").replace("{n}", String(repoTrust.rollbacks30d))}</span>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div
                    className="lp-card flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground"
                    data-testid="chat-panel-no-repo"
                  >
                    <Icon name="Folder" className="size-3.5 shrink-0" aria-hidden />
                    <span>{t("consoleChatNoRepo")}</span>
                  </div>
                )}
              </header>
            ) : null}

            {projectId ? (
              <nav
                className="flex flex-wrap items-center gap-1 border-b border-[var(--lp-hairline)] pb-1"
                role="tablist"
                aria-label={t("consoleChatTabsAria")}
                data-testid="chat-panel-tabs"
              >
                {tabs.map((tab) => {
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-testid={`chat-tab-${tab.id}`}
                      onClick={() => setActiveTab(tab.id)}
                      className={`inline-flex cursor-pointer items-center gap-1 border-b-2 px-2 py-1 text-xs transition-colors ${
                        selected
                          ? "border-foreground font-semibold text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <span>{tab.label}</span>
                      {tab.count ? <span className="tabular-nums text-[11px] text-muted-foreground">{tab.count}</span> : null}
                    </button>
                  );
                })}
              </nav>
            ) : null}

            {(!projectId || activeTab === "tasks") ? (
              <ChatTasksTab
                items={mergedTasks}
                session={live?.session ?? null}
                locale={locale}
                loading={liveQuery.isLoading || (Boolean(projectId) && boardQuery.isLoading)}
              />
            ) : activeTab === "memory" ? (
              <ChatMemoryTab records={scopedMemory} loading={memoryLoading} error={memoryError} />
            ) : activeTab === "history" ? (
              <ChatHistoryTab rows={historyRows} loading={historyLoading} error={historyError} locale={locale} />
            ) : (
              <div data-testid="chat-panel-helpers">
                {HelpersList ? (
                  <HelpersList threadId={threadId} className="p-0" />
                ) : (
                  <p className="text-xs text-muted-foreground">{t("helperPanelEmpty")}</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 space-y-3">
        {!noProjectLinked && projectId && repoTrust?.rules.length ? (
          <section
            className="lp-card space-y-1.5 px-3 py-2 text-xs"
            data-testid="chat-panel-autonomy"
          >
            <div className="font-semibold text-foreground">{t("consoleChatAutonomyTitle")}</div>
            <div className="space-y-1">
              {repoTrust.rules.map((rule) => {
                const actionKey = RULE_ACTION_LABELS[rule.actionClass];
                const modeMeta = RULE_MODE_LABELS[rule.mode];
                return (
                  <div
                    key={rule.actionClass}
                    className="flex items-center justify-between gap-2 text-[11px]"
                    data-testid={`chat-autonomy-rule-${rule.actionClass}`}
                  >
                    <span className="min-w-0 truncate text-muted-foreground">
                      {actionKey ? t(actionKey) : rule.actionClass}
                    </span>
                    <span className={`shrink-0 font-medium ${modeMeta.toneClass}`}>{t(modeMeta.key)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}
        <ThreadLiveFollowup threadId={threadId} />
      </div>
    </div>
  );
}
