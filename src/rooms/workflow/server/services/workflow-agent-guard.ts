import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bestEffort, stringAt, valueAt } from "@lane-pilot/kit";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { BudgetStopError, type StepContext, type ToolCallRecord, type Usage } from "@lane-pilot/workflow-engine";
import { stopThreadTree } from "../../../platform/server";
import { spentBy, type TrackedThread } from "./workflow-agent-facts";

function toolCallFromItem(item: Record<string, unknown>): ToolCallRecord | null {
  const type = String(item.type ?? "");
  switch (type) {
    case "commandExecution":
      return { tool: "shell", args: { command: item.command ?? "" } };
    case "toolCall":
    case "mcpToolCall": {
      const name = [item.server, item.tool].filter(Boolean).join("/") || String(item.name ?? "tool");
      return { tool: name, args: item.arguments ?? item.input ?? {} };
    }
    case "fileRead":
      return { tool: "fileRead", args: { path: item.path ?? "" } };
    case "fileChange":
      return { tool: "fileChange", args: item.changes ?? [] };
    case "search":
      return { tool: "search", args: { mode: item.mode ?? "content", query: item.query ?? "" } };
    case "webSearch":
      return { tool: "webSearch", args: { query: item.query ?? "" } };
    case "webFetch":
      return { tool: "webFetch", args: { url: item.url ?? "" } };
    default:
      return null;
  }
}

export function extractCompletedToolCalls(events: readonly unknown[], seenSeq: number): { calls: ToolCallRecord[]; maxSeq: number; completedTurns: number } {
  const calls: ToolCallRecord[] = [];
  let maxSeq = seenSeq;
  let completedTurns = 0;
  const ordered = [...events].sort((a, b) => Number(valueAt(a, "seq") ?? 0) - Number(valueAt(b, "seq") ?? 0));
  for (const ev of ordered) {
    const seq = Number(valueAt(ev, "seq") ?? 0);
    if (Number.isFinite(seq) && seq <= seenSeq) continue;
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    const type = stringAt(ev, "type") ?? "";
    const data = valueAt(ev, "data") as Record<string, unknown> | undefined;
    if (type === "turn/completed") {
      completedTurns += 1;
      continue;
    }
    if (type === "item/completed" && data?.item && typeof data.item === "object") {
      const parsed = toolCallFromItem(data.item as Record<string, unknown>);
      if (parsed) calls.push(parsed);
    }
  }
  return { calls, maxSeq, completedTurns };
}

/**
 * Waits for a workflow agent thread while checking post-turn budgets and tool-call repeat loops after every turn.
 * If a turn limit or stuck repeat fires, immediately stops the thread tree and throws `BudgetStopError`.
 */
export async function waitAndGuardThread(input: {
  bb: BbPluginApi;
  threadId: string;
  label: string;
  tracked: readonly TrackedThread[];
  since?: number;
  shouldStop: () => string | null;
  givesUpOn?: (notice: string) => boolean;
  checkTurn?: StepContext["checkTurn"];
  trackChild?: StepContext["trackChild"];
  usageCtx: { requestedProvider: string | null; requestedModel: string | null; answeredProvider: string | null; answeredModel: string | null };
}): Promise<void> {
  const { bb, threadId, checkTurn } = input;
  const untrack = input.trackChild?.({ threadId });
  let seenSeq = 0;
  let completedTurns = 0;
  let turnGuardError: BudgetStopError | null = null;
  let scanning = false;

  const pollTurns = async (finalScan: boolean) => {
    if (!checkTurn || scanning || turnGuardError) return;
    scanning = true;
    try {
      let listed: unknown = null;
      try {
        listed = await bestEffort(
          bb.log,
          "workflow turn events",
          bb.sdk.threads.events.list({
            threadId,
            order: "asc",
            limit: "100",
            ...(seenSeq > 0 ? { afterSeq: String(seenSeq) } : {}),
            types: ["item/completed", "turn/completed", "thread/tokenUsage/updated"],
          }),
          null,
        );
      } catch {
        return;
      }
      if (!Array.isArray(listed) || listed.length === 0) return;
      const extracted = extractCompletedToolCalls(listed, seenSeq);
      seenSeq = extracted.maxSeq;
      const prevTurns = completedTurns;
      completedTurns += extracted.completedTurns;
      if (!extracted.calls.length && extracted.completedTurns === 0) return;

      // On intermediate turns (before final settle) check both usage + tool calls; on final turn let execStep enforce single-turn run-level limits.
      const checkUsage = !finalScan || completedTurns > 1 || prevTurns > 0;
      let usage: Usage | undefined;
      if (checkUsage) {
        usage = await spentBy(bb, input.tracked, input.usageCtx);
      }
      const decision = await checkTurn({
        ...(usage ? { usage, cumulative: true } : {}),
        ...(extracted.calls.length ? { toolCalls: extracted.calls } : {}),
      });
      if (decision.stop) {
        await stopThreadTree(bb, threadId);
        turnGuardError = new BudgetStopError(decision, usage);
      }
    } finally {
      scanning = false;
    }
  };

  const timer = checkTurn ? setInterval(() => { void pollTurns(false); }, 300) : undefined;
  try {
    await waitThreadIdle(
      bb,
      threadId,
      input.label,
      undefined,
      input.since,
      () => (turnGuardError ? turnGuardError.message : input.shouldStop()),
      input.givesUpOn,
    );
    await pollTurns(true);
    if (turnGuardError) throw turnGuardError;
  } catch (cause) {
    untrack?.();
    if (turnGuardError) throw turnGuardError;
    if (cause instanceof BudgetStopError) throw cause;
    throw cause;
  } finally {
    if (timer) clearInterval(timer);
    untrack?.();
  }
}
