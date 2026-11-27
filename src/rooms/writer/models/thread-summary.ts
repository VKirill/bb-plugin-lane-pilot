
/**
 * A writer thread's events (`bb.sdk.threads.events.list`) rendered in one readable grammar:
 *
 *   [USER] …                 what the writer was told (the brief, a feedback turn)
 *   [ASSISTANT] …            what it answered
 *   [REASONING] …            its visible reasoning summary
 *   [ACTION] shell: …        a command, an edit, a read, a search, a tool call
 *   [OBSERVATION] …          what came back; `[OBSERVATION ERROR]` when the command or tool failed
 *   [ERROR] …                a provider or system error of the turn
 *   [HARNESS] …              the runtime itself: compaction, background work, turn ends, this renderer's truncation
 *
 * Every event is rendered; only an individual observation is clipped (`obsTrunc`), and the whole text is cut in the
 * middle when it exceeds `maxChars`, with a marker that names the cut so a reader does not mistake it for the writer's.
 */
export type ThreadEventLike = { type?: unknown; seq?: unknown; data?: unknown };

const clip = (value: unknown, n: number): string => {
  const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return s.length <= n ? s : `${s.slice(0, n)} …[+${s.length - n} chars clipped]`;
};

/** A feedback digest stays inside this. A longer one is cut at the end; the raw observation is never copied. */
export const ATTEMPT_DIGEST_MAX = 2_000;

/** The most used tool names, at most ten, the rest counted: «shell x3, edit x2, … +4 more». */
function toolsLine(tools: ReadonlyMap<string, number>): string {
  const ranked = [...tools].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "(none)";
  const shown = ranked.slice(0, 10).map(([name, count]) => `${clip(name, 40)} x${count}`);
  return `${shown.join(", ")}${ranked.length > 10 ? ` +${ranked.length - 10} more` : ""}`;
}

/**
 * What a later attempt needs of a thread: what was done, what failed, which check, which files.
 * Observations are not copied, so a long log cannot land in the next prompt.
 */
export function summarizeThreadEvents(events: readonly ThreadEventLike[], options: { maxChars?: number } = {}): string {
  const did: string[] = [];
  const failed: string[] = [];
  const files = new Set<string>();
  const tools = new Map<string, number>();
  let check = "";
  const ordered = [...events].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  for (const event of ordered) {
    const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
    if (String(event.type ?? "") !== "item/completed" || !data.item || typeof data.item !== "object") continue;
    const item = data.item as Record<string, unknown>;
    const type = String(item.type ?? "");
    // The frame in words (SMA m_ss_frame_summary): which tools the session used, counted per call name.
    const tool = type === "commandExecution" ? "shell" : type === "fileChange" ? "edit" : type === "fileRead" ? "read" : type === "search" ? "search"
      : type === "toolCall" || type === "mcpToolCall" ? [item.server, item.tool].filter(Boolean).join("/") || "tool" : null;
    if (tool) tools.set(tool, (tools.get(tool) ?? 0) + 1);
    if (type === "fileChange") {
      const paths = (Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : []).map((change) => String(change.path ?? "")).filter(Boolean);
      for (const path of paths) files.add(path);
      if (paths.length) did.push(`edit ${paths.join(", ")}`);
    } else if (type === "fileRead" && typeof item.path === "string" && item.path) {
      did.push(`read ${item.path}`);
    } else if (type === "commandExecution") {
      const command = String(item.command ?? "").trim();
      const exit = typeof item.exitCode === "number" ? item.exitCode : null;
      const bad = item.status === "failed" || (exit !== null && exit !== 0);
      if (command) did.push(`shell ${command}`);
      if (bad && command) {
        failed.push(exit !== null ? `${command} (exit ${exit})` : command);
        if (!check) check = command;
      }
    }
  }
  const text = [
    `Did: ${did.slice(0, 8).join("; ") || "(nothing recorded)"}`,
    `Failed: ${failed.slice(0, 4).join("; ") || "(nothing recorded)"}`,
    `Check: ${check || "(none)"}`,
    `Files: ${[...files].slice(0, 12).join(", ") || "(none)"}`,
    // After Files and capped, so a long tool list can never push Files out of the cut below.
    `Tools: ${toolsLine(tools)}`,
  ].join("\n");
  const max = options.maxChars ?? ATTEMPT_DIGEST_MAX;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** One tool call of a thread, privacy-safe: the tool's name, a hash of its arguments, whether it worked. No argument text, no result. */
export type ThreadToolTraceEntry = { tool: string; argsSha256: string; ok: boolean };

