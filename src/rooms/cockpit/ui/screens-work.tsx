import { useMemo, useState } from "react";
import { Markdown, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { drawingFeedbackNote, drawingFeedbackProblems } from "@lane-pilot/contracts";
import { t } from "@lane-pilot/i18n";
import { Badge, Button, Disclosure } from "@lane-pilot/ui-kit";
import { Field, Loaded, Panel, RefreshButton, day, fill, useLoad, type Rpc } from "./kit";
import { StageStrip } from "../../work-graph/ui";
import type { StageCell } from "../../work-graph";

type PhaseRow = { id: string; title: string; goal: string; stage: string; state: string; next?: { text: string; waitsForPm: boolean }; cells?: StageCell[] };
type PhaseStatus = {
  phase: PhaseRow & { record: { plan?: { items: Array<{ id: string; title: string; wave: number; promise: { then: string } }> }; questions?: Array<{ id: string; text: string; blocking: boolean; answer?: string }>; acceptance?: { lines: Array<{ id: string; ok: boolean; detail: string }> }; uat?: { path: string; lines?: Array<{ n: number; pieceId: string; state: string; note?: string }> }; ownerWords?: boolean;
    context?: { appetite?: string; noGos?: string[]; risks?: Partial<Record<string, string>> };
    design?: { drawing?: { paths: string[]; sha256: string; designer: string; reviewer?: string; feasible?: boolean; contradiction?: string }; archived?: Array<unknown> };
    execution?: { issued: Record<string, string>; waves?: Record<string, { lines: Array<{ id: string; ok: boolean; detail: string }>; review?: { state: string; by: string; summary: string } }> };
    observation?: { outcome: string; reverted: string[]; until: number };
    lessons?: { analysis?: string; draft?: { text: string; state: string } } } };
  next: { text: string; key?: string }; ownerWord?: { acceptanceKey?: string; designKey?: string }; gates: Record<string, { ok: boolean; why?: string[] }>; book: string; facts: Record<string, { taskId: string; attemptId?: string | null; state: string | null }>;
  acceptancePackage?: { key: string; verdict: { state: string; detail: string; mainSha: string | null } | null; diffStat: string | null } | null;
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
                <Badge variant="outline">{row.stage}</Badge>{row.cells ? <StageStrip cells={row.cells} testId={`ck-phase-strip-${row.id}`} /> : null}<span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span><span className="text-xs text-muted-foreground">{row.state}</span>
              </button>
              {open === row.id ? <PhaseCard rpc={rpc} projectId={projectId} phaseId={row.id} onChanged={list.reload} /> : null}
            </div>
          ))}
        </div>
      )}</Loaded>
    </Panel>
  );
}

/** The six-line summary of the phase discussion (SMA sc_phase_disc): problem, appetite, solution, rabbit holes, no-gos, risks. */
export function discussionLines(record: { goal?: string; plan?: { items: Array<{ title: string }> }; context?: { appetite?: string; noGos?: string[]; risks?: Partial<Record<string, string>> } }): Array<{ label: string; text: string }> {
  const none = "не названо";
  const or = (text: string | undefined) => text?.trim() ? text.trim() : none;
  const risks = record.context?.risks ?? {};
  return [
    { label: "Проблема", text: or(record.goal) },
    { label: "Аппетит", text: or(record.context?.appetite) },
    { label: "Решение", text: record.plan?.items.length ? record.plan.items.map((item) => item.title).join("; ") : none },
    { label: "Подводные камни", text: or(risks.feasibility) },
    { label: "Не делаем", text: record.context?.noGos?.filter((line) => line.trim()).length ? record.context.noGos.filter((line) => line.trim()).join("; ") : none },
    { label: "Риски", text: [risks.value, risks.usability, risks.viability, risks.security].filter((line) => line?.trim()).join("; ") || none },
  ];
}

/** The phase folder's files (SMA d_phase_files): a click reads one file's text under it. */
function PhaseFiles({ rpc, phaseId }: { rpc: Rpc; phaseId: string }) {
  const list = useLoad(() => rpc.call("phase_files", { phaseId }) as Promise<{ files: Array<{ path: string; size: number }> }>, [phaseId]);
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data?.files ?? [];
  if (!rows.length) return null;
  return (
    <ul className="space-y-1 font-mono text-xs" data-testid="ck-phase-files">
      {rows.map((file) => (
        <li key={file.path}>
          <button type="button" className="text-left underline" onClick={() => setOpen(open === file.path ? null : file.path)}>{file.path.split("/").pop()}</button>
          <span className="text-muted-foreground"> · {file.size} B</span>
          {open === file.path ? <PhaseFileText rpc={rpc} phaseId={phaseId} path={file.path} /> : null}
        </li>
      ))}
    </ul>
  );
}

