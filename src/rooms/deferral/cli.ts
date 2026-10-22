import type { DeferralApi } from "./service";

export const DEFERRAL_USAGE = [
  "bb lane-pilot defer <what> --kind drill_scenario|skipped_test|gate|plan_decision --owner-msg <threadId>#<seq> [--due 2026-11-05] [--area A] [--project P]",
  "bb lane-pilot defer <dfr_id> --owner-msg <threadId>#<seq> [--due 2026-11-05]   (set or move the term of an entry; needs a newer owner message)",
  "bb lane-pilot defer-close <dfr_id> --evidence <commit, test run, link, decision>",
  "bb lane-pilot deferrals [--project P] [--state open|overdue|needs_owner_term|closed]",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

/** `--name value` and `--name=value`; words that are not flags are positional. */
export function parseFlags(argv: readonly string[], known: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [], flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i]!;
    const hit = /^--([a-z-]+)(?:=(.*))?$/s.exec(word);
    if (!hit) { positional.push(word); continue; }
    if (!known.includes(hit[1]!)) throw new Error(`unknown flag --${hit[1]}\n${DEFERRAL_USAGE}`);
    const value = hit[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${hit[1]} needs a value`);
    flags[hit[1]!] = value;
  }
  return { positional, flags };
}

export async function runDeferralCli(api: DeferralApi, command: "defer" | "defer-close" | "deferrals", argv: string[]): Promise<Result> {
  try {
    if (command === "defer") {
      const { positional, flags } = parseFlags(argv, ["kind", "area", "project", "owner-msg", "due"]);
      if (!flags["owner-msg"]) throw new Error(`a term comes from the owner's message: add --owner-msg <threadId>#<seq>\n${DEFERRAL_USAGE}`);
      const result = await api.defer({ what: positional.join(" "), kind: flags.kind, area: flags.area, projectId: flags.project, ownerMsg: flags["owner-msg"], due: flags.due });
      return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
    }
    if (command === "defer-close") {
      const { positional, flags } = parseFlags(argv, ["evidence"]);
      if (positional.length !== 1 || !flags.evidence) throw new Error(`usage: bb lane-pilot defer-close <dfr_id> --evidence <text>`);
      return { exitCode: 0, stdout: JSON.stringify(api.close({ id: positional[0]!, evidence: flags.evidence }), null, 2) };
    }
    const { flags } = parseFlags(argv, ["project", "state"]);
    return { exitCode: 0, stdout: JSON.stringify(api.list({ projectId: flags.project, state: flags.state }), null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
