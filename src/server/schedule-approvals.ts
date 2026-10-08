import { createHash } from "node:crypto";
import { getActivation, type LanePilotDatabase } from "../database";
import type { ScheduleTask } from "../schedule/model";
import type { OwnerAsk } from "./owner-ask";

/**
 * A schedule runs without anyone watching it, with the owner's accounts and machines. A schedule an agent creates, changes or
 * deletes (the PM tools, never the board) therefore needs the owner's yes in a form in the PM chat, a form that also reaches the
 * phone. A yes covers that one definition and lasts ten minutes; the agent calls the tool again and the change goes through.
 * The owner's own screen (the board, `bb lane-pilot schedule` in their terminal) asks nothing: the RPCs behind it are kept
 * from an agent's shell by the guard instead (lane-stack/hooks/guard_shell.py), as for the settings that decide what agents may run.
 */
export const SCHEDULE_APPROVAL_TTL_MS = 10 * 60_000;
const ASK_TIMEOUT_MS = 60 * 60_000;
const REASK_AFTER_MS = 60 * 60_000;

export type ScheduleAction = "create" | "update" | "delete";
export type ApprovalVerdict = { ok: true } | { ok: false; message: string };

/** The most a question's `detail` carries (src/owner-ask.ts clips at the same number): a description longer than this is not shown, it is refused. */
export const FORM_DETAIL_MAX = 4000;

/** Characters the eye cannot see (controls, zero-width, bidi marks) are written out, so a yes is never given to text that hides something. */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/gu;
const visible = (text: string): string => text.replace(INVISIBLE, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);

/**
 * What the owner is shown of a task: the whole command or text, the machine, the names of the accounts. Never a value, never a
 * shortened text (audit 2026-10-08 round 4, item 17: the owner's yes covers every character, 32 000 of them in a command).
 */
export function describeTask(task: ScheduleTask): string {
  if (task.kind === "script") return [`Script on machine ${task.hostId}, folder ${task.cwd}, ${task.command.length} characters, shown in full:`, visible(task.command), task.env.length ? `Env Catalog names given to it: ${task.env.join(", ")}` : ""].filter(Boolean).join("\n");
  if (task.kind === "errand") return [`Agent errand${task.authorized ? " (may change things in the owner's accounts)" : " (reads and reports only)"}${task.model ? `, model ${task.model}` : ""}, ${task.task.length} characters, shown in full:`, visible(task.task), task.accounts.length ? `Env Catalog accounts: ${task.accounts.join(", ")}` : ""].filter(Boolean).join("\n");
  return `Workflow ${task.workflowId} with inputs ${visible(JSON.stringify(task.inputs))}`;
}

export const approvalHash = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);

export function createScheduleApprovals(deps: { db: LanePilotDatabase; ownerAsk: OwnerAsk | undefined; log: (message: string) => void }) {
  const approved = new Map<string, number>();
  const open = new Map<string, number>();
  const quietUntil = new Map<string, number>();

  const threadFor = (projectId: string, fallback: string): string => getActivation(deps.db, projectId)?.pm_thread_id ?? fallback;

  /** Passes a change the owner just allowed (spent by this call); otherwise puts it to the owner, once an hour per definition. */
  function gate(input: { threadId: string; projectId: string; action: ScheduleAction; hash: string; name: string; summary: string }, now = Date.now()): ApprovalVerdict {
    if ((approved.get(input.hash) ?? 0) > now) { approved.delete(input.hash); return { ok: true }; }
    const head = `A schedule change by an agent needs the owner's confirmation (${input.action} «${input.name}»).`;
    if ((open.get(input.hash) ?? -Infinity) + ASK_TIMEOUT_MS + 60_000 > now) return { ok: false, message: `${head} A question is open in the PM chat; once the owner answers yes, call this tool again with the same arguments.` };
    if ((quietUntil.get(input.hash) ?? 0) > now) return { ok: false, message: `${head} The owner declined this a short while ago; do not try to work around it.` };
    if (!deps.ownerAsk) return { ok: false, message: `${head} No form can be shown here: ask the owner to make the change on the schedule board.` };
    const verb = input.action === "create" ? "create" : input.action === "update" ? "change" : "delete";
    const detail = [input.summary, "", "A schedule runs by itself, with your accounts and machines, and nobody watches it. If you did not ask for this, say no.",
      `A yes is for exactly this and lasts ${SCHEDULE_APPROVAL_TTL_MS / 60_000} minutes: the agent calls the tool again.`].join("\n");
    // The owner must read all of what they allow: a description the form cannot carry is not cut, it is not asked at all.
    if (detail.length > FORM_DETAIL_MAX) return { ok: false, message: `${head} The description is ${detail.length} characters, too long to be shown in full in the owner's form (the most is ${FORM_DETAIL_MAX}), and the owner does not allow what they cannot read. Shorten it (move the long part into a script file on the machine and schedule a short command that runs it), or ask the owner to make this schedule on the schedule board.` };
    open.set(input.hash, now);
    void deps.ownerAsk.askInBackground(threadFor(input.projectId, input.threadId), {
      source: "secret",
      question: `Allow the agent to ${verb} the schedule «${input.name}»?`,
      detail,
      options: ["Allow", "Do not allow"],
      allowText: false,
    }, (answer) => {
      open.delete(input.hash);
      if (answer.outcome === "answered" && answer.choice?.id === "1") {
        approved.set(input.hash, Date.now() + SCHEDULE_APPROVAL_TTL_MS);
        deps.log(`Lane Pilot: the owner allowed an agent to ${verb} the schedule «${input.name}» (project ${input.projectId})`);
      } else quietUntil.set(input.hash, Date.now() + REASK_AFTER_MS);
    }, { timeoutMs: ASK_TIMEOUT_MS }).then((shown) => { if (!shown) open.delete(input.hash); }).catch(() => open.delete(input.hash));
    return { ok: false, message: `${head} The owner was asked in the PM chat; once they allow it, call this tool again with the same arguments.` };
  }

  return { gate };
}
export type ScheduleApprovals = ReturnType<typeof createScheduleApprovals>;
