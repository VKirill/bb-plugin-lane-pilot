import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { getAttempt, getReasoningTrace, getRunSettingsScopes, loadProjectSettings } from "../../storage";
import { listAttemptChanges } from "../../rollback";
import { settingOn } from "@lane-pilot/models";
import { recordSkillSwitchMetric } from "../skill-switch";
import { createSkillMaterializer, recordedMaterializedSkills } from "./skill-materialize";
import { recordedWriterSkills } from "./skill-pick";
import { isNotFound, orMiss, outputText, redactKnown } from "@lane-pilot/kit";
import { scrubQuote } from "../../anamnesis";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { writerMarkers } from "../../tasks";

import type { ServerCore } from "../../contracts/server";
import { onAttemptFinished, type AttemptFinished } from "./attempt-finished";
import { persistTaskFolder, taskFolderRel } from "../../verification";
import type { createWriterSticky } from "./sticky";


/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {

}

/**
 * The writer's own reactions to an attempt's end: the skill-switch metric, the materialized-skill
 * cleanup, the finish scan, and the area record of an accepted task. They stay in this room — unlike
 * the room-named files next to them, the merger keeps them here.
 *
 * Registration order is the run order (attempt-finished.ts). Attempt scope, from createWriterFinish:
 *   1. writer:skill-switch-metric → 2. writer:skill-materialize — the metric accounts the attempt
 *      before its skills leave the worktree (the old finally's order).
 *   3. writer:finish-scan — observational; used to run just before the acceptance receipt, now fires
 *      after it on the same data (it never changed the finish path).
 *   4. writer:failed-lesson — a failed attempt's own LESSON line reaches the reviewed proposals,
 *      like a successful one's (sma ae_harvest).
 * Task scope, from createWriterStart (mountWriterTaskFinished):
 *   5. writer:area-accepted — the area's writer record, after the task's receipts and run refresh.
 */

