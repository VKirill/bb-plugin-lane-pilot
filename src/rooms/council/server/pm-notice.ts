/** One PM-chat notice when a council session writes a decision or ends without one. */
import { sendServiceMessage } from "../../platform/server";

export type CouncilNoticeKv = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
};

export type CouncilNoticeSend = {
  sdk: { threads: { send: (request: never) => Promise<unknown> } };
  storage: { kv: CouncilNoticeKv };
};

export function councilNoticeKey(councilId: string, state: string): string {
  return `pm-notice:council:${councilId}:${state}`;
}

export function councilDecisionText(input: {
  id: string;
  question: string;
  decisionPath: string;
  nextTasks: Array<{ title: string; toAgent?: string | null }>;
}): string {
  const tasks = input.nextTasks.length
    ? input.nextTasks.map((task) => `- ${task.title}${task.toAgent ? ` → ${task.toAgent}` : ""}`).join("\n")
    : "- (none)";
  return [
    `Council ${input.id} decided.`,
    `Question: ${input.question}`,
    `Decision page: ${input.decisionPath}`,
    `Next tasks:\n${tasks}`,
    "Dispatch the tasks it names, or report the decision to the owner.",
  ].join("\n");
}

export async function sendCouncilNotice(input: {
  bb: CouncilNoticeSend;
  pmThreadId: string;
  councilId: string;
  state: string;
  text: string;
  log: (message: string) => void;
}): Promise<boolean> {
  const key = councilNoticeKey(input.councilId, input.state);
  if (await input.bb.storage.kv.get(key)) return false;
  await input.bb.storage.kv.set(key, Date.now() as never).catch(() => undefined);
  try {
    await sendServiceMessage(input.bb, { threadId: input.pmThreadId, text: input.text, label: "Lane Pilot · council" });
    return true;
  } catch (cause) {
    input.log(`Lane Pilot council ${input.councilId}: PM notice not sent: ${cause instanceof Error ? cause.message : String(cause)}`);
    return false;
  }
}
