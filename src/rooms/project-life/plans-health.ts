import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The planning files' integrity (SMA k_c_health): the index files of `.agents/todos` and `.agents/plans` against the item
 * folders and plan files on disk. `plansHealth` reports; `plansFix` drops a line that is exactly an index entry of a known form
 * whose folder or file is missing, appends `- <id>` for an unindexed item, and writes INDEX.md.bak first. Prose, headings and
 * blank lines are never touched (a line a person wrote for an existing item keeps its exact text).
 */

const ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
/** The two known entry forms: `- [ ] id — note` (also `items/id`, `id/`, `id.md`) and `- [title](items/id/…)`. Anything else on a line is prose. */
const BULLET_ENTRY = new RegExp(`^\\s*[-*]\\s+(?:\\[[ xX]\\]\\s+)?\`?(?:items/)?(${ID})(?:/|\\.md)?\`?(?:\\s*(?:[—–:]|-{1,2})\\s+.*)?\\s*$`);
const LINK_ENTRY = new RegExp(`^\\s*[-*]\\s+(?:\\[[ xX]\\]\\s+)?\\[[^\\]]*\\]\\((?:\\./)?(?:items/)?(${ID})(?:/[^)]*|\\.md)?\\)(?:\\s*(?:[—–:]|-{1,2})\\s+.*)?\\s*$`);

/** The id an index line names when the whole line is an entry of a known form, else null. */
function entryId(line: string): string | null {
  const found = BULLET_ENTRY.exec(line) ?? LINK_ENTRY.exec(line);
  return found?.[1]?.replace(/\.md$/, "") ?? null;
}

/** Files of a plans folder that are not plan items: the index itself, a README, the roadmap, hidden files. */
const NOT_AN_ITEM = /^(index|readme|roadmap|changelog)\.md$/i;

/** The item folders of one index area (todos/items/<id> or plans/items/<id>), or the plan files of `.agents/plans`. */
function diskIds(dir: string): string[] {
  const itemsDir = join(dir, "items");
  try {
    return readdirSync(itemsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !NOT_AN_ITEM.test(entry.name) && !/^[._]/.test(entry.name)).map((entry) => entry.name.replace(/\.md$/, "")).sort();
    } catch { return []; }
  }
}

function readIndex(dir: string): string | null {
  try { return readFileSync(join(dir, "INDEX.md"), "utf8"); } catch { return null; }
}

export type PlansHealthReport = { area: string; missingInIndex: string[]; deadIndexLines: string[] };

function checkArea(agentsDir: string, area: "todos" | "plans"): PlansHealthReport & { deadLineNumbers: number[] } {
  const dir = join(agentsDir, area);
  const onDisk = diskIds(dir);
  const lines = (readIndex(dir) ?? "").split("\n");
  const named = new Set<string>();
  const deadLineNumbers: number[] = [];
  lines.forEach((line, at) => {
    const id = entryId(line);
    if (id === null) return;
    named.add(id);
    // Only a lower-case slug (how items are named) can be a dead entry: a capitalised first word is a sentence, never removed.
    if (!onDisk.includes(id) && /^[a-z0-9][a-z0-9._-]*$/.test(id)) deadLineNumbers.push(at);
  });
  // An id mentioned inside a prose line still counts as indexed: only entries are judged, a sentence is never "dead".
  const mentioned = (id: string) => named.has(id) || lines.some((line) => line.includes(`items/${id}`));
  return { area, missingInIndex: onDisk.filter((id) => !mentioned(id)), deadIndexLines: deadLineNumbers.map((at) => lines[at]!), deadLineNumbers };
}

export function plansHealth(agentsDir: string): PlansHealthReport[] {
  return (["todos", "plans"] as const).map((area) => checkArea(agentsDir, area)).filter((report) => report.missingInIndex.length || report.deadIndexLines.length)
    .map(({ area, missingInIndex, deadIndexLines }) => ({ area, missingInIndex, deadIndexLines }));
}

/** Auto-fix: the entry lines that name a missing folder or file go, one `- <id>` line is appended per unindexed item; INDEX.md.bak keeps the text before the change. */
export function plansFix(agentsDir: string): string[] {
  const done: string[] = [];
  for (const area of ["todos", "plans"] as const) {
    const dir = join(agentsDir, area);
    const indexPath = join(dir, "INDEX.md");
    if (!existsSync(dir)) continue;
    const report = checkArea(agentsDir, area);
    if (!report.missingInIndex.length && !report.deadLineNumbers.length) continue;
    const before = readIndex(dir) ?? "";
    const dead = new Set(report.deadLineNumbers);
    let next = before.split("\n").filter((_, at) => !dead.has(at)).join("\n");
    if (report.missingInIndex.length) next = `${next}${next === "" || next.endsWith("\n") ? "" : "\n"}${report.missingInIndex.map((id) => `- ${id}`).join("\n")}\n`;
    if (existsSync(indexPath)) copyFileSync(indexPath, `${indexPath}.bak`);
    writeFileSync(indexPath, next);
    done.push(`${area}/INDEX.md: +${report.missingInIndex.length} -${report.deadLineNumbers.length} (the text before is in INDEX.md.bak)`);
  }
  return done;
}
