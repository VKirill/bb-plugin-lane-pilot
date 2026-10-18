/**
 * A writer thread's events (`bb.sdk.threads.events.list`) rendered in one readable grammar an editor can cite:
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

export type RenderOptions = { obsTrunc?: number; argsTrunc?: number; maxChars?: number };

const DEFAULTS: Required<RenderOptions> = { obsTrunc: 4000, argsTrunc: 400, maxChars: 400_000 };

const clip = (value: unknown, n: number): string => {
  const s = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  return s.length <= n ? s : `${s.slice(0, n)} …[+${s.length - n} chars clipped]`;
};

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["text", "message", "content", "summary", "output"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) return v;
      if (Array.isArray(v) || (v && typeof v === "object")) { const t = text(v); if (t.trim()) return t; }
    }
  }
  return "";
};

const push = (lines: string[], line: string): void => { if (lines[lines.length - 1] !== line) lines.push(line); };

function renderItem(item: Record<string, unknown>, lines: string[], o: Required<RenderOptions>): void {
  const type = String(item.type ?? "");
  switch (type) {
    case "userMessage": { const t = text(item.content); if (t.trim()) push(lines, `[USER] ${clip(t, o.obsTrunc)}`); return; }
    case "agentMessage":
    case "assistantMessage": { const t = text(item.text ?? item); if (t.trim()) push(lines, `[ASSISTANT] ${clip(t, o.obsTrunc)}`); return; }
    case "reasoning": { const t = text(item.summary) || text(item.content); if (t.trim()) push(lines, `[REASONING] ${clip(t, Math.min(o.obsTrunc, 1200))}`); return; }
    case "plan": { const t = text(item.text); if (t.trim()) push(lines, `[ASSISTANT] plan: ${clip(t, 1200)}`); return; }
    case "planSteps": {
      const steps = Array.isArray(item.steps) ? item.steps as Array<Record<string, unknown>> : [];
      if (steps.length) push(lines, `[ASSISTANT] plan: ${steps.map((s) => `[${s.status === "completed" ? "x" : " "}] ${clip(text(s.step ?? s.text ?? s), 200)}`).join(" | ")}`);
      return;
    }
    case "commandExecution": {
      push(lines, `[ACTION] shell: ${clip(item.command, o.argsTrunc)}`);
      const exit = typeof item.exitCode === "number" ? item.exitCode : null;
      const failed = item.status === "failed" || (exit !== null && exit !== 0);
      let out = clip(item.aggregatedOutput ?? "", o.obsTrunc);
      if (!out && item.status === "inProgress") out = "(no output captured; the command was still running when the stream ended)";
      push(lines, `[OBSERVATION${failed ? " ERROR" : ""}] ${out}${exit !== null && exit !== 0 ? ` | exit_code=${exit}` : ""}`);
      return;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
      const named = changes.map((c) => `${c.path}${c.kind ? ` (${c.kind})` : ""}`).join(", ");
      push(lines, `[ACTION] edit: ${clip(named || "(no paths)", o.argsTrunc)}`);
      if (item.status === "failed") push(lines, "[OBSERVATION ERROR] the edit was not applied");
      return;
    }
    case "fileRead": push(lines, `[ACTION] read: ${clip(item.path, o.argsTrunc)}`); return;
    case "search": push(lines, `[ACTION] search(${item.mode ?? "content"}): ${clip(item.query, o.argsTrunc)}`); return;
    case "webSearch": push(lines, `[ACTION] web search: ${clip(item.query ?? text(item), o.argsTrunc)}`); return;
    case "webFetch": push(lines, `[ACTION] web fetch: ${clip(item.url ?? text(item), o.argsTrunc)}`); return;
    case "toolCall":
    case "mcpToolCall": {
      const name = [item.server, item.tool].filter(Boolean).join("/") || "tool";
      push(lines, `[ACTION] ${name}: ${clip(item.arguments ?? {}, o.argsTrunc)}`);
      if (typeof item.error === "string" && item.error.trim()) push(lines, `[OBSERVATION ERROR] ${clip(item.error, o.obsTrunc)}`);
      else if (item.result !== undefined) push(lines, `[OBSERVATION] ${clip(text(item.result) || item.result, o.obsTrunc)}`);
      else if (item.status === "failed") push(lines, "[OBSERVATION ERROR] the tool call failed");
      return;
    }
    case "contextCompaction": push(lines, "[HARNESS] context compacted"); return;
    case "backgroundTask":
    case "delegation": push(lines, `[HARNESS] ${type}: ${clip(item.description ?? item.summary ?? "", 300)}${item.taskStatus ? ` (${item.taskStatus})` : ""}${item.error ? ` error: ${clip(item.error, 300)}` : ""}`); return;
    default: { const t = text(item); if (t.trim()) push(lines, `[HARNESS] ${type || "item"}: ${clip(t, 600)}`); }
  }
}

/** Render events in stream order. Unknown shapes are kept as `[HARNESS]` lines rather than dropped. */
export function renderThreadEvents(events: readonly ThreadEventLike[], options: RenderOptions = {}): string {
  const o = { ...DEFAULTS, ...options };
  const lines: string[] = [];
  const ordered = [...events].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  for (const event of ordered) {
    const type = String(event.type ?? "");
    const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>;
    if (type === "item/completed" && data.item && typeof data.item === "object") { renderItem(data.item as Record<string, unknown>, lines, o); continue; }
    if (type === "client/turn/requested") { const t = text(data.text ?? data.input ?? data.content ?? data); if (t.trim()) push(lines, `[USER] ${clip(t, o.obsTrunc)}`); continue; }
    if (type === "turn/completed") { const status = String(data.status ?? ""); if (status && status !== "completed") push(lines, `[HARNESS] turn ended: ${status}${data.error ? ` (${clip(text(data.error), 300)})` : ""}`); continue; }
    if (type === "provider/error") { push(lines, `[ERROR] provider: ${clip(text(data) || data.code || "", 600)}${data.willRetry === true ? " (retried)" : ""}`); continue; }
    if (type === "system/error") { push(lines, `[ERROR] system ${data.code ?? ""}: ${clip(text(data), 600)}`); continue; }
    if (type === "system/thread/interrupted") { push(lines, "[HARNESS] thread interrupted"); continue; }
  }
  const out = lines.join("\n");
  if (out.length <= o.maxChars) return out;
  const head = Math.floor(o.maxChars * 0.6), tail = Math.floor(o.maxChars * 0.35);
  return `${out.slice(0, head)}\n[HARNESS] …renderer cut ${out.length - head - tail} chars from the middle of this trajectory; the cut is ours, not the writer's…\n${out.slice(out.length - tail)}`;
}

/** The counts an editor's notes cite: actions, failed observations, errors, turns. */
export function trajectoryStats(rendered: string): { actions: number; failedObservations: number; errors: number; userTurns: number } {
  const lines = rendered.split("\n");
  return {
    actions: lines.filter((l) => l.startsWith("[ACTION]")).length,
    failedObservations: lines.filter((l) => l.startsWith("[OBSERVATION ERROR]")).length,
    errors: lines.filter((l) => l.startsWith("[ERROR]")).length,
    userTurns: lines.filter((l) => l.startsWith("[USER]")).length,
  };
}