function PhaseFileText({ rpc, phaseId, path }: { rpc: Rpc; phaseId: string; path: string }) {
  const file = useLoad(() => rpc.call("phase_files", { phaseId, path }) as Promise<{ content: { text: string; truncated: boolean } | null }>, [phaseId, path]);
  const text = file.data?.content?.text;
  return <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{text ?? "…"}</pre>;
}

function PhaseCard({ rpc, projectId, phaseId, onChanged }: { rpc: Rpc; projectId: string; phaseId: string; onChanged: () => void }) {
  const status = useLoad(() => rpc.call("phase_get", { phaseId }) as Promise<PhaseStatus>, [phaseId]);
  const [words, setWords] = useState("");
  const [useful, setUseful] = useState(false);
  const [limits, setLimits] = useState(false);
  const [note, setNote] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // The design-turn «нет» is the goal—obstacle—question form (SMA m_sw_design_feedback), sent as one note.
  const [fbGoal, setFbGoal] = useState("");
  const [fbObstacle, setFbObstacle] = useState("");
  const [fbQuestion, setFbQuestion] = useState("");
  const control = (action: "pause" | "resume" | "stop_wave" | "stop" | "close" | "word" | "return" | "interrupt" | "decide" | "withdraw" | "uat_line", extra: Record<string, unknown> = {}) =>
    void rpc.call("phase_control", { phaseId, action, ...extra } as never).then(() => { status.reload(); onChanged(); });
  // One piece of the batch at a time (SMA d_batch_decide): cancel or retry go to the attempt's own verbs.
  const pieceAct = (method: "cancel_attempt" | "retry_attempt", attemptId: string, cancelNote?: string) =>
    void rpc.call(method, { attemptId, ...(method === "cancel_attempt" && cancelNote?.trim() ? { note: cancelNote.trim() } : {}) } as never).then(() => { status.reload(); onChanged(); });
  const act = (action: "correct" | "answer", payload: Record<string, unknown>) =>
    void rpc.call("phase_act", { action, projectId, pmThreadId: "screen", phaseId, payload }).then(() => status.reload());
  return (
    <Loaded state={status}>{(s) => {
      const r = s.phase.record;
      // The turn the phase waits on is the one its next step names (word:<turn>[:wave]); a closed phase waits only on its lesson draft.
      const asked = s.next.key?.match(/:word:([a-z]+)(?::(\d+))?/);
      const turn = r.lessons?.draft?.state === "staged" ? "lesson" : asked?.[1] ?? null;
      const wave = turn === "wave" && asked?.[2] ? Number(asked[2]) : undefined;
      // The yes signs the package on the screen: its key goes with it, and a package that changed meanwhile is refused.
      const decisions = turn === "acceptance" ? { useful, limits, key: s.acceptancePackage?.key ?? s.ownerWord?.acceptanceKey } : turn === "design" ? { key: s.ownerWord?.designKey } : {};
      const feedback = { goal: fbGoal, obstacle: fbObstacle, question: fbQuestion };
      const designNote = turn === "design" && !drawingFeedbackProblems(feedback).length ? drawingFeedbackNote(feedback) : "";
      const wordNote = turn === "design" ? designNote : words;
      return (
        <div className="mt-2 space-y-3 text-sm" data-testid="ck-phase-card">
          <p><span className="font-medium">{t("ckPhaseNext")}:</span> {s.next.text}</p>
          <Disclosure summary={t("ckPhaseGates")}>
            <ul className="space-y-1">{Object.entries(s.gates).map(([gate, result]) => <li key={gate}>{result.ok ? "✓" : "✗"} {gate}{result.why?.length ? ` — ${result.why.join("; ")}` : ""}</li>)}</ul>
          </Disclosure>
          {r.plan?.items.length ? (
            <Disclosure summary={t("ckPhasePlan")}>
              {/* Phase plan lines: each piece with its wave, its promise and the task it became. */}
              <ul className="space-y-1">{r.plan.items.map((item) => { const fact = s.facts[item.id]; const working = fact?.state && ["queued", "running", "checking"].includes(fact.state); return (
                <li key={item.id} data-testid={`ck-plan-${item.id}`} className="flex flex-wrap items-center gap-2">w{item.wave} · {item.title} — {item.promise.then} <span className="text-muted-foreground">{fact ? `${fact.taskId} ${fact.state ?? ""}` : ""}</span>
                  {/* The owner's per-piece decision (SMA d_batch_decide): trim a piece not yet issued (with his note), cancel one at work, retry a blocked one. */}
                  {!fact ? <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => control("withdraw", { piece: item.id, note })}>{t("ckPieceWithdraw")}</Button> : null}
                  {working && fact.attemptId ? <Button size="sm" variant="outline" onClick={() => pieceAct("cancel_attempt", fact.attemptId!, note)}>{t("cancel")}</Button> : null}
                  {fact?.state === "blocked" && fact.attemptId ? <Button size="sm" variant="outline" onClick={() => pieceAct("retry_attempt", fact.attemptId!)}>{t("retry")}</Button> : null}
                </li>); })}</ul>
            </Disclosure>
          ) : null}
          <Disclosure summary={t("ckPhaseDiscussion")} open>
            {/* The discussion's six lines (SMA sc_phase_disc): problem, appetite, solution, rabbit holes, no-gos, risks. */}
            <ul className="space-y-1 border-b border-border/60 pb-1" data-testid="ck-discussion">{discussionLines({ ...r, goal: s.phase.goal }).map((line) => <li key={line.label}><span className="font-medium">{line.label}:</span> {line.text}</li>)}</ul>
            {r.questions?.map((question) => (
                <div key={question.id} className="space-y-1 border-b border-border/60 py-1 last:border-b-0">
                  <p>{question.id}{question.blocking ? " ⛔" : ""}: {question.text}</p>
                  {question.answer ? <p className="text-muted-foreground">→ {question.answer}</p> : (
                    <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-border bg-background px-2 text-base sm:text-sm" value={answers[question.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [question.id]: e.target.value })} />
                      <Button size="sm" onClick={() => act("answer", { questionId: question.id, answer: answers[question.id] ?? "" })}>{t("ckAnswer")}</Button></div>
                  )}
                </div>
              ))}
            </Disclosure>
          {r.acceptance?.lines.length ? (
            <Disclosure summary={t("ckPhaseAcceptance")} open={s.phase.stage === "acceptance" ? true : undefined}>
              {/* Full phase acceptance: every line with what it saw. */}
              <ul className="space-y-1" data-testid="ck-acceptance">{r.acceptance.lines.map((line) => <li key={line.id}>{line.ok ? "✓" : "✗"} {line.id}: {line.detail}</li>)}</ul>
            </Disclosure>
          ) : null}
          {r.design?.drawing ? (
            <Disclosure summary={t("ckPhaseDrawing")} testId="ck-drawing">
              {/* The drawing edition the phase signed (SMA sc_phase_card): files, who drew and checked it, feasibility or the contradiction, its sha, archived editions. */}
              <ul className="space-y-1 text-xs">
                <li>{r.design.drawing.paths.join(", ")}</li>
                <li>{t("ckDrawingBy")}: {r.design.drawing.designer}{r.design.drawing.reviewer ? ` · ${t("ckDrawingReview")}: ${r.design.drawing.reviewer}` : ""}</li>
                <li>{r.design.drawing.feasible === false ? `✗ ${r.design.drawing.contradiction ?? t("ckDrawingNo")}` : r.design.drawing.feasible ? "✓" : "…"} · {t("ckDrawingEdition")} {r.design.drawing.sha256.slice(0, 8)}{r.design.archived?.length ? ` · ${fill("ckDrawingArchived", { n: r.design.archived.length })}` : ""}</li>
              </ul>
            </Disclosure>
          ) : null}
          {r.lessons?.analysis ? (
            <Disclosure summary={t("ckPhaseLessons")} testId="ck-lessons">
              <p className="text-xs">{r.lessons.analysis}</p>
              {r.lessons.draft ? <p className="text-xs text-muted-foreground">{t("ckLessonDraft")}: {r.lessons.draft.state}</p> : null}
            </Disclosure>
          ) : null}
          {r.observation ? (
            <Disclosure summary={t("ckPhaseObservation")} testId="ck-observation">
              <p className="text-xs">{t(`ckObservation_${r.observation.outcome}` as never)}{r.observation.reverted.length ? ` — ${r.observation.reverted.join(", ")}` : ""} · {t("ckObservationUntil")} {day(r.observation.until)}</p>
            </Disclosure>
          ) : null}
          <Disclosure summary={t("ckPhaseFolder")}>
            <p className="text-xs text-muted-foreground">.agents/phases/{phaseId}/ — BOOK.md{r.uat ? `, ${r.uat.path.split("/").pop()}` : ""}</p>
            <PhaseFiles rpc={rpc} phaseId={phaseId} />
            <div className="max-h-80 overflow-auto text-xs"><Markdown content={s.book.slice(0, 20_000)} /></div>
          </Disclosure>
          {r.ownerWords && turn ? (
            <div className="space-y-1" data-testid="ck-word">
              {/* The owner's word at a stage gate (and the UAT line at acceptance): yes, or no with the words why. */}
              {turn === "lesson" ? <p className="text-xs text-muted-foreground" data-testid="ck-lesson-draft">{t("ckLessonDraft")}: {r.lessons?.draft?.text}</p> : null}
              {/* Keyed decision on the phase (SMA p6_decide, ta_view): the package shown is the package signed — its key, the verdict and the diff. */}
              {turn === "acceptance" ? (
                <div className="space-y-1">
                  {s.acceptancePackage ? (
                    <div className="rounded border border-border/60 p-2 text-xs" data-testid="ck-acceptance-package">
                      <p data-testid="ck-package-key">package {s.acceptancePackage.key}</p>
                      {s.acceptancePackage.verdict ? <p>{s.acceptancePackage.verdict.state}: {s.acceptancePackage.verdict.detail}{s.acceptancePackage.verdict.mainSha ? ` (${s.acceptancePackage.verdict.mainSha.slice(0, 12)})` : ""}</p> : null}
                      {s.acceptancePackage.diffStat ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap">{s.acceptancePackage.diffStat}</pre> : null}
                    </div>
                  ) : null}
                  <label className="flex items-center gap-2"><input type="checkbox" checked={useful} onChange={(e) => setUseful(e.target.checked)} data-testid="ck-useful" /> {t("ckUseful")}</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={limits} onChange={(e) => setLimits(e.target.checked)} data-testid="ck-limits" /> {t("ckLimits")}</label>
                </div>
              ) : null}
              {/* UAT lines (SMA p5_uat_line): answered one by one, by number, pass or fail. */}
              {turn === "uat" && r.uat?.lines?.length ? (
                <ul className="space-y-1" data-testid="ck-uat-lines">{r.uat.lines.map((row) => (
                  <li key={row.n} className="flex items-center gap-2" data-testid={`ck-uat-line-${row.n}`}>
                    <span>{row.n}. {row.pieceId} — {row.state}{row.note ? ` (${row.note})` : ""}</span>
                    {row.state === "open" ? <>
                      <Button size="sm" variant="outline" onClick={() => control("uat_line", { line: row.n, result: "pass", note: words })}>{t("ckYes")}</Button>
                      <Button size="sm" variant="outline" disabled={!words.trim()} onClick={() => control("uat_line", { line: row.n, result: "fail", note: words })}>{t("ckNo")}</Button>
                    </> : null}
                  </li>))}</ul>
              ) : null}
              {/* A wave's turn asks with its basis (SMA m_sw_batch_hold): the wave's acceptance lines and the other model's review summary. */}
              {turn === "wave" && wave !== undefined && r.execution?.waves?.[String(wave)] ? (
                <div className="space-y-1 rounded border border-border/60 p-2 text-xs" data-testid="ck-wave-question">
                  <p className="font-medium">{fill("ckWaveReady", { n: wave })}</p>
                  <ul className="space-y-0.5">{r.execution.waves[String(wave)]!.lines.map((line) => <li key={line.id}>{line.ok ? "✓" : "✗"} {line.id}: {line.detail}</li>)}</ul>
                  {r.execution.waves[String(wave)]!.review ? <p className="text-muted-foreground" data-testid="ck-wave-review">{r.execution.waves[String(wave)]!.review!.by}: {r.execution.waves[String(wave)]!.review!.summary}</p> : null}
                </div>
              ) : null}
              {turn === "design" ? (
                <div className="space-y-1" data-testid="ck-design-feedback">
                  <Field label={t("ckFbGoal")} value={fbGoal} onChange={setFbGoal} />
                  <Field label={t("ckFbObstacle")} value={fbObstacle} onChange={setFbObstacle} />
                  <Field label={t("ckFbQuestion")} value={fbQuestion} onChange={setFbQuestion} />
                </div>
              ) : (
                <Field label={`${t("ckPhaseWord")} · ${turn === "uat" ? t("ckUatLine") : turn}`} value={words} onChange={setWords} />
              )}
              <div className="flex gap-2"><Button size="sm" disabled={turn === "acceptance" && !(useful && limits)} onClick={() => control("word", { turn, wave, decision: "yes", note: wordNote || "да", ...decisions })}>{turn === "wave" ? t("ckWaveAccept") : t("ckYes")}</Button>
                <Button size="sm" variant="outline" disabled={!wordNote.trim()} onClick={() => control("word", { turn, wave, decision: "no", note: wordNote, ...decisions })}>{turn === "wave" ? t("ckWaveHold") : t("ckNo")}</Button></div>
            </div>
          ) : null}
          <div className="space-y-1">
            <Field label={t("ckContextNote")} value={note} onChange={setNote} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => act("correct", { note })}>{t("ckSend")}</Button>
              <Button size="sm" variant="outline" onClick={() => control(s.phase.state === "paused" ? "resume" : "pause")}>{s.phase.state === "paused" ? t("ckResume") : t("ckPause")}</Button>
              {/* Hold or release a wave: the queued pieces of the wave are held back. */}
              <Button size="sm" variant="outline" onClick={() => control("stop_wave")}>{t("ckStopWave")}</Button>
              {/* Force-interrupt (SMA px_force): only while the running work is not proven stopped; the phase pauses when every stop is observed. */}
              {s.phase.state === "paused" || s.phase.state === "pause_requested" ? <Button size="sm" variant="outline" onClick={() => control("interrupt")}>Прервать работу</Button> : null}
              {/* Stop the phase: its writers at work are stopped first, then the phase (SMA px_stop); the note says why. */}
              <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => control("stop", { note })}>{t("ckStopPhase")}</Button>
              <Button size="sm" variant="outline" disabled={!note.trim()} onClick={() => control("close", { note })}>{t("ckClose")}</Button>
            </div>
          </div>
        </div>
      );
    }}</Loaded>
  );
}

