import { useMemo, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Badge, Button, Disclosure } from "@lane-pilot/ui-kit";
import { Field, Loaded, Panel, RefreshButton, fill, useLoad, type Rpc } from "./kit";

type PhaseRow = { id: string; title: string; goal: string; stage: string; state: string; next?: { text: string; waitsForPm: boolean } };
type PhaseStatus = {
  phase: PhaseRow & { record: { plan?: { items: Array<{ id: string; title: string; wave: number; promise: { then: string } }> }; questions?: Array<{ id: string; text: string; blocking: boolean; answer?: string }>; acceptance?: { lines: Array<{ id: string; ok: boolean; detail: string }> }; uat?: { path: string }; ownerWords?: boolean; execution?: { issued: Record<string, string> } } };
  next: { text: string }; gates: Record<string, { ok: boolean; why?: string[] }>; book: string; facts: Record<string, { taskId: string; state: string | null }>;
};

/** Phases: the list, and one phase as its card — next step, gates, plan lines, questions, acceptance lines, folder and book, the owner's word and the controls. */
export function PhasesScreen({ rpc, projectId }: { rpc: Rpc; projectId: string }) {
  const list = useLoad(() => rpc.call("phase_list", { projectId }) as Promise<PhaseRow[]>, [projectId]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel title={t("ckScreen_phases")} testId="ck-phases" actions={<RefreshButton onClick={list.reload} />}>
      <Loaded state={list}>{(rows) => !rows.length ? <p className="text-sm text-muted-foreground">{t("ckPhaseNone")}</p> : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-md border border-border p-2" data-testid={`ck-phase-${row.id}`}>
              {/* One open task: opening a phase card closes the one that was open. */}
              <button type="button" className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setOpen(open === row.id ? null : row.id)} aria-expanded={open === row.id}>
                <Badge variant="outline">{row.stage}</Badge><span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span><span className="text-xs text-muted-foreground">{row.state}</span>
              </button>
              {open === row.id ? <PhaseCard rpc={rpc} projectId={projectId} phaseId={row.id} onChanged={list.reload} /> : null}
            </div>
          ))}
        </div>
      )}</Loaded>
    </Panel>
  );
}

