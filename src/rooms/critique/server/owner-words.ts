import { TURN_REQUESTED, ownerMessagesOf } from "../../anamnesis";
import type { EventLike, ThreadLike } from "../../anamnesis";
import { getRun, taskCreatedAt } from "../../storage";
import type { LanePilotDatabase } from "../../storage";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const MAX_OWNER_WORDS = 3;
const EVENT_PAGE = 50;
const MAX_PAGES = 10;

/**
 * The owner's own messages in the PM thread of a run, written before the task was created (newest last, at most 3).
 * The cutoff is the task's creation, not the run's: one run carries several dispatches, and a later task must not be judged
 * against the words that asked for an earlier one.
 * The plan critic sets its paraphrase of the plan beside them so a contract that misread the owner is itself a finding.
 * The filter is the shared one (`ownerMessagesOf`, anamnesis): a person's `client/turn/requested` in a visible top-level
 * thread.  Anything unreadable means no owner words, never a failed
 * critique — the PM thread can be gone, hidden or a CLI run without one.
 */
export async function ownerWordsOfRun(input: { bb: BbPluginApi; db: LanePilotDatabase; runId: string; taskId?: string }): Promise<string[]> {
  try {
    const run = getRun(input.db, input.runId);
    const threadId = run?.pm_thread_id;
    if (!threadId) return [];
    const thread = await input.bb.sdk.threads.get({ threadId }) as ThreadLike | null;
    if (!thread?.id) return [];
    const before = (input.taskId ? taskCreatedAt(input.db, input.taskId) : null) ?? run!.created_at;
    const list = input.bb.sdk.threads.events.list;
    const picked: string[] = []; // events arrive newest first; reversed at the end so the newest is last
    let beforeSeq: string | undefined;
    for (let page = 0; page < MAX_PAGES && picked.length < MAX_OWNER_WORDS; page++) {
      const events = await list({
        threadId, types: [TURN_REQUESTED], order: "desc", limit: String(EVENT_PAGE),
        ...(beforeSeq ? { beforeSeq } : {}),
      });
      if (!Array.isArray(events) || !events.length) break;
      for (const event of events as EventLike[]) {
        if (typeof event?.createdAt !== "number" || event.createdAt >= before) continue;
        for (const message of ownerMessagesOf(event, thread)) {
          picked.push(message.text);
          if (picked.length >= MAX_OWNER_WORDS) break;
        }
        if (picked.length >= MAX_OWNER_WORDS) break;
      }
      const seqs = events.map((row) => Number((row as { seq?: unknown }).seq)).filter((seq) => Number.isFinite(seq));
      const next = Math.min(...seqs);
      if (!Number.isFinite(next) || events.length < EVENT_PAGE) break;
      if (beforeSeq !== undefined && next >= Number(beforeSeq)) break;
      beforeSeq = String(next);
    }
    return picked.reverse();
  } catch (cause) {
    input.bb.log.warn(`plan-critique: owner words unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    return [];
  }
}