type TaskView = { displayTitle: string | null; objective: string | null; area: string | null; clarify: { questions?: string[]; answers?: Array<{ question: string; answer: string; by: string }> } | null;
  promise: { given?: string; when?: string; then?: string } | null; ownsPaths: string[]; expectedOutputs: string[]; outOfScope: string[]; blockers: Array<{ taskId: string; state: string; reason: string | null }>;
  drawing: Array<{ path: string; sha256: string | null }>; drawingOk: { at: number; stale: boolean } | null; priority: string; heldUntil: number | null; approach: { approach?: string | null; lesson?: string | null } | null };

const TITLE_MAX = 60;
/** Suggest task words: the task standard said before the PM refuses it — a person's words, no ids or paths, short (~60 characters). */
export function taskWords(title: string): string | null {
  const text = title.trim();
  if (!text) return "Опишите, что изменится для человека";
  if ([...text].length > TITLE_MAX) return `короче: ${[...text].slice(0, TITLE_MAX - 1).join("")}…`;
  if (/[/\\]|\.[a-z]{2,4}\b|[A-Za-z]+-\d+|_/.test(text)) return "без путей и id: что увидит человек";
  return null;
}

export type TaskProposal = { title: string; description: string; promise: string[] };

/**
 * A task's words proposed from one phrase by fixed rules, no model (SMA m_sg_words): the title is the first clause cut
 * to TITLE_MAX with paths and ids stripped; the description is the rest; the promise holds the phrase's «чтобы /
 * so that» and «когда / when … то / then» clauses and its further lines as Given/When/Then lines.
 */
