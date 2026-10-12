import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";

type Board = z.infer<(typeof rpcContract)["task_board"]["output"]>;
type Card = NonNullable<z.infer<(typeof rpcContract)["task_card"]["output"]>>;
type Item = Board["items"][number];
type Thread = NonNullable<Card["threads"]>;

const COLUMNS: Array<{ id: Item["column"]; label: I18nKey }> = [
  { id: "queued", label: "boardColQueued" }, { id: "running", label: "boardColRunning" }, { id: "checking", label: "boardColChecking" },
  { id: "blocked", label: "boardColBlocked" }, { id: "done", label: "boardColDone" },
];
const POLL_MS = 10_000;
const tone = (state: string): "default" | "secondary" | "destructive" | "outline" =>
  state === "blocked" || state === "failed" ? "destructive" : state === "accepted" || state === "succeeded" ? "default" : state === "canceled" ? "outline" : "secondary";
const ago = (ms: number, locale: string) => (ms > 1e11 ? new Date(ms).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");

/**
 * The «Tasks» screen: every Lane Pilot task and chain run of one project or of all, as a board by status (the BB Tasks plugin's
 * board, which Lane Pilot replaces since 2026-10-12). A card opens the task: its contract, plan, stages, attempts and the tree
 * of threads that worked on it (PM, writer per attempt, a helper per stage, their sub-agents).
 */
export function TaskBoard({ projects = [], initialProjectId = null, locale }: { projects?: ReadonlyArray<{ id: string; name: string }>; initialProjectId?: string | null; locale: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? "all");
  const [kind, setKind] = useState<"all" | "task" | "workflow">("all");
  const [doneHours, setDoneHours] = useState(24);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[] | null>(null);
  const [open, setOpen] = useState<Item | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => void rpc.call("task_board", { ...(projectId === "all" ? {} : { projectId }), doneHours })
      .then((result) => { if (alive) setItems(result.items); }).catch(() => undefined);
    read();
    const timer = setInterval(read, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [rpc, projectId, doneHours]);
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const needle = query.trim().toLowerCase();
  const shown = (items ?? []).filter((item) => (kind === "all" || item.kind === kind)
    && (!needle || item.title.toLowerCase().includes(needle) || (item.taskId ?? "").toLowerCase().includes(needle)));

  if (open) return <TaskCardView item={open} locale={locale} projectName={open.projectId ? names.get(open.projectId) ?? null : null} onBack={() => setOpen(null)} />;
  return (
    <div className="space-y-4" data-testid="task-board">
      <div>
        <h2 className="text-lg font-semibold">{t("navTasks")}</h2>
        <p className="text-sm text-muted-foreground">{t("boardHelp")}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-8 w-56" data-testid="board-project"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("boardAllProjects")}</SelectItem>
            {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={(next) => setKind(next as typeof kind)}>
          <SelectTrigger className="h-8 w-44" data-testid="board-kind"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("boardAllKinds")}</SelectItem>
            <SelectItem value="task">{t("boardKindTasks")}</SelectItem>
            <SelectItem value="workflow">{t("boardKindFlows")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(doneHours)} onValueChange={(next) => setDoneHours(Number(next))}>
          <SelectTrigger className="h-8 w-44" data-testid="board-done"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="24">{t("boardDone24")}</SelectItem>
            <SelectItem value="168">{t("boardDone7")}</SelectItem>
          </SelectContent>
        </Select>
        <Input className="h-8 w-56" placeholder={t("boardSearch")} value={query} onChange={(event) => setQuery(event.target.value)} data-testid="board-search" />
      </div>
      {items === null ? <p className="text-sm text-muted-foreground">{t("boardLoading")}</p> : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]" data-testid="board-columns">
          {COLUMNS.map((column) => {
            const cards = shown.filter((item) => item.column === column.id);
            return (
              <section key={column.id} className="min-w-0 rounded-lg border border-[var(--lp-hairline,var(--border))] bg-[var(--lp-well,transparent)] p-2" data-testid={`board-col-${column.id}`}>
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{t(column.label)}</span><span>{cards.length}</span>
                </div>
                <div className="space-y-2">
                  {cards.length ? cards.slice(0, 80).map((item) => (
                    <button key={item.key} type="button" onClick={() => setOpen(item)} data-testid={`board-card-${item.key}`}
                      className="block w-full cursor-pointer rounded-md border border-border bg-background p-2 text-left text-sm hover:bg-state-hover">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 break-words font-medium leading-snug">{item.title}</span>
                        {item.kind === "workflow" ? <Badge variant="outline" className="shrink-0">{t("boardChain")}</Badge> : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={item.taskId ?? item.runId}>{item.taskId ?? item.detail}</div>
                      {item.kind === "task" && item.detail ? <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.detail}</div> : null}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        {item.projectId && projectId === "all" ? <span className="truncate">{names.get(item.projectId) ?? item.projectId}</span> : null}
                        {item.attemptNo > 1 ? <span>{t("boardAttempt")} {item.attemptNo}</span> : null}
                        <span>{ago(item.updatedAt, locale)}</span>
                      </div>
                    </button>
                  )) : <p className="px-1 text-xs text-muted-foreground">{t("boardEmptyColumn")}</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="space-y-1"><div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>{children}</div>;
}

const List = ({ rows, mono = false }: { rows: string[]; mono?: boolean }) =>
  <ul className={`list-disc space-y-0.5 pl-5 text-sm ${mono ? "font-mono text-xs" : ""}`}>{rows.map((row, index) => <li key={index} className="break-words">{row}</li>)}</ul>;

function ThreadTree({ node, depth = 0 }: { node: Thread; depth?: number }) {
  const navigate = useBbNavigate();
  return (
    <div className={depth ? "border-l border-border pl-3" : ""}>
      {node.id ? (
        <button type="button" className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-state-hover"
          onClick={() => navigate.toThread(node.id)} data-testid={`board-thread-${node.id}`}>
          <Badge variant="outline" className="shrink-0">{node.role}</Badge>
          <span className="min-w-0 truncate">{node.title ?? node.id}</span>
          {node.status ? <span className="shrink-0 text-xs text-muted-foreground">{node.status}</span> : null}
        </button>
      ) : null}
      {node.children.length ? <div className="mt-1 space-y-1">{(node.children as Thread[]).map((child) => <ThreadTree key={`${child.role}:${child.id}`} node={child} depth={depth + 1} />)}</div> : null}
    </div>
  );
}

function TaskCardView({ item, locale, projectName, onBack }: { item: Item; locale: string; projectName: string | null; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [card, setCard] = useState<Card | null | "gone">(null);
  const read = () => void rpc.call("task_card", { runId: item.runId, taskId: item.taskId }).then((result) => setCard(result ?? "gone")).catch(() => setCard("gone"));
  useEffect(read, [rpc, item.runId, item.taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (method: "cancel_attempt" | "retry_attempt") => item.attemptId && void rpc.call(method, { attemptId: item.attemptId }).then(read);
  return (
    <div className="space-y-4" data-testid="task-card">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onBack} data-testid="board-back">{t("boardBack")}</Button>
        {item.pmThreadId ? <Button size="sm" variant="outline" onClick={() => navigate.toThread(item.pmThreadId!)}>{t("boardOpenChat")}</Button> : null}
        {item.kind === "task" && ["queued", "running", "checking"].includes(item.column) ? <Button size="sm" variant="outline" onClick={() => act("cancel_attempt")}>{t("cancel")}</Button> : null}
        {item.kind === "task" && item.column === "blocked" ? <Button size="sm" variant="outline" onClick={() => act("retry_attempt")}>{t("retry")}</Button> : null}
      </div>
      {card === null ? <p className="text-sm text-muted-foreground">{t("boardLoading")}</p> : card === "gone" ? <p className="text-sm text-muted-foreground">{t("boardGone")}</p> : (
        <Surface>
          <SurfaceHeader className="flex-wrap justify-between">
            <div className="min-w-0">
              <div className="break-words text-base font-semibold">{card.title}</div>
              <div className="font-mono text-xs text-muted-foreground">{card.id}{projectName ? ` · ${projectName}` : ""}</div>
            </div>
            <Badge variant={tone(card.state)}>{card.state}</Badge>
          </SurfaceHeader>
          <SurfaceBody className="space-y-4">
            {card.reason ? <p className="whitespace-pre-wrap break-words rounded border border-border p-2 text-sm">{card.reason}</p> : null}
            {card.contract?.objective ? <Section title={t("boardObjective")}><p className="whitespace-pre-wrap text-sm">{card.contract.objective}</p></Section> : null}
            {card.contract?.acceptance.length ? <Section title={t("boardAcceptance")}><List rows={card.contract.acceptance} /></Section> : null}
            {card.contract?.dependsOn.length ? <Section title={t("boardDepends")}><List rows={card.contract.dependsOn} mono /></Section> : null}
            {card.contract?.ownsPaths.length ? <Section title={t("boardOwns")}><List rows={card.contract.ownsPaths} mono /></Section> : null}
            {card.contract?.expectedOutputs.length ? <Section title={t("boardOutputs")}><List rows={card.contract.expectedOutputs} mono /></Section> : null}
            {card.contract?.checks.length ? <Section title={t("boardChecks")}><List rows={card.contract.checks} mono /></Section> : null}
            {card.threads ? <Section title={t("boardThreads")}><ThreadTree node={card.threads} /></Section> : null}
            {card.stages.length ? (
              <Section title={card.kind === "workflow" ? t("boardSteps") : t("boardStages")}>
                <div className="space-y-1" data-testid="task-card-stages">
                  {card.stages.map((stage, index) => (
                    <div key={`${stage.id}:${index}`} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs">{stage.id}</span>
                      <Badge variant={tone(stage.state === "passed" ? "accepted" : stage.state)}>{stage.state}</Badge>
                      {stage.model ? <span className="text-xs text-muted-foreground">{stage.model}</span> : null}
                      {stage.reason ? <span className="w-full break-words text-xs text-muted-foreground">{stage.reason}</span> : null}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}
            {card.attempts.length ? (
              <Section title={t("boardAttempts")}>
                <div className="space-y-1">
                  {card.attempts.map((attempt) => (
                    <div key={attempt.id} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                      <span>#{attempt.no}</span>
                      <Badge variant={tone(attempt.state)}>{attempt.state}</Badge>
                      <span className="text-xs text-muted-foreground">{ago(attempt.updatedAt, locale)}</span>
                      {attempt.reason ? <span className="w-full break-words text-xs text-muted-foreground">{attempt.reason}</span> : null}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}
            {card.plan ? <Section title={t("boardPlan")}><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-2 text-xs">{card.plan}</pre></Section> : null}
          </SurfaceBody>
        </Surface>
      )}
    </div>
  );
}
