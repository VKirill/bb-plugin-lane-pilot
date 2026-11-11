import type { MemoryDatabase } from "@lane-pilot/memory-core";
import { HEAVY_NOTE_TOKENS, applyShorter, estimateTokens, heavyNoteRows, proposeShorter, resolveCompressible, undoShorter } from "@lane-pilot/memory-core";

export const MEMORY_COMPRESS_USAGE = "bb lane-pilot memory-compress [--project P] [--min-tokens N] | memory-compress --apply <record-id> [--project P] | memory-compress --undo <new-record-id> [--project P]   (--apply and --undo are the owner's, at a terminal)";

type Result = { exitCode: number; stdout?: string; stderr?: string };

const value = (argv: readonly string[], name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

/** True for the forms that change the corpus; a thread (an agent) may not call these, the caller check lives with the verb's dispatcher. */
export const memoryCompressChanges = (argv: readonly string[]): boolean => argv.includes("--apply") || argv.includes("--undo");

/**
 * `bb lane-pilot memory-compress` (SMA k_v_mem_compress): lists the heavy notes of a project with the
 * shorter wording each would get. Nothing is applied by listing; `--apply <id>` applies exactly one
 * proposal to an active note, `--undo <new id>` takes it back, so a person decides each note and can reverse it.
 */
export function runMemoryCompressCli(db: MemoryDatabase, argv: readonly string[]): Result {
  try {
    const projectId = value(argv, "--project");
    if (!projectId) return { exitCode: 1, stderr: `no project: pass --project <id>\n${MEMORY_COMPRESS_USAGE}` };
    const undoId = value(argv, "--undo");
    if (argv.includes("--undo")) {
      if (!undoId || undoId.startsWith("--")) return { exitCode: 1, stderr: `--undo needs the id of the shortened note\n${MEMORY_COMPRESS_USAGE}` };
      const oldId = undoShorter(db, projectId, undoId);
      return { exitCode: 0, stdout: `${undoId} undone: ${oldId} is active again\n` };
    }
    const applyId = value(argv, "--apply");
    if (argv.includes("--apply")) {
      if (!applyId || applyId.startsWith("--")) return { exitCode: 1, stderr: `--apply needs a note id\n${MEMORY_COMPRESS_USAGE}` };
      const found = resolveCompressible(db, projectId, applyId);
      if ("error" in found) return { exitCode: 1, stderr: found.error };
      const row = found.row;
      const proposal = proposeShorter(row, Number(value(argv, "--min-tokens") ?? HEAVY_NOTE_TOKENS));
      if (!proposal) return { exitCode: 1, stderr: `${row.id} has no shorter proposal` };
      const done = applyShorter(db, row, proposal);
      if (!done.insertedIds[0]) return { exitCode: 1, stderr: `${row.id}: the shorter wording already exists as a record (undone earlier?); nothing applied` };
      const held = done.heldIds.includes(row.id) ? " (the old note was used recently: both wordings wait as a conflict for a person)" : "";
      return { exitCode: 0, stdout: `${row.id} -> ${done.insertedIds[0]} (${estimateTokens(row.content)} -> ${estimateTokens(proposal)} tokens)${held}\n` };
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
