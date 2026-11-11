import { sha256Hex, bestEffort, isNotFound, orMiss } from "@lane-pilot/kit";
import { bundledAgents } from "../../contracts";
import { markUatLine, oneLine, parseState, roadmapAnalysis, roadmapNumberingGaps, roadmapSection, stateBlockSections, stateBlockText, stateHasHeader, STATE_MANUAL, uatState } from "../stages";
import { phaseFolder } from "../logic";
import { listPhases, savePhase } from "../store";
import { PhaseRefusal } from "./driver-tools";
import type { MethodsTools } from "./driver-methods";
import type { Phase, PhaseRecord } from "../logic";

type Reported = { phaseId: string; by?: string };
export type CompensateInput = Reported & { note: string };
export type UatLineInput = Reported & { line: number; result: "pass" | "fail"; note?: string };

/** Reading the phase's world: one UAT line answered, open UAT lines, STATE.md, ROADMAP.md, the planning files' health, and the
 *  compensation that reverts accepted pieces. */
export function installInspectMethods(tools: MethodsTools) {
  const { ctx, services, db, bb, now } = tools;
  const { mustGet, book, facts, readText, readDoc, writeDocs } = tools;

  /** A person answers one UAT line at a time, pass or fail, by its number (SMA p5_uat_line, d_phase_uat); every answer is recorded. */
  async function uatLine(input: UatLineInput): Promise<Phase> {
    const phase = mustGet(input.phaseId);
    const lines = phase.record.uat?.lines;
    if (!lines?.length) throw new PhaseRefusal(`phase ${phase.id} has no UAT lines yet: they are numbered when the UAT session opens at acceptance`);
    const line = lines.find((row) => row.n === input.line);
    if (!line) throw new PhaseRefusal(`no UAT line ${input.line}: the lines are 1 to ${lines.length}`);
    const record: PhaseRecord = { ...phase.record, uat: { ...phase.record.uat!, lines: lines.map((row) => row.n === input.line
      ? { ...row, state: input.result === "pass" ? "passed" as const : "failed" as const, ...(input.note?.trim() ? { note: input.note.trim().slice(0, 600) } : { note: undefined }), by: input.by ?? "owner", at: now() } : row) } };
    book(phase, "acceptance", "uat_line", `UAT line ${input.line} (${line.pieceId}): ${input.result}${input.note ? ` — ${input.note}` : ""} by ${input.by ?? "owner"}`);
    savePhase(db, phase.id, { record, at: now() });
    // With phase.doc_files on, the written document follows the record once UAT.md is on disk (d_phase_uat): the numbered line is
    // marked there too, every other byte of the file stays (CRLF included). A file that cannot be read is left alone.
    const uat = record.uat!;
    if (phase.record.docFiles === true && uat.sha256 && uat.path) {
      const got = await readDoc(phase, uat.path);
      const marked = got.kind === "ok" && !got.truncated ? markUatLine(got.text, input.line, input.result === "pass", input.note) : null;
      if (got.kind === "failed") ctx.log(`phase UAT line not written: ${got.why}`);
      if (got.kind === "ok" && marked !== null && marked !== got.text) {
        await bestEffort(ctx.log, "phase uat line write", writeDocs(phase, [{ path: uat.path, content: marked }], `phase ${phase.id}: UAT line ${input.line} ${input.result}`), null);
        savePhase(db, phase.id, { record: { ...mustGet(phase.id).record, uat: { ...mustGet(phase.id).record.uat!, sha256: sha256Hex(marked) } }, at: now() });
      }
    }
    return mustGet(phase.id);
  }
  /** Open acceptance items across all phases (SMA k_t_audit_uat): every phase's UAT.md parsed for open and failed lines. */
  async function uatOpen(input: { projectId?: string }): Promise<Array<{ phaseId: string; state: "open" | "failed"; line: string }>> {
    const out: Array<{ phaseId: string; state: "open" | "failed"; line: string }> = [];
    for (const row of listPhases(db, { projectId: input.projectId, limit: 200 })) {
      const path = row.record.uat?.path;
      if (!path) continue;
      const text = await readText(row, path);
      if (!text) continue;
      const state = uatState(text);
      for (const line of state.open) out.push({ phaseId: row.id, state: "open", line });
      for (const line of state.failed) out.push({ phaseId: row.id, state: "failed", line });
    }
    return out;
  }

  /** STATE.md read and edited (SMA k_t_state). Who calls it: `bb lane-pilot phase state`, from a shell (the owner: no thread) or from a
   *  BB thread (an agent: the CLI passes the calling thread). An agent reads and edits the phases of its own thread's project only; a
   *  call without a thread may name any project. An explicit command, so it works without phase.doc_files; the flags edit only the
   *  command's block (`manual:` lines in Decisions and Blockers) and the front-matter keys — never a byte a person wrote. Every flag is
   *  one line: a newline would inject header lines or a heading. */
  async function state(input: { phaseId?: string; projectId?: string; set?: string; decision?: string; blocker?: string; callerThreadId?: string }): Promise<{ text: string; marks: Record<string, string>; sections: Record<string, string[]> }> {
    for (const [flag, value] of [["--set", input.set], ["--decision", input.decision], ["--blocker", input.blocker]] as const)
      if (value !== undefined && /[\r\n]/.test(value)) throw new PhaseRefusal(`${flag} takes one line: a line break would write lines of its own into STATE.md`);
    let mark: [string, string] | null = null;
    if (input.set !== undefined) {
      const found = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(input.set);
      if (!found) throw new PhaseRefusal("--set takes key=value, the key made of letters, digits, «_», «.» and «-»");
      mark = [found[1]!, found[2]!.trim().slice(0, 200)];
    }
    const callerProject = input.callerThreadId
      ? ((await orMiss(bb.sdk.threads.get({ threadId: input.callerThreadId }), null, isNotFound)) as { projectId?: unknown } | null)?.projectId
      : undefined;
    if (input.callerThreadId && typeof callerProject !== "string") throw new PhaseRefusal("the calling thread has no project: STATE.md is not edited through it");
    const phase = input.phaseId ? mustGet(input.phaseId) : listPhases(db, { projectId: input.projectId ?? (callerProject as string | undefined), limit: 1 }).at(-1);
    if (!phase) throw new PhaseRefusal("no phase to read STATE.md through");
    if (callerProject && phase.projectId !== callerProject) throw new PhaseRefusal("a thread reaches the phases of its own project only");
    const path = ".agents/planning/STATE.md";
    const got = await readDoc(phase, path);
    if (got.kind === "failed") throw new PhaseRefusal(`STATE.md cannot be read: ${got.why}`);
    const previous = got.kind === "ok" ? got.text : null;
    if (!mark && !input.decision?.trim() && !input.blocker?.trim()) {
      const parsed = parseState(previous ?? "");
      return { text: previous ?? "", marks: parsed.marks, sections: parsed.sections };
    }
    if (got.kind === "ok" && got.truncated) throw new PhaseRefusal("STATE.md is longer than the read window: it is not edited through the command");
    // STATE.md is created only where planning files already live (the close's own rule); the flags never invent one.
    if (previous === null && (await readText(phase, ".agents/planning/ROADMAP.md")) === null)
      throw new PhaseRefusal("the project has no planning STATE.md and no ROADMAP.md: nothing edits it into being");
    if (mark && previous !== null && !stateHasHeader(previous)) throw new PhaseRefusal("STATE.md has no front matter to hold key=value: the header is written by the close; use --decision / --blocker");
    const own = stateBlockSections(previous);
    const sections: Record<string, string[]> = {};
    if (input.decision?.trim()) sections.Decisions = [...own.Decisions ?? [], `${STATE_MANUAL}${oneLine(input.decision, 300)}`];
    if (input.blocker?.trim()) sections.Blockers = [...own.Blockers ?? [], `${STATE_MANUAL}${oneLine(input.blocker, 300)}`];
    const next = stateBlockText(previous, mark ? { [mark[0]]: mark[1] } : {}, sections);
    if ("refused" in next) throw new PhaseRefusal(next.refused);
    await writeDocs(phase, [{ path, content: next.text }], `phase ${phase.id}: STATE.md edited by command`);
    const text = (await readText(phase, path)) ?? "";
    return { text, ...parseState(text) };
  }

  /** The roadmap read with the disk (SMA k_t_roadmap): one section by row, or rows ticked without SUMMARY.md,
   *  phase folders with no row and the next open row. */
  async function roadmap(input: { phaseId?: string; projectId?: string; row?: string }): Promise<{ text: string | null; section?: string | null; analysis?: { tickedWithoutSummary: string[]; foldersWithoutRow: string[]; next: { n: string; name: string; goal: string } | null } }> {
    const phase = input.phaseId ? mustGet(input.phaseId) : listPhases(db, { projectId: input.projectId, limit: 1 }).at(-1);
    if (!phase) throw new PhaseRefusal("no phase to read the roadmap through");
    const text = await readText(phase, ".agents/planning/ROADMAP.md");
    if (text === null) throw new PhaseRefusal("the project has no .agents/planning/ROADMAP.md");
    if (input.row) return { text, section: roadmapSection(text, input.row) };
    const rows = listPhases(db, { projectId: phase.projectId, limit: 200 });
    const analysis = roadmapAnalysis(text, await Promise.all(rows.map(async (row) => ({ id: row.id, row: row.record.roadmapRow, hasSummary: !!(await readText(row, `${phaseFolder(row.id)}/SUMMARY.md`)) }))));
    return { text, analysis };
  }

  /** The planning files' health check (SMA k_t_validate): roadmap numbering, disk against roadmap, installed agents.
   *  Every finding is one line; an empty list means healthy. */
  async function validate(input: { projectId?: string; phaseId?: string }): Promise<{ findings: string[] }> {
    const phase = input.phaseId ? mustGet(input.phaseId) : listPhases(db, { projectId: input.projectId, limit: 1 }).at(-1);
    if (!phase) throw new PhaseRefusal("no phase to read the planning files through");
    const findings: string[] = [];
    const text = await readText(phase, ".agents/planning/ROADMAP.md");
    if (text === null) findings.push("the project has no .agents/planning/ROADMAP.md");
    else {
      findings.push(...roadmapNumberingGaps(text));
      const rows = listPhases(db, { projectId: phase.projectId, limit: 200 });
      const analysis = roadmapAnalysis(text, await Promise.all(rows.map(async (row) => ({ id: row.id, row: row.record.roadmapRow, hasSummary: !!(await readText(row, `${phaseFolder(row.id)}/SUMMARY.md`)) }))));
      findings.push(...analysis.tickedWithoutSummary.map((row) => `ticked without SUMMARY.md: ${row}`));
      findings.push(...analysis.foldersWithoutRow.map((id) => `phase folder with no roadmap row: ${id}`));
    }
    for (const id of Object.keys(bundledAgents)) {
      const got = await readDoc(phase, `.claude/agents/${id}.md`);
      if (got.kind === "absent") findings.push(`bundled agent not installed: ${id}`);
    }
    return { findings };
  }

  /** Compensates the phase's own effects: each accepted piece is reverted (git revert through the merge lock), newest first. */
  async function compensate(input: CompensateInput): Promise<{ phase: Phase; results: Array<{ taskId: string; state: string; detail?: string }> }> {
    const phase = mustGet(input.phaseId);
    const f = facts(phase);
    const accepted = [...f.values()].filter((fact) => fact.state === "accepted").reverse();
    const results: Array<{ taskId: string; state: string; detail?: string }> = [];
    for (const fact of accepted) {
      const outcome = await services.rollback.revert(fact.taskId).catch((cause: unknown) => ({ state: "error", detail: cause instanceof Error ? cause.message : String(cause) }) as never);
      const state = String((outcome as { state?: unknown }).state ?? "unknown");
      results.push({ taskId: fact.taskId, state, ...((outcome as { detail?: string }).detail ? { detail: (outcome as { detail?: string }).detail } : {}) });
    }
    book(phase, "decisions", "compensated", `${input.note}: ${results.map((row) => `${row.taskId} ${row.state}`).join(", ") || "nothing accepted to revert"}`);
    return { phase: mustGet(phase.id), results };
  }

  return { uatLine, uatOpen, state, roadmap, validate, compensate };
}
