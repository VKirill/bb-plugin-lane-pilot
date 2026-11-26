import { frontValue } from "./explain";

/** The verdict inventory of a project's planning folder (SMA k_pl_spikes): every spike and sketch under
 *  .agents/planning with its question and verdict; a file without a verdict is «open». */
export type VerdictRow = { file: string; kind: "spike" | "sketch"; question: string; verdict: string };

const MARK = "@@lp-verdict-file ";
/** Run in the project's checkout on its own machine: each spike and sketch, its path on a marker line and its first 4000 bytes (the head holds the verdict). */
export const VERDICT_LIST_COMMAND = `for f in .agents/planning/spikes/*.md .agents/planning/sketches/*.md .agents/planning/sketches/*.html; do [ -f "$f" ] || continue; printf '\\n${MARK}%s\\n' "$f"; head -c 4000 -- "$f"; done`;

/** The files of VERDICT_LIST_COMMAND's output. */
export function verdictFiles(stdout: string): Array<{ path: string; text: string }> {
  return stdout.split(`\n${MARK}`).slice(1).map((part) => { const cut = part.indexOf("\n"); return { path: part.slice(0, cut < 0 ? undefined : cut).trim(), text: cut < 0 ? "" : part.slice(cut + 1) }; });
}

export function verdictInventory(files: ReadonlyArray<{ path: string; text: string }>): VerdictRow[] {
  const rows: VerdictRow[] = [];
  for (const [sub, kind] of [["spikes", "spike"], ["sketches", "sketch"]] as const) {
    const prefix = `.agents/planning/${sub}/`;
    for (const { path, text } of files.filter((file) => file.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path))) {
      const head = text.match(/^---\n([\s\S]*?)\n---/) ? text : `---\n${text.slice(0, 2000)}\n---`;
      rows.push({
        file: path, kind,
        question: frontValue(head, "question") ?? frontValue(head, "title") ?? path.slice(prefix.length).replace(/\.(md|html)$/, ""),
        verdict: frontValue(head, "verdict") ?? "open",
      });
    }
  }
  return rows;
}

export function renderVerdicts(rows: readonly VerdictRow[]): string {
  return rows.length ? rows.map((row) => `${row.verdict.padEnd(8)} ${row.kind.padEnd(6)} ${row.question} — ${row.file}`).join("\n") : "no spikes or sketches under .agents/planning";
}