/** Terminal states that are a failed attempt; a canceled or blocked one has no work to learn from. */
const FAILED_LESSON_STATES = new Set(["validation_failed", "empty_output", "provider_error", "timeout", "internal_error", "error"]);
export function mountWriterAttemptFinished(ctx: ServerCore, services: Services): void {
  const { bb, db } = ctx;
  const skillMaterial = createSkillMaterializer(ctx, (message) => bb.log.info(message));

  // A reload closes this instance's database; recovery in the new instance owns the attempt from then on.
  onAttemptFinished(ctx, async (event) => {
    if (event.scope !== "attempt" || ctx.state.disposed) return;
    try {
      const events = await bb.sdk.threads.events.list({ threadId: event.writerThreadId, limit: "100" } as never).then((r: any) => r?.events ?? [], () => []);
      if (!ctx.state.disposed) {
        recordSkillSwitchMetric(db, {
          attemptId: event.attemptId,
          taskId: event.taskId,
          runId: event.runId,
          projectId: event.projectId,
          events,
          skills: recordedWriterSkills(getReasoningTrace(db, event.attemptId)?.dispatchContext),
          outcome: event.result?.status === "accepted" || (event.result as { state?: unknown } | null)?.state === "accepted" ? "accepted" : "failed",
        });
      }
    } catch (cause) {
      ctx.log(`writer skill switch metric failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (!ctx.state.disposed) await skillMaterial.remove({ attemptId: event.attemptId, hostId: event.config.hostId,
      workspacePath: getAttempt(db, event.attemptId)?.workspace_path ?? null,
      names: recordedMaterializedSkills(getReasoningTrace(db, event.attemptId)?.dispatchContext),
      providerId: getReasoningTrace(db, event.attemptId)?.providerId ?? null });
  }, "writer:skill-metric-and-materialize");

  // A failed attempt's lesson is not lost with it: its own LESSON line (the markers the brief asks for) is
  // filed as a proposal for review — raw failure output stays out of the corpus (sma ae_harvest).
  onAttemptFinished(ctx, async (event) => {
    if (event.scope !== "attempt" || ctx.state.disposed || !event.writerThreadId) return;
    // An accepted attempt's lesson is filed the same way (SMA m_lesson) only where writer.lesson_from_accepted is on; unset, an accepted
    // attempt files nothing and its answer is not read, as before.
    const accepted = event.status === "accepted";
    if (!accepted && !FAILED_LESSON_STATES.has(event.status)) return;
    if (accepted && !settingOn(loadProjectSettings(db, event.projectId, getRunSettingsScopes(db, event.runId))["writer.lesson_from_accepted"])) return;
    try {
      // The read is best effort: a thread that is gone, or a host without the call, has no lesson to file.
      const threadId = event.writerThreadId;
      const answer = outputText(await Promise.resolve().then(() => bb.sdk.threads.output({ threadId })).catch(() => null));
      const lesson = writerMarkers(answer).lesson;
      if (!lesson) return;
      upsertLessonProposal(db as never, event.projectId, {
        rule: lesson, audience: "writer",
        evidence: accepted ? `accepted attempt ${event.attemptId}` : `failed attempt ${event.attemptId}${event.reason ? `: ${String(event.reason).slice(0, 200)}` : ""}`,
      });
    } catch (cause) {
      ctx.log(`writer failed-lesson harvest failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, "writer:failed-lesson");
}

/**
 * OUTCOME.md (SMA k_pl_quick): off unless the global setting `task.outcome_file` is `on`, so a default install writes no
 * new file. When on, written only into a task folder that already exists in the attempt's workspace_path — never
 * created (a removed worktree, or a canceled task whose folder never existed, is left alone, so a later `git worktree add`
 * on a reused path is not blocked). workspace_path is the attempt's own worktree or folder; a merge removes the worktree
 * with the folder inside it, so after a merge the file survives only where the task worked in place. The reason is one
 * line of at most 200 characters through `scrubQuote` (the mask the anamnesis quotes use) after the known-secret mask.
 */
export async function writeTaskOutcome(ctx: Pick<ServerCore, "bb" | "db" | "log">, event: AttemptFinished): Promise<void> {
  const { bb, db } = ctx;
  if (event.scope !== "task" || event.status === "running" || !["accepted", "blocked", "canceled"].includes(event.status)) return;
  try {
    if (String(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)["task.outcome_file"] ?? "off") !== "on") return;
    const attempt = getAttempt(db, event.attemptId);
    const workspace = attempt?.workspace_path ?? null;
    const folder = taskFolderRel(event.taskId);
    if (!workspace || !folder) return;
    const listed = await orMiss(bb.sdk.files.listPaths({ hostId: event.config.hostId, path: `${workspace}/${folder}`, includeFiles: true, includeDirectories: true, includeHidden: true, limit: 1 }), null, isNotFound);
    if (!listed) return;
    const change = listAttemptChanges(db, event.taskId).find((row) => row.attemptId === event.attemptId) ?? listAttemptChanges(db, event.taskId).at(-1);
    const reason = event.reason ? scrubQuote(redactKnown(String(event.reason)), 200) : "";
    const markdown = [
      `# OUTCOME — ${event.taskId}`, "",
      `state: ${event.status}${reason ? ` · ${reason}` : ""}`,
      `merge: ${change?.mergeCommit ?? "-"}`,
      "", "changed:", ...(change?.changed.length ? change.changed.map((file) => `- ${file.status} ${file.path}`) : ["- (none)"]), "",
    ].join("\n");
    await persistTaskFolder({ taskId: event.taskId, outcome: markdown,
      writeFile: async (rel, content) => {
        await bb.sdk.files.write({ hostId: event.config.hostId, rootPath: workspace, path: `${workspace}/${rel}`, content, contentEncoding: "utf8", createParents: false, expectedSha256: null });
      } });
  } catch (cause) {
    ctx.log(`task OUTCOME.md write for ${event.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Task-scope reactions the writer owns; mounted by createWriterStart with its sticky instance. */
export function mountWriterTaskFinished(ctx: ServerCore, _services: Services, sticky: ReturnType<typeof createWriterSticky>): void {
  const { bb, db } = ctx;
  // Quick-task folder (SMA k_pl_quick): at a terminal state the task folder also holds OUTCOME.md — state, reason,
  // changed files, merge commit, checks, rendered from the record. A failed write never fails the attempt.

  // The area's writer record: accepted work makes this thread the area's hot writer for the next task. The same reaction
  // also leaves OUTCOME.md (off by default, see writeTaskOutcome): one subscriber, so the reaction order stays as it was.
  onAttemptFinished(ctx, async (event) => {
    await writeTaskOutcome(ctx, event);
    if (event.scope !== "task" || event.status !== "accepted" || !event.acceptedAttemptId) return;
    return sticky.noteAccepted(event.projectId, event.runId, event.task, event.acceptedAttemptId,
      Array.isArray(event.result?.produced) ? (event.result.produced as unknown[]).filter((path): path is string => typeof path === "string") : [])
      .then(() => undefined, (cause: unknown) => { ctx.log(`area record of ${event.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`); return undefined; });
  }, "writer:area-accepted");
}
