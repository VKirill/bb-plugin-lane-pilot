import type { MemoryConflictsApi } from "./memory-conflicts";

export const MEMORY_CONFLICT_USAGE = [
  "bb lane-pilot memory-conflicts [--project P] [--state held|settled] [--detect]",
  "bb lane-pilot memory-conflict-settle <mc_id> --keep a|b|both|none --evidence <text>",
].join("\n");

type Result = { exitCode: number; stdout?: string; stderr?: string };

function flagsOf(argv: readonly string[], known: readonly string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [], flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const hit = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[index]!);
    if (!hit) { positional.push(argv[index]!); continue; }
    if (!known.includes(hit[1]!)) throw new Error(`unknown flag --${hit[1]}\n${MEMORY_CONFLICT_USAGE}`);
    flags[hit[1]!] = hit[2] ?? (hit[1] === "detect" ? "1" : argv[++index] ?? "");
  }
  return { positional, flags };
}

export function runMemoryConflictCli(api: MemoryConflictsApi, command: "memory-conflicts" | "memory-conflict-settle", argv: readonly string[]): Result {
  try {
    if (command === "memory-conflict-settle") {
      const { positional, flags } = flagsOf(argv, ["keep", "evidence"]);
      if (positional.length !== 1 || !flags.keep || !flags.evidence) throw new Error(`usage: ${MEMORY_CONFLICT_USAGE.split("\n")[1]}`);
      if (!["a", "b", "both", "none"].includes(flags.keep)) throw new Error("--keep is a (the older note), b (the newer), both (they do not disagree) or none (both are wrong)");
      return { exitCode: 0, stdout: JSON.stringify(api.settle({ id: positional[0]!, keep: flags.keep as "a" | "b" | "both" | "none", evidence: flags.evidence }), null, 2) };
    }
    const { flags } = flagsOf(argv, ["project", "state", "detect"]);
    if (flags.state && flags.state !== "held" && flags.state !== "settled") throw new Error("--state is held or settled");
    if (flags.detect && !flags.project) throw new Error("--detect looks at one project: add --project P");
    const found = flags.detect ? api.detect(flags.project!) : [];
    return { exitCode: 0, stdout: JSON.stringify({ opened: found.length, conflicts: api.list({ projectId: flags.project, state: flags.state as "held" | "settled" | undefined }) }, null, 2) };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
