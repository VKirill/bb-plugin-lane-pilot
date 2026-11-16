/** Fence arbitrary text without letting an embedded fence close the block. */
export function chatCode(text: string, language = ""): string {
  const length = Math.max(3, ...(text.match(/`+/g) ?? []).map((run) => run.length + 1));
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

const sectionTitles: Record<string, string> = {
  task_goal: "Задача", inputs: "Входные данные", boundaries: "Границы изменений",
  acceptance: "Критерии приёмки и проверки", output: "Результат и порядок сдачи",
};

/** Presentation of generated contract sections only; hidden data blocks keep their original framing. */
export function chatBriefSection(text: string): string {
  const match = /^<(task_goal|inputs|boundaries|acceptance|output)>\n([\s\S]*)\n<\/\1>$/.exec(text);
  if (!match) return text;
  // compactContract may emit multiline commands as plain strings. Their body is not a field grammar:
  // a heredoc can itself contain "key: value", Markdown fences, or another apparent list item.
  const checksAt = match[1] === "acceptance" ? match[2]!.indexOf("\nverification:\n") : -1;
  if (checksAt >= 0) {
    const tail = match[2]!.slice(checksAt + "\nverification:\n".length);
    if (!tail.split("\n").every((line) => line.startsWith("- {") && (() => {
      try { return typeof JSON.parse(line.slice(2))?.command === "string"; } catch { return false; }
    })())) {
      return `${chatBriefSection(`<acceptance>\n${match[2]!.slice(0, checksAt)}\n</acceptance>`)}\n\n**verification:**\n\n${chatCode(tail, "text")}`;
    }
  }
  let fence: string | null = null;
  let verification = false;
  const lines = match[2]!.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
      return line;
    }
    if (marker) { fence = marker[1]!; return line; }
    // Verification objects contain exact shell commands plus cwd/secret names; never split a command on punctuation.
    if (verification && line.startsWith('- {')) {
      try {
        const value = JSON.parse(line.slice(2));
        if (value && typeof value.command === "string") {
          const { command, ...metadata } = value;
          return `\n${chatCode(command, "sh")}${Object.keys(metadata).length ? `\n\n${chatCode(JSON.stringify(metadata, null, 2), "json")}` : ""}\n`;
        }
      } catch { /* Keep non-JSON prose intact. */ }
    }
    const field = /^([a-z][a-z_0-9]*):(?: (.*))?$/.exec(line);
    if (field) verification = field[1] === "verification";
    return field ? `\n**${field[1]}:**${field[2] ? ` ${field[2]}` : ""}\n` : line;
  });
  return `### ${sectionTitles[match[1]!]}\n\n${lines.join("\n").trim()}`;
}