function PhaseCard({ rpc, projectId, phaseId, onChanged }: { rpc: Rpc; projectId: string; phaseId: string; onChanged: () => void }) {
  const status = useLoad(() => rpc.call("phase_get", { phaseId }) as Promise<PhaseStatus>, [phaseId]);
  const [words, setWords] = useState("");
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const control = (action: "pause" | "resume" | "stop_wave" | "close" | "word" | "return", extra: Record<string, unknown> = {}) =>
    void rpc.call("phase_control", { phaseId, action, ...extra } as never).then(() => { status.reload(); onChanged(); });
  const act = (action: "correct" | "answer", payload: Record<string, unknown>) =>
    void rpc.call("phase_act", { action, projectId, pmThreadId: "screen", phaseId, payload }).then(() => status.reload());
  return (
    <Loaded state={status}>{(s) => {
      const r = s.phase.record;
      const turn = s.phase.stage === "acceptance" ? (r.uat ? "uat" : "acceptance") : s.phase.stage === "design" ? "design" : "planning";
      return (
        <div className="mt-2 space-y-3 text-sm" data-testid="ck-phase-card">
          <p><span className="font-medium">{t("ckPhaseNext")}:</span> {s.next.text}</p>
          <Disclosure summary={t("ckPhaseGates")}>
            <ul className="space-y-1">{Object.entries(s.gates).map(([gate, result]) => <li key={gate}>{result.ok ? "✓" : "✗"} {gate}{result.why?.length ? ` — ${result.why.join("; ")}` : ""}</li>)}</ul>
          </Disclosure>
          {r.plan?.items.length ? (
            <Disclosure summary={t("ckPhasePlan")}>
              {/* Phase plan lines: each piece with its wave, its promise and the task it became. */}
              <ul className="space-y-1">{r.plan.items.map((item) => <li key={item.id} data-testid={`ck-plan-${item.id}`}>w{item.wave} · {item.title} — {item.promise.then} <span className="text-muted-foreground">{s.facts[item.id] ? `${s.facts[item.id]!.taskId} ${s.facts[item.id]!.state ?? ""}` : ""}</span></li>)}</ul>
            </Disclosure>
          ) : null}
          {r.questions?.length ? (
            <Disclosure summary={t("ckPhaseDiscussion")} open>
              {r.questions.map((question) => (
                <div key={question.id} className="space-y-1 border-b border-border/60 py-1 last:border-b-0">
                  <p>{question.id}{question.blocking ? " ⛔" : ""}: {question.text}</p>
                  {question.answer ? <p className="text-muted-foreground">→ {question.answer}</p> : (
                    <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-border bg-background px-2 text-base sm:text-sm" value={answers[question.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [question.id]: e.target.value })} />
                      <Button size="sm" onClick={() => act("answer", { questionId: question.id, answer: answers[question.id] ?? "" })}>{t("ckAnswer")}</Button></div>
                  )}
                </div>
              ))}
            </Disclosure>
          ) : null}
          {r.acceptance?.lines.length ? (
            <Disclosure summary={t("ckPhaseAcceptance")} open={s.phase.stage === "acceptance" ? true : undefined}>
              {/* Full phase acceptance: every line with what it saw. */}
              <ul className="space-y-1" data-testid="ck-acceptance">{r.acceptance.lines.map((line) => <li key={line.id}>{line.ok ? "✓" : "✗"} {line.id}: {line.detail}</li>)}</ul>
            </Disclosure>
          ) : null}
          <Disclosure summary={t("ckPhaseFolder")}>
            <p className="text-xs text-muted-foreground">.agents/phases/{phaseId}/ — BOOK.md{r.uat ? `, ${r.uat.path.split("/").pop()}` : ""}</p>
            <div className="max-h-80 overflow-auto text-xs"><Markdown content={s.book.slice(0, 20_000)} /></div>
          </Disclosure>
          {r.ownerWords ? (
            <div className="space-y-1" data-testid="ck-word">
              {/* The owner's word at a stage gate (and the UAT line at acceptance): yes, or no with the words why. */}
              <Field label={`${t("ckPhaseWord")} · ${turn === "uat" ? t("ckUatLine") : turn}`} value={words} onChange={setWords} />
              <div className="flex gap-2"><Button size="sm" onClick={() => control("word", { turn, decision: "yes", note: words || "да" })}>{t("ckYes")}</Button>
                <Button size="sm" variant="outline" disabled={!words.trim()} onClick={() => control("word", { turn, decision: "no", note: words })}>{t("ckNo")}</Button></div>
            </div>
          ) : null}
          <div className="space-y-1">
            <Field label={t("ckContextNote")} value={note} onChange={setNote} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => act("correct", { note })}>{t("ckSend")}</Button>
              <Button size="sm" variant="outline" onClick={() => control(s.phase.state === "paused" ? "resume" : "pause")}>{s.phase.state === "paused" ? t("ckResume") : t("ckPause")}</Button>
              {/* Hold or release a wave: the queued pieces of the wave are held back. */}
              <Button size="sm" variant="outline" onClick={() => control("stop_wave")}>{t("ckStopWave")}</Button>
              <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => control("close", { note })}>{t("ckClose")}</Button>
            </div>
          </div>
        </div>
      );
    }}</Loaded>
  );
}

type TaskView = { displayTitle: string | null; objective: string | null; area: string | null; clarify: { questions?: string[]; answers?: Array<{ question: string; answer: string; by: string }> } | null; drawing: string[]; priority: string; heldUntil: number | null; approach: { approach?: string | null; lesson?: string | null } | null };

const TITLE_MAX = 60;
/** Suggest task words: the task standard said before the PM refuses it — a person's words, no ids or paths, short (~60 characters). */
export function taskWords(title: string): string | null {
  const text = title.trim();
  if (!text) return "Опишите, что изменится для человека";
  if ([...text].length > TITLE_MAX) return `короче: ${[...text].slice(0, TITLE_MAX - 1).join("")}…`;
  if (/[/\\]|\.[a-z]{2,4}\b|[A-Za-z]+-\d+|_/.test(text)) return "без путей и id: что увидит человек";
  return null;
}

/** Suggest a composition: the lines of a batch grouped by the area word they start with («area: …»). */
export function composition(lines: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const line of lines.map((row) => row.trim()).filter(Boolean)) {
    const area = line.match(/^([^:]{2,30}):/)?.[1]?.trim() ?? "—";
    groups.set(area, [...(groups.get(area) ?? []), line]);
  }
  return groups;
}

