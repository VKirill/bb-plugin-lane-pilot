import { getRun, getRunWriterHost, getTask } from "../../storage";
import { taskFamily } from "../../runs";
import { hostContract } from "../../contracts";
import { runOnHost } from "@lane-pilot/host-calls";
import { binaryFileCommand, binaryFileFingerprint } from "../stages";
import { appendPart, getPhase, listParts, savePhase as savePhaseRow } from "../store";
import { createCandidates } from "./candidate";
import { PhaseRefusal, type DriverTools } from "./driver-tools";
import type { Phase, PhaseRecord, PhaseStage, TaskFact } from "../logic";
import { phaseFolder, renderBook, sha256 } from "../logic";

/**
 * The phase's own reads and its book: the files of the PM's run (their hashes, their text), the documents written back, the
 * book parts and the phase's facts. Everything here is about the phase's state and its workspace, so it changes with the state
 * machine and lives with it.
 */
export function installDocs(tools: DriverTools): Pick<DriverTools,
  "mustGet" | "savePhase" | "book" | "move" | "facts" | "readFile" | "readText" | "writeDocs" | "writeBook" | "redoId" | "pmCheckoutPath" | "candidates"> {
  const { services, db, bb, now } = tools;

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
    const ran = await runOnHost(bb.hosts.experimental_client({ contract: hostContract }), { hostId, cwd: run.writer_workspace_path, command, timeoutSec: 30 }).catch(() => null);
    return ran && ran.exitCode === 0 ? binaryFileFingerprint(ran.stdout) : null;
  }

  async function readText(phase: Phase, path: string): Promise<string | null> {
    try {
      const file = await services.readWriterWorkspaceFile({ threadId: phase.pmThreadId, projectId: phase.projectId, path, offset: 0, maxLines: 2000 }) as { content?: string };
      return typeof file.content === "string" ? file.content : null;
    } catch { return null; }
  }

  /** Writes phase documents and planning marks into the project, then commits exactly those files (SMA: Commit the plans / drawing / REVIEW / STATE). */
  async function writeDocs(phase: Phase, files: Array<{ path: string; content: string }>, message: string): Promise<{ written: string[]; commit: string | null }> {
    if (!phase.runId || !files.length) return { written: [], commit: null };
    const run = getRun(db, phase.runId);
    const hostId = getRunWriterHost(db, phase.runId);
    if (!run?.writer_workspace_path || !hostId) return { written: [], commit: null };
    const edits = [];
    for (const file of files) {
      const current = await readText(phase, file.path);
      edits.push({ path: file.path, expectedSha256: current === null ? null : sha256(current), content: file.content });
    }
    const host = bb.hosts.experimental_client({ contract: hostContract });
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const written = result.writes.filter((row) => row.status === "applied").map((row) => row.path);
    if (!written.length) return { written, commit: null };
    const committed = await host.call("gitCommitDocs", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, paths: written, message }, { hostId, timeoutMs: 60_000 }).catch(() => null);
    return { written, commit: committed?.commit ?? null };
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
    const result = await host.call("writePhaseBook", { requestedHostId: hostId, projectCwd: run.writer_workspace_path, previewSha256: sha256(JSON.stringify(edits)), edits }, { hostId, timeoutMs: 30_000 });
    const written = result.writes.find((row) => row.path === path);
    if (result.status === "applied" && written?.afterSha256) savePhaseRow(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written.afterSha256, at: now() } }, at: now() });
    else if (result.status === "conflict") savePhaseRow(db, phase.id, { record: { ...phase.record, bookWritten: { seq: last.seq, sha256: written?.beforeSha256 ?? "", at: now() } }, at: now() });
  }

  /** The facts of each piece: the latest attempt of its task family in the phase's run and the receipts of its stages. */
  function facts(phase: Phase): Map<string, TaskFact> {
    const out = new Map<string, TaskFact>();
    const issued = phase.record.execution?.issued ?? {};
    if (!phase.runId) return out;
    const attempts = db.prepare("SELECT task_id, state FROM lane_pilot_attempt WHERE run_id=? ORDER BY created_at, attempt_no").all(phase.runId) as Array<{ task_id: string; state: string }>;
    const receipts = db.prepare("SELECT task_id, stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND stage_id IN ('plan-fact','verification','code-critique','browser-qa')").all(phase.runId) as Array<{ task_id: string; stage_id: string; state: string }>;
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
    const taken = runId ? (db.prepare("SELECT id FROM lane_pilot_task WHERE run_id=?").all(runId) as Array<{ id: string }>).map((row) => row.id).filter((id) => taskFamily(id) === pieceId) : [];
    let n = 2;
    while (taken.includes(`${pieceId}.${n}`)) n += 1;
    return `${pieceId}.${n}`;
  }

  /** The PM chat's checkout: the folder a piece runs in when the planner left its task's project_cwd out. */
  async function pmCheckoutPath(phase: Phase): Promise<string | null> {
    const pm = await bb.sdk.threads.get({ threadId: phase.pmThreadId }).catch(() => null) as { environmentId?: string } | null;
    const env = pm?.environmentId ? await bb.sdk.environments.get({ environmentId: pm.environmentId }).catch(() => null) as { path?: string } | null : null;
    return typeof env?.path === "string" && env.path ? env.path : null;
  }

  function candidates(phase: Phase) {
    const hostId = phase.runId ? getRunWriterHost(db, phase.runId) : null;
    return hostId ? createCandidates(bb.hosts.experimental_client({ contract: hostContract }) as never, hostId) : null;
  }

  return { mustGet, savePhase, book, move, facts, readFile, readText, writeDocs, writeBook, redoId, pmCheckoutPath, candidates };
}
