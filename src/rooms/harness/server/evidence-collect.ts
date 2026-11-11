import { inventory, parseEdits, renderExperienceMarkdown, renderThreadEvents, type ThreadEventLike } from "@lane-pilot/harness-core";
import { type ServerCore } from "../../contracts/server";
import { sliceAttemptEvents, type AttemptEvidence, type LibraryEntry } from "./evidence";
import { listExperiences } from "./store";
import { latestStageResultJson, listAttemptEvidenceRows } from "../../storage";

const EVENT_PAGE = 100;
const EVENT_PAGES_MAX = 60;
const TRAJECTORY_MAX_CHARS = 120_000;

/** The evidence a round reads: the threads' rendered trajectories, the finished attempts' records, the library of past experiences. */
export function createEvidence(ctx: ServerCore) {
  const { bb, db } = ctx;

  /** Every event of a thread, oldest first, at most `maxEvents`; a failure is logged once and gives what was read so far. */
  async function listThreadEvents(threadId: string, maxEvents = Number.POSITIVE_INFINITY): Promise<unknown[]> {
    const events: unknown[] = [];
    let cursor = 0;
    for (let pages = 0; pages < EVENT_PAGES_MAX; pages++) {
      let listed: unknown;
      try {
        listed = await bb.sdk.threads.events.list({ threadId, order: "asc", limit: String(EVENT_PAGE), ...(cursor > 0 ? { afterSeq: String(cursor) } : {}) } as never);
      } catch (cause) {
        ctx.log(`harness: events of ${threadId} could not be read after ${events.length}: ${cause instanceof Error ? cause.message : String(cause)}`);
        break;
      }
      if (!Array.isArray(listed)) { ctx.log(`harness: events of ${threadId} came back as ${listed === null ? "null" : typeof listed}`); break; }
      if (listed.length === 0) break;
      events.push(...listed);
      if (events.length >= maxEvents) break;
      const last = Number((listed[listed.length - 1] as { seq?: unknown })?.seq ?? 0);
      if (!Number.isFinite(last) || last <= cursor || listed.length < EVENT_PAGE) break;
      cursor = last;
    }
    return events.slice(0, maxEvents);
  }

  /** The rendered trajectory of one thread, cut to one task's turns when a task id is given (sticky writers share a thread). */
  async function trajectory(threadId: string, taskId?: string): Promise<{ events: number; sliced: number; text: string }> {
    const events = await listThreadEvents(threadId);
    const sliced = taskId ? sliceAttemptEvents(events as ThreadEventLike[], taskId) : events as ThreadEventLike[];
    return { events: events.length, sliced: sliced.length, text: renderThreadEvents(sliced, { maxChars: TRAJECTORY_MAX_CHARS }) };
  }

  /** The area's recent finished attempts with everything the editor may cite. */
  async function collectEvidence(projectId: string, area: string, writerKey: string, limit: number, sinceMs: number, filter?: { attemptIds?: string[] }): Promise<AttemptEvidence[]> {
    const rows = listAttemptEvidenceRows(db, { projectId, sinceMs, area, writerKey, attemptIds: filter?.attemptIds, limit });
    const receipt = { get: (runId: string, taskId: string, stageId: string) => ({ result_json: latestStageResultJson(db, runId, taskId, stageId) }) };
    const out: AttemptEvidence[] = [];
    for (const row of rows) {
      const parse = (json: string | null | undefined): Record<string, unknown> | null => { try { return json ? JSON.parse(json) as Record<string, unknown> : null; } catch { return null; } };
      const trace = parse(row.trace);
      const dispatch = (trace?.dispatchContext ?? null) as AttemptEvidence["dispatch"] & { skillPick?: { skills?: string[] }; harness?: { id?: string; arm?: string } } | null;
      const acceptance = parse((receipt.get(row.runId, row.taskId, "acceptance-receipt") as { result_json: string | null } | undefined)?.result_json);
      const verification = parse((receipt.get(row.runId, row.taskId, "verification") as { result_json: string | null } | undefined)?.result_json);
      const critique = parse((receipt.get(row.runId, row.taskId, "code-critique") as { result_json: string | null } | undefined)?.result_json);
      const events = row.threadId ? sliceAttemptEvents(await listThreadEvents(row.threadId) as ThreadEventLike[], row.taskId) : null;
      out.push({
        attemptId: row.id, taskId: row.taskId, attemptNo: row.attemptNo, state: row.state, reason: row.reason, createdAt: row.createdAt,
        contract: parse(row.contract) ?? {},
        dispatch: dispatch ? { rulesText: dispatch.rulesText, memoryText: dispatch.memoryText, promptChars: dispatch.promptChars, skills: dispatch.skillPick?.skills, harness: dispatch.harness } : null,
        events: events as AttemptEvidence["events"],
        output: typeof acceptance?.output === "string" ? acceptance.output : null,
        verification: (Array.isArray(verification?.verification) ? verification!.verification : Array.isArray(acceptance?.verification) ? acceptance!.verification : []) as AttemptEvidence["verification"],
        critique: critique as AttemptEvidence["critique"],
      });
    }
    return out;
  }

  function libraryEntries(projectId: string, area: string): LibraryEntry[] {
    return listExperiences(db, projectId, area).map((row) => ({
      id: row.harnessId, tree: row.harness.tree, createdAt: row.createdAt, state: row.harness.state,
      experienceMd: renderExperienceMarkdown({ title: `${row.harness.area || "(whole project)"} v${row.harness.version} (${row.harness.state}${row.harness.reason ? `: ${row.harness.reason}` : ""})`, adopted: row.harness.id, inventory: inventory(row.harness.tree), why: row.harness.notes ?? "", rows: parseEdits(`<edits>${row.editsMd}</edits>`), experience: row.cue && row.lesson && row.evidence ? { cue: row.cue, lesson: row.lesson, evidence: row.evidence, confidence: (row.confidence as "high" | "medium" | "low" | null) ?? "" } : null }),
    }));
  }

  return { listThreadEvents, trajectory, collectEvidence, libraryEntries };
}