/** Tasks: one task by id (clarification, drawing, approach note, queue position), the new task and new batch forms, promoting a backlog item. */
export function TasksScreen({ rpc, projectId, runId }: { rpc: Rpc; projectId: string; runId: string | null }) {
  const [taskId, setTaskId] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [what, setWhat] = useState("");
  const [batch, setBatch] = useState("");
  const [promote, setPromote] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const groups = useMemo(() => composition(batch.split("\n")), [batch]);
  const request = (kind: "task" | "batch" | "promote", text: string) => void rpc.call("cockpit_request", { projectId, kind, text }).then(() => setSent(t("ckSent")), (cause: unknown) => setSent(String(cause)));
  const hint = taskWords(title);
  return (
    <div className="space-y-4">
      {runId ? (
        <Panel title={t("ckScreen_tasks")} testId="ck-task-lookup">
          <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-border bg-background px-2 text-base sm:text-sm" placeholder={t("ckTaskLookup")} value={taskId} onChange={(e) => setTaskId(e.target.value)} />
            <Button size="sm" disabled={!taskId.trim()} onClick={() => setShown(taskId.trim())}>{t("ckTaskOpen")}</Button></div>
          {shown ? <TaskDetail rpc={rpc} runId={runId} taskId={shown} /> : null}
        </Panel>
      ) : null}
      <Panel title={t("ckNewTask")} testId="ck-new-task">
        <Field label={t("ckNewTaskTitle")} value={title} onChange={setTitle} testId="ck-new-task-title" />
        {hint ? <p className="text-xs text-muted-foreground" data-testid="ck-task-words">{fill("ckSuggestWords", { s: hint })}</p> : null}
        <Field label={t("ckNewTaskWhat")} value={what} onChange={setWhat} multiline />
        <Button size="sm" disabled={!!hint || what.trim().length < 5} onClick={() => request("task", `${title}\n\n${what}`)}>{t("ckSend")}</Button>
      </Panel>
      <Panel title={t("ckNewBatch")} testId="ck-new-batch">
        <Field label={t("ckNewBatch")} value={batch} onChange={setBatch} multiline />
        {batch.trim() ? <p className="text-xs text-muted-foreground">{fill("ckComposition", { n: groups.size })}: {[...groups.keys()].join(", ")}</p> : null}
        <Button size="sm" disabled={batch.trim().length < 5} onClick={() => request("batch", [...groups.entries()].map(([area, rows]) => `${area}:\n${rows.join("\n")}`).join("\n\n"))}>{t("ckSend")}</Button>
      </Panel>
      <Panel title={t("ckPromote")} testId="ck-promote">
        <Field label={t("ckPromote")} value={promote} onChange={setPromote} />
        <Button size="sm" disabled={promote.trim().length < 3} onClick={() => request("promote", promote)}>{t("ckSend")}</Button>
      </Panel>
      {sent ? <p className="text-xs text-muted-foreground">{sent}</p> : null}
    </div>
  );
}

function TaskDetail({ rpc, runId, taskId }: { rpc: Rpc; runId: string; taskId: string }) {
  const task = useLoad(() => rpc.call("cockpit_task", { runId, taskId }) as Promise<TaskView | null>, [runId, taskId]);
  const queue = (action: "hold" | "release" | "priority", priority?: "low" | "normal" | "high" | "urgent") => void rpc.call("cockpit_queue", { runId, taskIds: [taskId], action, ...(priority ? { priority } : {}) }).then(task.reload);
  return (
    <Loaded state={task}>{(view) => !view ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
      <div className="space-y-2 text-sm" data-testid="ck-task-detail">
        <p className="font-medium">{view.displayTitle ?? taskId}</p>
        {view.objective ? <p className="text-muted-foreground">{view.objective.slice(0, 600)}</p> : null}
        {view.clarify ? (
          <Disclosure summary={t("ckClarify")} open>
            {(view.clarify.questions ?? []).map((question) => <p key={question}>? {question}</p>)}
            {(view.clarify.answers ?? []).map((answer) => <p key={answer.question}>✓ {answer.question} → {answer.answer} <span className="text-xs text-muted-foreground">({answer.by})</span></p>)}
          </Disclosure>
        ) : null}
        {view.drawing.length ? <Disclosure summary={t("ckDrawing")}><ul>{view.drawing.map((path) => <li key={path} className="font-mono text-xs">{path}</li>)}</ul></Disclosure> : null}
        {view.approach?.approach ? <p><span className="font-medium">{t("ckApproach")}:</span> {view.approach.approach}{view.approach.lesson ? ` · ${view.approach.lesson}` : ""}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("ckQueue")}:</span>
          <Button size="sm" variant="outline" onClick={() => queue(view.heldUntil ? "release" : "hold")}>{view.heldUntil ? t("ckRelease") : t("ckHold")}</Button>
          <select aria-label={t("ckPriority")} className="h-8 rounded border border-border bg-background px-1 text-base sm:text-sm" value={view.priority} onChange={(e) => queue("priority", e.target.value as "low" | "normal" | "high" | "urgent")}>
            {["low", "normal", "high", "urgent"].map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
      </div>
    )}</Loaded>
  );
}
