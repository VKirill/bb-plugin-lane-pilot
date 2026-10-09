import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { runOnHost } from "@lane-pilot/host-calls";

/** The brief rides in the fallback writer's first message, next to the contract: it stays small. */
export const HANDOFF_BRIEF_MAX_CHARS = 12_000;

const CONTINUE_INSTRUCTION = "You are continuing an interrupted session of this task. The edits listed are already in the workspace. Do not start over; review them, finish the remaining work, run the checks, end with your summary.";
const STOP_REASON_MAX = 600;
const STATUS_MAX = 3_000;
const COMMAND_MAX = 300;
const OUTPUT_TAIL_MAX = 1_500;
const MESSAGE_MAX = 800;
const MESSAGES_MAX = 2;

export type HandoffFacts = {
  /** Why the interrupted writer stopped, as the attempt recorded it. */
  stopReason: string;
  /** The interrupted writer's thread events, newest first, as the thread lists them. */
  events: readonly unknown[];
  /** `git status --short` and `git diff --stat` of the workspace. */
  gitStatus: string;
};

type ThreadItem = Record<string, unknown>;

/** The item of a completed thread event; null for any other event. */
function itemOf(event: unknown): ThreadItem | null {
  const item = (event as { data?: { item?: unknown } } | null)?.data?.item;
  return item && typeof item === "object" ? item as ThreadItem : null;
}

/** The command's exit status, or null when the event does not carry one. */
function exitOf(item: ThreadItem): number | null {
  const exit = item.exitCode ?? item.exit_code;
  return typeof exit === "number" ? exit : null;
}

/** The command's output, from whichever field the thread's item carries it in. */
function outputOf(item: ThreadItem): string {
  return [item.aggregatedOutput, item.output, item.stdout, item.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

/** The first `max` characters, with a marker when cut. The result is never longer than `max`. */
function head(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The last `max` characters, with a marker when cut. The result is never longer than `max`. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

/**
 * The brief a fallback writer starts with when it continues an interrupted writer's session: the instruction not to start
 * over, the stop reason, the workspace as git sees it, the failing command's output tail and the interrupted writer's last
 * messages. Each part is bounded; the whole stays within `maxChars`, and the least important part (the messages) is cut first.
 */
export function buildHandoffBrief(facts: HandoffFacts, maxChars = HANDOFF_BRIEF_MAX_CHARS): string {
  const items = facts.events.map(itemOf).filter((item): item is ThreadItem => item !== null);
  const failed = items.find((item) => item.type === "commandExecution" && exitOf(item) !== null && exitOf(item) !== 0);
  const messages = items
    .filter((item) => (item.type === "agentMessage" || item.type === "assistantMessage") && typeof item.text === "string" && item.text.trim().length > 0)
    .slice(0, MESSAGES_MAX)
    .map((item) => tail((item.text as string).trim(), MESSAGE_MAX));
  // The status columns lead each line: only the end is trimmed, so the first line keeps its leading space.
  const changes = facts.gitStatus.trimEnd();
  const status = changes.trim() ? head(changes, STATUS_MAX) : "(no uncommitted changes)";
  const parts = [
    CONTINUE_INSTRUCTION,
    `Stop reason: ${head(facts.stopReason, STOP_REASON_MAX)}`,
    `Workspace (git status --short, git diff --stat):\n${status}`,
    failed
      ? `Last failing command (exit ${exitOf(failed)}): ${head(String(failed.command ?? ""), COMMAND_MAX)}\n${tail(outputOf(failed), OUTPUT_TAIL_MAX) || "(no output)"}`
      : "Last failing command: none in the thread's events.",
    messages.length ? `The interrupted writer's last messages (newest first):\n${messages.map((message) => `- ${message}`).join("\n")}` : "",
  ].filter(Boolean);
  return head(parts.join("\n\n"), maxChars);
}

/**
 * Reads the handoff facts from the interrupted writer's thread and its workspace on its host, then builds the brief. A thread
 * whose events or workspace cannot be read still gives a brief: the instruction and the stop reason always go in.
 */
export async function collectHandoffBrief(input: {
  bb: Parameters<typeof listThreadEventsRaw>[0]; host: Parameters<typeof runOnHost>[0];
  hostId: string; threadId: string; workspacePath: string; stopReason: string;
}): Promise<string> {
  const listed = await listThreadEventsRaw(input.bb, { threadId:input.threadId, order:"desc", limit:"300" } as never).catch(() => null);
  const ran = await runOnHost(input.host, { hostId:input.hostId, cwd:input.workspacePath, command:"git status --short; git diff --stat",
    timeoutSec:30, timeoutMs:30_000 }).catch(() => null);
  const gitStatus = ran && ran.exitCode === 0 ? ran.stdout : `(git status did not answer${ran ? `: exit ${ran.exitCode}` : ""})`;
  return buildHandoffBrief({ stopReason:input.stopReason, events:listed?.ok ? listed.events : [], gitStatus });
}