export function proposeTaskWords(phrase: string): TaskProposal {
  const clean = (text: string) => text
    .replace(/\S*[/\\]\S*/g, " ").replace(/\b[A-Za-z]+-\d+\b/g, " ").replace(/[«»"]/g, "").replace(/\s+/g, " ").trim();
  const promise: string[] = [];
  const clauses: string[] = [];
  for (const [index, line] of phrase.split(/\n+/).map((row) => row.trim()).filter(Boolean).entries()) {
    if (index > 0) { promise.push(`Then ${clean(line)}`); continue; }
    let text = line;
    const whenThen = /(?:когда|when)\s+(.+?)\s*[,;]?\s*(?:то|then)\s+(.+)/i.exec(text);
    const soThat = /[,;.]\s*(?:чтобы|so that)\s+(.+)$/i.exec(text);
    if (whenThen) { promise.push(`When ${clean(whenThen[1]!)}, then ${clean(whenThen[2]!)}`); text = text.slice(0, whenThen.index); }
    else if (soThat) { promise.push(`Then ${clean(soThat[1]!)}`); text = text.slice(0, soThat.index); }
    clauses.push(...text.split(/[.;]/).map((clause) => clause.trim()).filter(Boolean));
  }
  const title = clean(clauses[0] ?? "");
  return {
    title: [...title].slice(0, TITLE_MAX).join(""),
    description: clean(clauses.slice(1).join(". ")),
    promise: promise.filter((line) => line.length > 6),
  };
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
export function TasksScreen({ rpc, projectId, runId, hostId }: { rpc: Rpc; projectId: string; runId: string | null; hostId?: string | null }) {
  const [taskId, setTaskId] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [what, setWhat] = useState("");
  const [promise, setPromise] = useState("");
  const [phrase, setPhrase] = useState("");
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
          {shown ? <TaskDetail rpc={rpc} runId={runId} taskId={shown} hostId={hostId ?? null} /> : null}
        </Panel>
      ) : null}
      <Panel title={t("ckNewTask")} testId="ck-new-task">
        {/* One phrase fills title, description and promise by fixed rules; every field stays editable before Send. */}
        <Field label="Фраза" value={phrase} onChange={(value) => { setPhrase(value); const proposal = proposeTaskWords(value); setTitle(proposal.title); setWhat(proposal.description); setPromise(proposal.promise.join("\n")); }} testId="ck-new-task-phrase" />
        <Field label={t("ckNewTaskTitle")} value={title} onChange={setTitle} testId="ck-new-task-title" />
        {hint ? <p className="text-xs text-muted-foreground" data-testid="ck-task-words">{fill("ckSuggestWords", { s: hint })}</p> : null}
        <Field label={t("ckNewTaskWhat")} value={what} onChange={setWhat} multiline />
        <Field label="Обещание" value={promise} onChange={setPromise} multiline testId="ck-new-task-promise" />
        <Button size="sm" disabled={!!hint || what.trim().length < 5} onClick={() => request("task", `${title}\n\n${what}${promise.trim() ? `\n\nОбещание:\n${promise}` : ""}`)}>{t("ckSend")}</Button>
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

function TaskDetail({ rpc, runId, taskId, hostId }: { rpc: Rpc; runId: string; taskId: string; hostId?: string | null }) {
  const navigate = useBbNavigate();
  const task = useLoad(() => rpc.call("cockpit_task", { runId, taskId }) as Promise<TaskView | null>, [runId, taskId]);
  const [correction, setCorrection] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const queue = (action: "hold" | "release" | "priority", priority?: "low" | "normal" | "high" | "urgent") => void rpc.call("cockpit_queue", { runId, taskIds: [taskId], action, ...(priority ? { priority } : {}) }).then(task.reload);
  const okDrawing = () => void rpc.call("cockpit_task_drawing_ok", { runId, taskId }).then(task.reload, (cause: unknown) => setSaid(String(cause)));
  const correct = () => void rpc.call("cockpit_task_correct", { runId, taskId, text: correction }).then(() => { setSaid(t("ckSent")); setCorrection(""); }, (cause: unknown) => setSaid(String(cause)));
  const confirm = () => (task.data?.heldUntil ? queue("release") : setSaid(t("ckPromiseConfirmed")));
  return (
    <Loaded state={task}>{(view) => !view ? <p className="text-sm text-muted-foreground">{t("ckEmpty")}</p> : (
      <div className="space-y-2 text-sm" data-testid="ck-task-detail">
        <p className="font-medium">{view.displayTitle ?? taskId}</p>
        {view.objective ? <p className="text-muted-foreground">{view.objective.slice(0, 600)}</p> : null}
        {/* The task's promise and its «Верно»/«Поправить» (SMA contract summary): the correction goes through the PM, never around him. */}
        {view.promise?.then ? (
          <div className="rounded border border-border/60 p-2" data-testid="ck-promise">
            <p><span className="font-medium">{t("ckPromise")}:</span> {view.promise.then}</p>
            {view.promise.given || view.promise.when ? <p className="text-muted-foreground">{t("ckReproduce")}: {[view.promise.given, view.promise.when].filter(Boolean).join(" · ")}</p> : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={confirm}>{t("ckCorrect_yes")}</Button>
              <input className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-base sm:text-sm" placeholder={t("ckCorrectFix")} value={correction} onChange={(e) => setCorrection(e.target.value)} data-testid="ck-correction" />
              <Button size="sm" variant="outline" disabled={correction.trim().length < 3} onClick={correct}>{t("ckFix")}</Button>
            </div>
          </div>
        ) : null}
        {view.ownsPaths.length || view.expectedOutputs.length ? (
          <Disclosure summary={t("ckFiles")}>
            <ul>{[...view.ownsPaths, ...view.expectedOutputs.map((path) => `→ ${path}`)].map((path) => <li key={path} className="font-mono text-xs">{path}</li>)}</ul>
          </Disclosure>
        ) : null}
        {view.outOfScope.length ? (
          <Disclosure summary={t("ckOutOfScope")}>
            <ul>{view.outOfScope.map((line) => <li key={line}>{line}</li>)}</ul>
          </Disclosure>
        ) : null}
        {view.blockers.length ? (
          <div data-testid="ck-blockers"><p className="font-medium">{t("ckBlockers")}:</p>
            <ul>{view.blockers.map((row) => <li key={row.taskId}>{row.taskId} — {row.state}{row.reason ? ` (${row.reason})` : ""}</li>)}</ul>
          </div>
        ) : null}
        {view.clarify ? (
          <Disclosure summary={t("ckClarify")} open>
            {(view.clarify.questions ?? []).map((question) => <p key={question}>? {question}</p>)}
            {(view.clarify.answers ?? []).map((answer) => <p key={answer.question}>✓ {answer.question} → {answer.answer} <span className="text-xs text-muted-foreground">({answer.by})</span></p>)}
          </Disclosure>
        ) : null}
        {view.drawing.length ? (
          <Disclosure summary={t("ckDrawing")}>
            <ul>{view.drawing.map((row) => <li key={row.path} className="font-mono text-xs">{hostId
              ? <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate.experimental_openFilePreview({ target: { kind: "host", hostId, path: row.path }, location: null })}>{row.path}</button>
              : row.path}</li>)}</ul>
            <div className="mt-1 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={okDrawing} data-testid="ck-drawing-ok">{t("ckDrawingOk")}</Button>
              {view.drawingOk ? <span className="text-xs text-muted-foreground" data-testid="ck-drawing-state">{view.drawingOk.stale ? fill("ckDrawingStale", { d: new Date(view.drawingOk.at).toLocaleDateString() }) : t("ckDrawingOked")}</span> : null}
            </div>
          </Disclosure>
        ) : null}
        {view.approach?.approach ? <p><span className="font-medium">{t("ckApproach")}:</span> {view.approach.approach}{view.approach.lesson ? ` · ${view.approach.lesson}` : ""}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t("ckQueue")}:</span>
          <Button size="sm" variant="outline" onClick={() => queue(view.heldUntil ? "release" : "hold")}>{view.heldUntil ? t("ckRelease") : t("ckHold")}</Button>
          <select aria-label={t("ckPriority")} className="h-8 rounded border border-border bg-background px-1 text-base sm:text-sm" value={view.priority} onChange={(e) => queue("priority", e.target.value as "low" | "normal" | "high" | "urgent")}>
            {["low", "normal", "high", "urgent"].map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
        {said ? <p className="text-xs text-muted-foreground" data-testid="ck-task-said">{said}</p> : null}
      </div>
    )}</Loaded>
  );
}


