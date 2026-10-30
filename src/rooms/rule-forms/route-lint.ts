import { classifyRuleForm, type RuleForm } from "@lane-pilot/run-insights";

// Each hub form (check, hook, skill, memory, always) gets a hold when the words name something a lint,
// a gate or a check can refuse. The rest stay text, and the reason says why.

export type PromotionRoute = "contract_path" | "verification_command";

export type RuleHold = "lint" | "gate" | "check" | "none";

export type RuleMechanismName = "lintPathRule" | "lintVerificationRule" | "lintMigrationOrder" | "lintBlockedCommand";

export type RuleMechanismPlan = {
  form: RuleForm;
  hold: RuleHold;
  name: RuleMechanismName | null;
  reason: string;
};

const NO_CHECK = "the check names no path, verification command, migration list or gate a lint can refuse";
const NO_SKILL = "a skill is a procedure; a lint cannot hold the sequence";
const NO_MEMORY = "a memory fact is project knowledge, not a refusing check";
const NO_STANCE = "a stance has no case a lint can refuse";

/** The hold for one rule's words. Skill, memory and a stance are none, with the reason. */
export function ruleMechanismPlan(rule: string): RuleMechanismPlan {
  const verdict = classifyRuleForm(rule);
  if (!verdict.decided || verdict.form === "always") return { form: "always", hold: "none", name: null, reason: NO_STANCE };
  if (verdict.form === "skill") return { form: "skill", hold: "none", name: null, reason: NO_SKILL };
  if (verdict.form === "memory") return { form: "memory", hold: "none", name: null, reason: NO_MEMORY };
  if (verdict.form === "hook") return { form: "hook", hold: "gate", name: "lintBlockedCommand", reason: "a hook forbids a command; the gate refuses that command" };
  if (/append (?:it )?(?:ONLY )?(?:as the )?(?:last|at the end)|only append|last element of|never insert|MIGRATIONS/i.test(rule)) {
    return { form: "check", hold: "check", name: "lintMigrationOrder", reason: "a migration list only grows at the end" };
  }
  const route = promotionRoute(rule);
  if (route === "verification_command") return { form: "check", hold: "lint", name: "lintVerificationRule", reason: "a verification command is refused when it is a bare suite" };
  if (route === "contract_path") return { form: "check", hold: "lint", name: "lintPathRule", reason: "a path that escapes the project is refused" };
  return { form: "check", hold: "none", name: null, reason: NO_CHECK };
}

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

/** Null when `added` is the last name in the list. An insert in the middle is refused. */
export function lintMigrationOrder(names: readonly string[], added: string): string | null {
  const at = names.lastIndexOf(added);
  if (names.length > 0 && at === names.length - 1 && names.indexOf(added) === at) return null;
  return `${added} must be the last migration`;
}

/** Null when the command matches none of the forbidden fragments. */
export function lintBlockedCommand(command: string, forbidden: readonly string[]): string | null {
  const hit = forbidden.find((word) => word.length > 0 && command.includes(word));
  return hit ? `${command} is blocked: ${hit}` : null;
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
