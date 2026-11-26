/** One tool call with its result, as the thread's events show them. */
export type ToolPair = { tool: string; call: string; result: string };

/** The journal's list cap and clip marks (sma k_lib_workerprog): every cut is visible, never silent. */
export const PROGRESS_CAP = 200;
const CLIP_CHARS = 400;

/** One line of the journal: a long command or output is cut in place and says so. */
const clipMark = (text: string, max = CLIP_CHARS): string => (text.length > max ? `${text.slice(0, max)} [cut: ${text.length - max} chars]` : text);
const capped = (lines: string[]): string[] => (lines.length > PROGRESS_CAP ? [...lines.slice(0, PROGRESS_CAP), `… ${lines.length - PROGRESS_CAP} more not shown`] : lines);

/**
 * What a worker touched and ran, as the task folder's PROGRESS.md (sma k_lib_workerprog): the files the attempt
 * produced and every command/tool call of its thread (toolPairsOf over the thread's events). Each list is capped
 * at 200 rows with a closing «… N more not shown», and each clipped line is marked «[cut: N chars]» — a person can
 * always tell a cut record from a complete one.
 */
export function progressJournal(input: { attemptId: string; taskId: string; produced: readonly string[]; events: ReadonlyArray<Record<string, unknown>>; /** The event read hit its limit: later calls are not in this journal (the last silent cut, SMA k_lib_workerprog). */ truncated?: boolean }): string {
  const files = capped(input.produced.map((path) => `- ${path}`));
  const commands = capped(toolPairsOf(input.events).map((pair) => `- ${clipMark(`${pair.tool}: ${pair.call}`)}${pair.result ? `\n  ${clipMark(pair.result)}` : ""}`));
  return [
    `# PROGRESS — ${input.taskId}`,
    "",
    `attempt ${input.attemptId}, ${new Date().toISOString()}`,
    "",
    "## files touched",
    ...(files.length ? files : ["- (none)"]),
    "",
    "## commands and tool calls",
    ...(commands.length ? commands : ["- (none)"]),
    ...(input.truncated ? ["", "… calls after the first 500 thread events are not shown"] : []),
    "",
  ].join("\n");
}

/** Consecutive `tool`/`command` events folded into call+result pairs, oldest first. */
export function toolPairsOf(events: ReadonlyArray<Record<string, unknown>>): ToolPair[] {
  const pairs: ToolPair[] = [];
  for (const event of events) {
    const item = (event as { data?: { item?: Record<string, unknown> } })?.data?.item;
    if (!item) continue;
    const type = String(item.type ?? "");
    if (type !== "toolCall" && type !== "commandExecution") continue;
    const call = String(item.command ?? item.name ?? "") || JSON.stringify(item.input ?? item.arguments ?? "").slice(0, 300);
    const result = [item.aggregatedOutput, item.output, item.stdout, item.stderr].find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
    pairs.push({ tool: String(item.tool ?? item.name ?? type), call: call.slice(0, 300), result: result.slice(0, 4_000) });
  }
  return pairs;
}
