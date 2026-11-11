import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The planning files' integrity (SMA k_c_health): the index files of `.agents/todos` and `.agents/plans` against the item
 * folders and plan files on disk. `plansHealth` reports; `plansFix` adds the missing index lines and drops the dead ones —
 * nothing else is touched (a line a person wrote for an existing item keeps its exact text).
 */

/** The ids an index file names: `items/<id>` or `- <id>` at a line start; comments and headings are not ids. */
function indexIds(text: string): { ids: Set<string>; lines: string[] } {
  const ids = new Set<string>();
  const lines = text.split("\n");
  for (const line of lines) {
    const found = /^-?\s*(?:\[[ xX]\]\s*)?(?:items\/)?([A-Za-z0-9][A-Za-z0-9._-]*)\b/.exec(line.trim());
    if (found && !/^#{1,6}\s/.test(line.trim()) && !/^[a-z]+:/i.test(found[1]!)) ids.add(found[1]!);
    const itemRef = /items\/([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (itemRef) ids.add(itemRef[1]!);
  }
  return { ids, lines };
}

/** The item folders of one index area (todos/items/<id> or plans/items/<id>), or the plan files of `.agents/plans`. */
function diskIds(dir: string): string[] {
  const itemsDir = join(dir, "items");
  try {
    return readdirSync(itemsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "INDEX.md").map((entry) => entry.name.replace(/\.md$/, "")).sort();
    } catch { return []; }
  }
}

function readIndex(dir: string): string | null {
  try { return readFileSync(join(dir, "INDEX.md"), "utf8"); } catch { return null; }
}

export type PlansHealthReport = { area: string; missingInIndex: string[]; deadIndexLines: string[] };

function checkArea(agentsDir: string, area: "todos" | "plans"): PlansHealthReport {
  const dir = join(agentsDir, area);
  const onDisk = diskIds(dir);
  const { ids, lines } = indexIds(readIndex(dir) ?? "");
  return {
    area,
    missingInIndex: onDisk.filter((id) => !ids.has(id)),
    deadIndexLines: lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      const mentioned = /items\/([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(trimmed)?.[1] ?? (/^-?\s*(?:\[[ xX]\]\s*)?([A-Za-z0-9][A-Za-z0-9._-]*)\b/.exec(trimmed)?.[1]);
      return mentioned !== undefined && !onDisk.includes(mentioned);
    }),
  };
}

export function plansHealth(agentsDir: string): PlansHealthReport[] {
  return [checkArea(agentsDir, "todos"), checkArea(agentsDir, "plans")].filter((report) => report.missingInIndex.length || report.deadIndexLines.length);
}

/** Auto-fix: the index lines that name a missing folder go, one `- <id>` line is appended per unindexed folder. */
export function plansFix(agentsDir: string): string[] {
  const done: string[] = [];
  for (const area of ["todos", "plans"] as const) {
    const dir = join(agentsDir, area);
    const indexPath = join(dir, "INDEX.md");
    if (!existsSync(dir)) continue;
    const report = checkArea(agentsDir, area);
    if (!report.missingInIndex.length && !report.deadIndexLines.length) continue;
    const { lines } = indexIds(readIndex(dir) ?? "");
    const kept = lines.filter((line) => !report.deadIndexLines.includes(line));
    const next = [...kept, ...report.missingInIndex.map((id) => `- ${id}`)].join("\n").replace(/\n{3,}/g, "\n\n");
    writeFileSync(indexPath, next.endsWith("\n") ? next : `${next}\n`);
    done.push(`${area}/INDEX.md: +${report.missingInIndex.length} -${report.deadIndexLines.length}`);
  }
  return done;
}
