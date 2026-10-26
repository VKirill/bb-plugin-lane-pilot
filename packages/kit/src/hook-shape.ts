import { posix } from "node:path";

/**
 * Hook identity by shape (ported idea from agent-dev-tools/hook-entry-by-shape, MIT): event + matcher + program + script path.
 * A re-saved or re-quoted settings file keeps the same shape, so an installer that matched the exact command string appended
 * a second copy and the hook ran twice. Only direct `program script [args]` commands are understood; anything else (env
 * prefix, pipes, substitutions) has no shape and callers fall back to comparing the trimmed string.
 */

/** Splits a direct command into words, undoing shell quoting. Null when the command is not a plain program + arguments. */
export function hookCommandWords(command: unknown): string[] | null {
  if (typeof command !== "string" || /[\r\n\0]/.test(command)) return null;
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (c === quote) { quote = ""; continue; }
    if (!quote && (c === "\"" || c === "'")) { quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    if (!quote && /[;&|<>`()$*?{}[\]#^]/.test(c)) return null;
    if (quote === "\"" && /[$`]/.test(c)) return null;
    // POSIX escapes outside quotes: the `'\''` that a single-quoted path with an apostrophe is written with.
    if (!quote && c === "\\" && /[ \t'"]/.test(command[i + 1] ?? "")) { word += command[i + 1]; i += 1; started = true; continue; }
    word += c;
    started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
}

/** Program and script path of a direct command, normalised; arguments are not part of the identity. Null when no shape. */
export function hookCommandShape(command: unknown): string | null {
  const words = hookCommandWords(command);
  if (!words || words.length < 2 || !words[0] || !words[1]) return null;
  if (words[0].includes("=") || words[0].startsWith("-") || words[1].startsWith("-")) return null;
  return `${posix.normalize(words[0])}\0${posix.normalize(words[1])}`;
}

/** Same hook run with the same words, whatever the quoting or spacing. Falls back to the trimmed string. */
export function hookCommandIdentity(command: string): string {
  const words = hookCommandWords(command);
  const shape = hookCommandShape(command);
  return words && shape ? [shape, ...words.slice(2)].join("\0") : command.trim();
}
