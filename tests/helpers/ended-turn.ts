/**
 * The events BB reports for one finished helper turn: the model it ran on, its tokens and the end.
 * A graph with a USD cap holds a step whose cost is not measured (R12), so a fake helper must report tokens.
 */
export function endedTurn(threadId: string, model = "claude-sonnet-5-5") {
  return [
    { type: "turn/started", threadId, seq: 1 },
    { type: "client/thread/start", threadId, seq: 2, createdAt: 1, data: { request: { params: { execution: { model } } } } },
    { type: "thread/tokenUsage/updated", threadId, seq: 3, createdAt: 2, data: { turnId: "t1", tokenUsage: { last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } } },
    { type: "turn/completed", threadId, seq: 4, data: { status: "completed" } },
  ];
}
