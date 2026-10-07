/**
 * Lane Pilot's service messages (a writer's question to the PM, the PM's answer to a writer, a relay ask, a merge
 * notice) used to land in a chat as if the owner had typed them. BB's `threads.send` takes `senderThreadId`: the
 * message is then authored by that thread (initiator `agent`, shown as a message from it) and the receiving agent sees
 * `[bb message from thread:<id>]` above the text. The sender must be a live thread of another chat; a thread that is
 * gone makes BB answer `parent_thread_invalid` (subject sender), and the message is then sent without an author
 * rather than lost. `startedOnBehalfOf` is not used for spawns: BB reads it as a seed-only thread that runs no turn.
 */
type SendMessageApi = { sdk:{ threads:{ send(args:never):Promise<unknown> } } };

export type ServiceMessage = {
  threadId:string;
  text:string;
  mode?:"queue-if-active" | "steer-if-active";
  /** The thread the message comes from; none when Lane Pilot itself is the only author. */
  senderThreadId?:string | null;
};

function senderRejected(cause:unknown):boolean {
  if (!cause || typeof cause !== "object") return false;
  const parts = [Reflect.get(cause, "message"), Reflect.get(cause, "code")];
  try { parts.push(JSON.stringify(Reflect.get(cause, "body") ?? "")); } catch { /* an unprintable body says nothing */ }
  return /parent_thread_invalid|sender thread|"subject":"sender"/i.test(parts.map(String).join(" "));
}

export async function sendServiceMessage(bb:SendMessageApi, message:ServiceMessage):Promise<unknown> {
  const sender = message.senderThreadId && message.senderThreadId !== message.threadId ? message.senderThreadId : null;
  const request = { threadId:message.threadId, mode:message.mode ?? "queue-if-active",
    input:[{ type:"text", text:message.text, mentions:[] }] };
  if (!sender) return bb.sdk.threads.send(request as never);
  try {
    return await bb.sdk.threads.send({ ...request, senderThreadId:sender } as never);
  } catch (cause) {
    if (!senderRejected(cause)) throw cause;
    return bb.sdk.threads.send(request as never);
  }
}
