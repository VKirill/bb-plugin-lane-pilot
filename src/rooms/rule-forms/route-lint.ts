// A rule about files or paths, or about a verification command, becomes a lint
// instead of another paragraph. Other rules stay prose.
// ponytail: two shapes only. A third shape needs another route, not a bigger regex.

export type PromotionRoute = "contract_path" | "verification_command";

export function promotionRoute(rule: string): PromotionRoute | null {
  if (/\bverification command\b|\bкоманд\w* проверк|\bvitest run\b|\bwhole suite\b/i.test(rule)) return "verification_command";
  if (/\b(?:owns_paths|never_touch|read_first)\b|\bpaths? outside\b|файл|путь|пути/i.test(rule)) return "contract_path";
  return null;
}

/** Null when every path stays inside the project. */
export function lintPathRule(paths: readonly string[]): string | null {
  const bad = paths.find((path) => path.startsWith("/") || path.includes("\\") || path.split(/[/\\]/).includes(".."));
  return bad ? `${bad} escapes the project` : null;
}

/** Null when a vitest run names a file, or the command is not a vitest run. */
export function lintVerificationRule(commands: readonly string[]): string | null {
  for (const command of commands) {
    if (!/\bvitest\b/.test(command) || !/\brun\b/.test(command)) continue;
    const words = command.split(/\s+/).filter((word) => word && !word.startsWith("-"));
    const after = words.slice(words.indexOf("run") + 1);
    if (after.length === 0) return `${command} must name a test file`;
  }
  return null;
}
