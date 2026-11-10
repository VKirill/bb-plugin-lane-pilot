/**
 * The tail of an attempt's live log in words (SMA m_ws_attempt_log): the thread's last events as at most `max`
 * short Russian lines — a fixed table over the tool name; an event kind the table does not know is skipped.
 */
const VERB: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(read|view|cat|open|grep|glob|list|search|ls|find)/i, "читает файл…"],
  [/^(edit|write|str_replace|apply_patch|insert|delete|rename|move|multi_edit|notebook_edit|create)/i, "правит файл…"],
];
export function tailWords(events: readonly unknown[], max = 8): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const item = ((event as { data?: { item?: Record<string, unknown> } })?.data?.item ?? event) as Record<string, unknown>;
    const type = String(item?.type ?? "");
    let line: string | null = null;
    if (type === "commandExecution") line = "запускает проверку";
    else if (type === "toolCall") {
      const name = String(item.name ?? item.tool ?? "");
      line = VERB.find(([re]) => re.test(name))?.[1] ?? null;
    } else if (type === "agentMessage" || type === "assistantMessage") line = "пишет ответ";
    if (line) lines.push(line);
  }
  return lines.slice(-max);
}
