/**
 * A `client/turn/requested` the owner started: a person's request, not another agent's message, a system notice or a retry.
 * Live BB stamps ordinary user requests as "unlabeled" too; only a specific kind marks a system message.
 */
export function isOwnerInitiatedTurn(data: Record<string, unknown>): boolean {
  const systemNotice = data.systemMessageKind != null && data.systemMessageKind !== "unlabeled";
  return data.initiator === "user" && !data.senderThreadId && !systemNotice && !data.retryOfRequestId;
}
