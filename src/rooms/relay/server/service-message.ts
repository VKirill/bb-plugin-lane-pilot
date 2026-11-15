/**
 * Lane Pilot's service messages (a writer's question to the PM, the PM's answer to a writer, a relay ask, a merge
 * notice) used to land in a chat as if the owner had typed them. BB's `threads.send` takes `senderThreadId`: the
 * message is then authored by that thread (initiator `agent`, shown as a message from it) and the receiving agent sees
 * `[bb message from thread:<id>]` above the text. The sender must be a live thread of another chat; a thread that is
 * gone makes BB answer `parent_thread_invalid` (subject sender), and the message is then sent without an author
 * rather than lost. `startedOnBehalfOf` is not used for spawns: BB reads it as a seed-only thread that runs no turn.
 */
import { serviceMessageText } from "../../contracts";

type SendMessageApi = { sdk:{ threads:{ send(args:never):Promise<unknown> } } };

export type ServiceMessage = {
  threadId:string;
  text:string;
  mode?:"queue-if-active" | "steer-if-active";
  /** The thread the message comes from; none when Lane Pilot itself is the only author. */
  senderThreadId?:string | null;
};

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The anonymous retry is allowed only for the exact wire shape BB sends when the sender thread is gone:
 * HTTP 400, code `parent_thread_invalid`, `details.subject === "sender"`, `details.reason` of `not_found`/`deleted`
 * (apps/server lifecycle-api-errors.ts `throwSenderThreadInvalid`). Anything else — a plugin's `dispatch_rejected`
 * whose message merely mentions the sender, a parent-subject refusal, an unclassified transport error — is rethrown:
 * a rejection must never be bypassed by guessing at its text.
 */
function senderRejected(cause: unknown): boolean {
  const error = rec(cause);
  if (!error) return false;
  const status = Reflect.get(error, "status") ?? Reflect.get(error, "statusCode");
  if (status !== 400) return false;
  const body = rec(Reflect.get(error, "body")) ?? error;
  if (Reflect.get(body, "code") !== "parent_thread_invalid" && Reflect.get(error, "serverCode") !== "parent_thread_invalid") return false;
  const details = rec(Reflect.get(body, "details")) ?? rec(Reflect.get(error, "details"));
  if (!details || Reflect.get(details, "subject") !== "sender") return false;
  const reason = Reflect.get(details, "reason");
  return reason === "not_found" || reason === "deleted";
}

export async function sendServiceMessage(bb:SendMessageApi, message:ServiceMessage):Promise<unknown> {
  const sender = message.senderThreadId && message.senderThreadId !== message.threadId ? message.senderThreadId : null;
  // A send without a live sender is recorded initiator:"user" — mark it so owner collection and intake never read it as the owner's words.
  const anonymous = { ...message, text: serviceMessageText(message.text) };
  const request = { threadId:message.threadId, mode:message.mode ?? "queue-if-active",
    input:[{ type:"text", text:anonymous.text, mentions:[] }] };
  if (!sender) return bb.sdk.threads.send(request as never);
  try {
    return await bb.sdk.threads.send({ threadId:message.threadId, mode:message.mode ?? "queue-if-active", senderThreadId:sender,
      input:[{ type:"text", text:message.text, mentions:[] }] } as never);
  } catch (cause) {
    if (!senderRejected(cause)) throw cause;
    return bb.sdk.threads.send(request as never);
  }
}
