import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { HEAVY_NOTE_TOKENS, applyShorter, compressibleRow, estimateTokens, heavyNoteRows, proposeShorter } from "@lane-pilot/memory-core";

export const MEMORY_COMPRESS_USAGE = "bb lane-pilot memory-compress [--project P] [--min-tokens N] | bb lane-pilot memory-compress --apply <record-id> [--project P]";

type Result = { exitCode: number; stdout?: string; stderr?: string };

const value = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

/**
 * `bb lane-pilot memory-compress` (SMA k_v_mem_compress): lists the heavy notes of a project with the
 * shorter wording each would get. Nothing is applied by listing; `--apply <id>` applies exactly one
 * proposal, so a person decides each note.
 */
export function runMemoryCompressCli(db: MemoryDatabase, argv: readonly string[]): Result {
  try {
    const projectId = value(argv, "--project");
    if (!projectId) return { exitCode: 1, stderr: `no project: pass --project <id>\n${MEMORY_COMPRESS_USAGE}` };
    const applyId = value(argv, "--apply");
    if (applyId) {
      const row = compressibleRow(db, projectId, applyId);
      if (!row || row.kind !== "note") return { exitCode: 1, stderr: `no active note ${applyId} in project ${projectId}` };
      const proposal = proposeShorter(row, Number(value(argv, "--min-tokens") ?? HEAVY_NOTE_TOKENS));
      if (!proposal) return { exitCode: 1, stderr: `${row.id} has no shorter proposal` };
      const done = applyShorter(db, row, proposal);
      return { exitCode: 0, stdout: `${row.id} -> ${done.insertedIds[0]} (${estimateTokens(row.content)} -> ${estimateTokens(proposal)} tokens)\n` };
    }
    const minTokens = Number(value(argv, "--min-tokens") ?? HEAVY_NOTE_TOKENS);
    const rows = heavyNoteRows(db, projectId, minTokens);
    const lines: string[] = [];
    for (const row of rows) {
      const proposal = proposeShorter(row, minTokens);
      lines.push(`${row.id} ${estimateTokens(row.content)} tokens${proposal ? ` -> ${estimateTokens(proposal)}: ${proposal.replace(/\s+/g, " ").slice(0, 160)}` : ": no shorter proposal"}`);
    }
    return { exitCode: 0, stdout: `${lines.length ? lines.join("\n") : "no heavy notes"}\n` };
  } catch (cause) {
    return { exitCode: 1, stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}
