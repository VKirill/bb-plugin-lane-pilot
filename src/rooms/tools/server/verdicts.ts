import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { frontValue } from "./explain";

/** The verdict inventory of a project's planning folder (SMA k_pl_spikes): every spike and sketch under
 *  .agents/planning with its question and verdict; a file without a verdict is «open». */
export type VerdictRow = { file: string; kind: "spike" | "sketch"; question: string; verdict: string };

export function verdictInventory(root: string): VerdictRow[] {
  const dir = join(root, ".agents", "planning");
  const rows: VerdictRow[] = [];
  for (const [sub, kind, exts] of [["spikes", "spike", [".md"]], ["sketches", "sketch", [".md", ".html"]]] as const) {
    const here = join(dir, sub);
    if (!existsSync(here)) continue;
    for (const file of readdirSync(here).filter((f) => exts.some((ext) => f.endsWith(ext))).sort()) {
      const text = readFileSync(join(here, file), "utf8");
      const head = text.match(/^---\n([\s\S]*?)\n---/) ? text : `---\n${text.slice(0, 2000)}\n---`;
      rows.push({
        file: `.agents/planning/${sub}/${file}`, kind,
        question: frontValue(head, "question") ?? frontValue(head, "title") ?? file.replace(/\.(md|html)$/, ""),
        verdict: frontValue(head, "verdict") ?? "open",
      });
    }
  }
  return rows;
}

export function renderVerdicts(rows: readonly VerdictRow[]): string {
  return rows.length ? rows.map((row) => `${row.verdict.padEnd(8)} ${row.kind.padEnd(6)} ${row.question} — ${row.file}`).join("\n") : "no spikes or sketches under .agents/planning";
}
