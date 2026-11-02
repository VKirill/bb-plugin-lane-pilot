import { runOnHost } from "@lane-pilot/host-calls";
import type { NodeExecutor, WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../core/server";
import type { ChainRuntime } from "./workflow-runtime";

/**
 * The action `telegram.send_file` of the graph `telegram-send`: one file goes to a chat by the owner's Telegram client on the
 * sending machine (`tg send-file`, ~/toolkit/telegram), with no agent. The client looks back 50 messages first and answers
 * `already_there` for a file of the same name the owner already sent, so a retry never sends twice. Anything else (no client, an
 * error, an unparsable answer) is `failed` and the graph hands the send to its agent step, which reads the chat before it sends.
 * invoice-send 2026-11-02: the agent step took 3–4 minutes and ≈ $1.2 per send; this takes seconds.
 */
type Row = Record<string, unknown>;
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export function sendFileCommand(params: { chat: string; file_path: string; caption?: string }): string {
  return ["\"$HOME/toolkit/telegram/tg\"", "send-file", shellQuote(params.chat), shellQuote(params.file_path),
    ...(params.caption ? ["--caption", shellQuote(params.caption)] : []), "--execute"].join(" ");
}

/** The graph's output from what `tg send-file` printed (its last JSON line). */
export function sendFileOutput(exitCode: number, stdout: string): { status: "sent" | "unsure" | "failed"; message_id: string; message_url: string; reason: string } {
  const line = stdout.trim().split("\n").reverse().find((row) => row.trim().startsWith("{"));
  let answer: Row = {};
  try { answer = line ? JSON.parse(line) as Row : {}; } catch { answer = {}; }
  const id = text(answer.message_id), url = text(answer.message_url);
  if (exitCode === 0 && (answer.status === "sent" || answer.status === "already_there") && id) {
    return { status: "sent", message_id: id, message_url: url, reason: answer.status === "already_there" ? `already in the chat (${text(answer.date)}), not sent again` : "" };
  }
  if (exitCode === 0 && answer.status === "sent_unverified" && id) return { status: "unsure", message_id: id, message_url: url, reason: "sent, the read-back did not show the file" };
  return { status: "failed", message_id: "", message_url: "", reason: text(answer.error) ? `tg: ${text(answer.error)} ${text(answer.detail)}`.trim() : `tg exited ${exitCode}` };
}

export function registerTelegramActions(engine: WorkflowEngine, ctx: ServerCore): void {
  engine.register<ChainRuntime>("telegram.send_file", {
    reentrant: true,
    run: async (c) => {
      const node = c.node as Extract<typeof c.node, { type: "action" }>;
      const params = c.template(node.params) as Row;
      const host = text(params.host), chat = text(params.chat), file = text(params.file_path);
      if (!host || !chat || !file) return { output: { status: "failed", message_id: "", message_url: "", reason: "no machine, chat or file to send" } };
      try {
        const ran = await runOnHost(ctx.host, { hostId: host, cwd: "/", command: sendFileCommand({ chat, file_path: file, caption: text(params.caption) }), timeoutSec: 120 }) as { exitCode?: number; stdout?: string };
        return { output: sendFileOutput(ran.exitCode ?? 1, ran.stdout ?? "") };
      } catch (cause) {
        return { output: { status: "failed", message_id: "", message_url: "", reason: `the machine could not run tg: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 300) } };
      }
    },
  } as NodeExecutor<ChainRuntime>);
}
