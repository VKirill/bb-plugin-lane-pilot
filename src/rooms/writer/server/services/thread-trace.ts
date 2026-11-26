import { createHash } from "node:crypto";
import type { ThreadEventLike, ThreadToolTraceEntry } from "../../models/thread-summary";

const argsSha256 = (value: unknown): string =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? {})).digest("hex");

/**
 * The tool calls of a thread's `item/completed` events as trace entries: `server/tool` for a tool or MCP call, the
 * command's first word for a shell command. Arguments are hashed, never stored; results are not read.
 */
export function threadToolTrace(events: readonly ThreadEventLike[]): ThreadToolTraceEntry[] {
  const trace: ThreadToolTraceEntry[] = [];
  const ordered = [...events].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  for (const event of ordered) {
    if (String(event.type ?? "") !== "item/completed") continue;
    const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
    const item = data.item;
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, unknown>;
    const type = String(call.type ?? "");
    if (type === "commandExecution") {
      const command = typeof call.command === "string" ? call.command.trim() : "";
      if (!command) continue;
      const exit = typeof call.exitCode === "number" ? call.exitCode : null;
      trace.push({ tool: command.split(/\s+/)[0]!, argsSha256: argsSha256(command), ok: call.status !== "failed" && (exit === null || exit === 0) });
    } else if (type === "toolCall" || type === "mcpToolCall") {
      const name = [call.server, call.tool].filter((part): part is string => typeof part === "string" && part !== "").join("/") || "tool";
      const failed = call.status === "failed" || (typeof call.error === "string" && call.error.trim() !== "");
      trace.push({ tool: name, argsSha256: argsSha256(call.arguments), ok: !failed });
    }
  }
  return trace;
}
