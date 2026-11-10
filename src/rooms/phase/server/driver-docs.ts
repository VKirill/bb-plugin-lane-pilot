import { getRun, getRunWriterHost, getTask, listRunAttemptStates, listStageReceipts, listTaskIdsForRun } from "../../storage";
import { taskFamily } from "@lane-pilot/contracts";
import { hostContract } from "../../contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { binaryFileCommand, binaryFileFingerprint } from "../stages";
import { appendPart, getPhase, listParts, savePhase as savePhaseRow } from "../store";
import { createCandidates } from "./candidate";
import { PhaseRefusal, STAGE_RU, type DriverBase } from "./driver-tools";
import type { Phase, PhaseRecord, PhaseStage, TaskFact } from "../logic";
import { sha256Hex, isNotFound, orMiss, bestEffort } from "@lane-pilot/kit";
import { nextAction, phaseFolder, renderBook } from "../logic";
import { sameStateIgnoringTime, stateBlockText } from "../stages";

/**
 * The phase's own reads and its book: the files of the PM's run (their hashes, their text), the documents written back, the
 * book parts and the phase's facts. Everything here is about the phase's state and its workspace, so it changes with the state
 * machine and lives with it.
 */
/** The first line of SPEC.md / PLAN.md / VERIFICATION.md as the command writes them (phase.doc_files): what makes the file provably its own. */
export const GENERATED = "<!-- lp:generated -->";
export type Docs = ReturnType<typeof installDocs>;
export function installDocs(base: DriverBase) {
  const { services, db, bb, now } = base;

  function mustGet(id: string) {
    const phase = getPhase(db, id);
    if (!phase) throw new PhaseRefusal(`no phase ${id}`);
    return phase;
  }

  function savePhase(id: string, patch: Parameters<typeof savePhaseRow>[2]) {
    savePhaseRow(db, id, patch);
  }

  function book(phase: Pick<Phase, "id">, section: Parameters<typeof appendPart>[2]["section"], kind: string, text: string) {
    appendPart(db, phase.id, { section, kind, text, at: now() });
  }

  function move(phase: Phase, stage: PhaseStage, record: PhaseRecord, why: string) {
    savePhaseRow(db, phase.id, { stage, record, at: now() });
    book(phase, "decisions", "stage", `${phase.stage} → ${stage}: ${why}`);
    // SMA k_pl_state: where the phase was opened with phase.doc_files on, a stage move refreshes the command's block of STATE.md.
    // Otherwise a move writes nothing into the project (as it always was).
    if (record.docFiles === true) stateQueue = stateQueue.then(() => bestEffort(bb.log, "phase STATE.md write", markState({ ...phase, stage, record }), null));
  }

  /** Serialized STATE.md writes: moves are sync, the write is not — callers in a test can drain `stateDone()`. */
  let stateQueue: Promise<unknown> = Promise.resolve();
  const stateDone = () => stateQueue;

  /** The command-owned block of STATE.md for a move (SMA k_pl_state), only where phase.doc_files is on. Only where planning
   *  files already live: a project without STATE.md or ROADMAP.md gets none (the close's own rule). Nothing is written when the
   *  block would differ only by a timestamp, and nothing outside the block is ever touched (see stateBlockText). */
  async function markState(phase: Phase): Promise<void> {
    if (phase.record.docFiles !== true) return;
    const items = phase.record.plan?.items ?? [];
    const issuedWave = Math.max(0, ...items.filter((item) => phase.record.execution?.issued[item.id]).map((item) => item.wave));
    const f = facts(phase);
    const sections = {
      Position: [`phase ${phase.record.roadmapRow ?? phase.id}`, `stage ${phase.stage}`, ...(issuedWave ? [`wave ${issuedWave}`] : [])],
      Decisions: [...(phase.record.context?.decisions ?? []).map((id) => `locked ${id}`),
        ...listParts(db, phase.id).filter((part) => part.section === "decisions").slice(-5).map((part) => part.text.slice(0, 160))],
      Blockers: [...(phase.record.questions ?? []).filter((question) => question.blocking && !question.answer).map((question) => `question ${question.id}: ${question.text.slice(0, 160)}`),
        ...items.filter((item) => ["blocked", "canceled"].includes(f.get(item.id)?.state ?? "")).map((item) => `piece ${item.id} ${f.get(item.id)!.state}`),
        ...Object.entries(phase.record.execution?.issueErrors ?? {}).map(([piece, why]) => `piece ${piece}: ${why.slice(0, 160)}`)],
      Session: [`pm ${phase.pmThreadId}`, `activity ${new Date(now()).toISOString()}`],
    };
    await writeStateBlock(phase, { phase: phase.record.roadmapRow ?? phase.id, stage: phase.stage }, sections, `phase ${phase.id}: STATE.md at ${phase.stage}`);
  }

  /** STATE.md with `marks` in its header and `sections` in the command's block (docFiles only; the callers check). Created only
   *  where ROADMAP.md exists; a failed read or a block the command cannot place is logged and nothing is written. */
  async function writeStateBlock(phase: Phase, marks: Record<string, string>, sections: Record<string, string[]>, message: string): Promise<void> {
    const path = ".agents/planning/STATE.md";
    const got = await readDoc(phase, path);
    if (got.kind === "failed" || (got.kind === "ok" && got.truncated)) { bb.log.warn(`phase STATE.md not written: ${got.kind === "failed" ? got.why : "longer than the read window"}`); return; }
    const previous = got.kind === "ok" ? got.text : null;
    if (previous === null) {
      const roadmap = await readDoc(phase, ".agents/planning/ROADMAP.md");
      if (roadmap.kind !== "ok") return;
    }
    const next = stateBlockText(previous, marks, sections, true);
    if ("refused" in next) { bb.log.warn(`phase STATE.md not written: ${next.refused}`); book(phase, "decisions", "note", next.refused); return; }
    if (sameStateIgnoringTime(previous, next.text)) return;
    await writeDocs(phase, [{ path, content: next.text }], message);
  }

  /** SPEC.md / PLAN.md / VERIFICATION.md (docFiles only): the file is the command's while it is absent, or still carries the
   *  generated marker and the sha the record kept from the last write. Otherwise the new text goes to `<name>.new.md` and the
   *  book says so. Unchanged text writes nothing (so commits nothing). */
  async function writeGenerated(phase: Phase, path: string, body: string, message: string): Promise<void> {
    const content = `${GENERATED}\n${body}`;
    const got = await readDoc(phase, path);
    if (got.kind === "failed" || (got.kind === "ok" && got.truncated)) { bb.log.warn(`phase ${path} not written: ${got.kind === "failed" ? got.why : "longer than the read window"}`); return; }
    let target = path;
    if (got.kind === "ok") {
      if (got.text === content) return;
      const mine = got.text.includes(GENERATED) && mustGet(phase.id).record.docShas?.[path] === sha256Hex(got.text);
      if (!mine) {
        target = path.replace(/\.md$/, ".new.md");
        const aside = await readDoc(phase, target);
        if (aside.kind === "failed" || (aside.kind === "ok" && (aside.truncated || !aside.text.includes(GENERATED)))) {
          book(phase, "decisions", "note", `${path.split("/").at(-1)} exists and is not the command's, and ${target.split("/").at(-1)} exists too: the new text is not written`);
          return;
        }
        if (aside.kind === "ok" && aside.text === content) return;
      }
    }
    const done = await writeDocs(phase, [{ path: target, content }], message);
    if (done.shas[target] && target === path) {
      const live = mustGet(phase.id);
      savePhaseRow(db, phase.id, { record: { ...live.record, docShas: { ...(live.record.docShas ?? {}), [path]: done.shas[target]! } }, at: now() });
    }
    if (target !== path && done.written.includes(target)) book(phase, "decisions", "note", `${path.split("/").at(-1)} already exists and was changed by hand (or is not the command's): the new text is in ${target.split("/").at(-1)} next to it`);
  }

  /** A file of the project as the PM's run sees it (its frozen writer workspace), for the signature of a stage's documents. */
  async function readFile(phase: Phase, path: string): Promise<{ sha256: string; sizeBytes: number }> {
    try {
      return await services.readWriterWorkspaceFile({ threadId: phase.pmThreadId, projectId: phase.projectId, path, offset: 0, maxLines: 2000 }) as { sha256: string; sizeBytes: number };
    } catch (cause) {
      // A binary file the stage itself produced (the drawing's PNG): the text reader refuses it, so its hash and size come from the host.
      if (cause instanceof Error && cause.message.includes("lane_pilot_read_binary_rejected")) {
        const fingerprint = await binaryFingerprint(phase, path);
        if (fingerprint) return fingerprint;
      }
      throw new PhaseRefusal(`cannot read ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function binaryFingerprint(phase: Phase, path: string): Promise<{ sha256: string; sizeBytes: number } | null> {
    const command = binaryFileCommand(path);
    const run = phase.runId ? getRun(db, phase.runId) : null;
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    if (!command || !run?.writer_workspace_path || !hostId) return null;
    const ran = await bestEffort(bb.log, "phase binary fingerprint", runOnHost(bb.hosts.experimental_client({ contract: hostContract }), { hostId, cwd: run.writer_workspace_path, command, timeoutSec: 30 }), null);
    return ran && ran.exitCode === 0 ? binaryFileFingerprint(ran.stdout) : null;
  }

  type DocRead = { kind: "ok"; text: string; truncated: boolean } | { kind: "absent" } | { kind: "failed"; why: string };
  /** A project file as the PM's run sees it, told apart: there, not there, or unreadable (a longer file comes back cut: `truncated`). */
  async function readDoc(phase: Phase, path: string): Promise<DocRead> {
    try {
      const file = await services.readWriterWorkspaceFile({ threadId: phase.pmThreadId, projectId: phase.projectId, path, offset: 0, maxLines: 2000 }) as { content?: string; truncated?: boolean };
      return typeof file.content === "string" ? { kind: "ok", text: file.content, truncated: file.truncated === true } : { kind: "failed", why: "the read returned no text" };
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : String(cause);
      return /ENOENT|no such file|not found|does not exist/i.test(why) ? { kind: "absent" } : { kind: "failed", why };
    }
  }

  const readFailed = new Set<string>();
  /** The text of a project file, or null when it is absent or cannot be read; a read that failed for another reason than
   *  absence is logged once per file and reason. */
  async function readText(phase: Phase, path: string): Promise<string | null> {
    const got = await readDoc(phase, path);
    if (got.kind === "ok") return got.text;
    if (got.kind === "failed" && !readFailed.has(`${path}:${got.why}`)) { readFailed.add(`${path}:${got.why}`); bb.log.warn(`phase read of ${path} failed: ${got.why}`); }
    return null;
  }

  /** Writes phase documents and planning marks into the project, then commits exactly those files (SMA: Commit the plans / drawing / REVIEW / STATE). */
  async function writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[]; commit: string | null; shas: Record<string, string> }> {
    if (!phase.runId || !files.length) return { written: [], commit: null, shas: {} };
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return { written: [], commit: null, shas: {} };
    const edits = [];
    for (const file of files) {
      const current = await readText(phase, file.path);
      edits.push({ path: file.path, expectedSha256: current === null ? null : sha256Hex(current), content: file.content });
    }
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const applied = result.writes.filter((row) => row.status === "applied");
    const written = applied.map((row) => row.path);
    const shas = Object.fromEntries(applied.filter((row) => typeof row.afterSha256 === "string").map((row) => [row.path, row.afterSha256 as string]));
    if (!written.length) return { written, commit: null, shas };
    // SMA k_wp_commit: the commit happens only where the project allows committing docs (phase.commit_docs, on by default).
    if (phase.record.commitDocs === false) return { written, commit: null, shas };
    const committed = await bestEffort(bb.log, "phase docs commit", host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, paths: written, message }, { hostId, timeoutMs: 60_000 }), null);
    return { written, commit: committed?.commit ?? null, shas };
  }

  /** Commits files that already exist in the project (the designer's drawing and its contract), by their explicit paths (SMA k_wd_c1). */
  async function commitFiles(phase: Phase, paths: readonly string[], message: string): Promise<{ commit: string | null }> {
    if (!phase.runId || !paths.length) return { commit: null };
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return { commit: null };
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const committed = await bestEffort(bb.log, "phase manifest commit", host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, paths: paths.slice(0, 40), message }, { hostId, timeoutMs: 60_000 }), null);
    return { commit: committed?.commit ?? null };
  }

  /** The pause handoff (SMA k_c_pause): HANDOFF.json for the machine and PAUSE.md for the person, committed best-effort. */
  async function pauseHandoff(phase: Phase): Promise<void> {
    if (phase.state !== "paused" || !phase.runId) return;
    const parts = listParts(db, phase.id);
    const last = parts.at(-1);
    const next = nextAction(phase, facts(phase));
    const issued = phase.record.execution?.issued ?? {};
    const f = facts(phase);
    const pieces = (phase.record.plan?.items ?? []).map((item) => ({ id: item.id, taskId: issued[item.id] ?? f.get(item.id)?.taskId ?? null, state: f.get(item.id)?.state ?? "not issued" }));
    const handoff = {
      phaseId: phase.id, stage: phase.stage, state: phase.state, goal: phase.goal,
      nextAction: { key: next.key, text: next.text },
      pieces,
      openQuestions: (phase.record.questions ?? []).filter((question) => !question.answer).map((question) => ({ id: question.id, stage: question.stage, text: question.text })),
      awaitingOwnerWord: next.key.includes(":word:") ? next.key : null,
      candidate: phase.record.candidate ? { branch: phase.record.candidate.branch, verified: phase.record.candidate.verified ?? null } : null,
      book: last ? { seq: last.seq, hash: last.hash } : null,
      pausedAt: now(),
      resume: `lane_pilot_phase {action:"resume", phaseId:"${phase.id}"}`,
    };
    const pause = [
      `# Пауза — фаза ${phase.id}: ${phase.title}`, "",
      `Остановились на стадии «${STAGE_RU[phase.stage] ?? phase.stage}» (${phase.stage}).`, "",
      `Что дальше: ${next.text.split("\n")[0]?.slice(0, 600) ?? "—"}`, "",
      pieces.length ? `Кусочки плана: ${pieces.map((piece) => `${piece.id} — ${piece.state}`).join("; ")}.` : "Кусочков плана пока нет.", "",
      `Как продолжить: lane_pilot_phase {action:"resume", phaseId:"${phase.id}"} — фаза пойдёт дальше сама.`,
      `Машинная выгрузка лежит рядом, в HANDOFF.json.`, "",
    ].join("\n");
    const written = await writeDocs(phase, [
      { path: `${phaseFolder(phase.id)}/HANDOFF.json`, content: JSON.stringify(handoff, null, 2) },
      { path: `${phaseFolder(phase.id)}/PAUSE.md`, content: pause },
    ], `phase ${phase.id}: pause handoff`).catch(() => null);
    if (written?.written.length) book(phase, "decisions", "handoff", `the pause handoff is written and committed (${written.written.join(", ")})`);
  }

  /** Writes the phase book to the project (.agents/phases/<id>/BOOK.md) when it grew; a phase without a run binding keeps it on the hub only. */
  async function writeBook(phase: Phase): Promise<void> {
    const parts = listParts(db, phase.id);
    const last = parts.at(-1);
    if (!last || phase.record.bookWritten?.seq === last.seq || !phase.runId) return;
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return;
    const path = `${phaseFolder(phase.id)}/BOOK.md`;
    const content = renderBook(phase, parts);
    const edits = [{ path, expectedSha256: phase.record.bookWritten?.sha256 ?? null, content }];
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256Hex(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const written = result?.writes?.find((row) => row.path === path);
    if (result.status === "applied" && written?.afterSha256) savePhaseRow(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written.afterSha256, at: now() } }, at: now() });
    else if (result.status === "conflict") savePhaseRow(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written?.beforeSha256 ?? "", at: now() } }, at: now() });
  }

  /** The facts of each piece: the latest attempt of its task family in the phase's run and the receipts of its stages. */
  function facts(phase: Phase): Map<string, TaskFact> {
    const out = new Map<string, TaskFact>();
    const issued = phase.record.execution?.issued ?? {};
    if (!phase.runId) return out;
    const attempts = listRunAttemptStates(db, phase.runId);
    const receipts = listStageReceipts(db, phase.runId)
      .filter((row) => ["plan-fact","verification","code-critique","browser-qa"].includes(row.stageId))
      .map((row) => ({ task_id: row.taskId, stage_id: row.stageId, state: row.state }));
    for (const [pieceId, taskId] of Object.entries(issued)) {
      const family = taskFamily(taskId);
      const mine = attempts.filter((row) => taskFamily(row.task_id) === family);
      const latestTask = mine.at(-1)?.task_id ?? taskId;
      const stage = (id: string) => (receipts.find((row) => row.task_id === latestTask && row.stage_id === id)?.state ?? null) as never;
      const contract = getTask(db, latestTask)?.contract as { qa_cases?: unknown[] } | undefined;
      out.set(pieceId, { taskId: latestTask, state: mine.at(-1)?.state ?? null, planFact: stage("plan-fact"), verification: stage("verification"), codeCritique: stage("code-critique"), browserQa: stage("browser-qa"),
        qaPlanned: Array.isArray(contract?.qa_cases) && contract.qa_cases.length > 0 });
    }
    return out;
  }

  /** The next free redo id of a piece's family in the run: piece.2, piece.3, … */
  function redoId(pieceId: string, runId: string | null): string {
    const taken = runId ? listTaskIdsForRun(db, runId).filter((id) => taskFamily(id) === pieceId) : [];
    let n = 2;
    while (taken.includes(`${pieceId}.${n}`)) n += 1;
    return `${pieceId}.${n}`;
  }

  /** The drawing's hash: the paths' current file hashes in path order — the same computation drawing() confirmed (SMA p5_design). */
  async function drawingSha(phase: Phase, paths: readonly string[]): Promise<string> {
    const hashes: string[] = [];
    for (const path of paths) { const file = await readFile(phase, path); hashes.push(`${path}:${file.sha256}`); }
    return sha256Hex(hashes.join("\n"));
  }

  /** The PM chat's checkout: the folder a piece runs in when the planner left its task's project_cwd out. */
  async function pmCheckoutPath(phase: Phase): Promise<string | null> {
    const pm = await orMiss(bb.sdk.threads.get({ threadId: phase.pmThreadId }), null, isNotFound) as { environmentId?: string } | null;
    const env = pm?.environmentId ? await orMiss(bb.sdk.environments.get({ environmentId: pm.environmentId }), null, isNotFound) as { path?: string } | null : null;
    return typeof env?.path === "string" && env.path ? env.path : null;
  }

  function candidates(phase: Phase) {
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    return hostId ? createCandidates(bb.hosts.experimental_client({ contract: hostContract }) as never, hostId, bb.log) : null;
  }

  return { mustGet, savePhase, book, move, facts, readFile, readText, readDoc, writeStateBlock, writeGenerated, writeDocs, commitFiles, pauseHandoff, writeBook, redoId, pmCheckoutPath, candidates, drawingSha, markState, stateDone };
}
