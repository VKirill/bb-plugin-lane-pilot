import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { discoverRepos, exists, isClientPath, isDir, type SourceRecord, type SourceScan } from "./common";

/**
 * The project's own diary and registry (A3). `docs/project-life/journal/**.md`: one event per entry file, dated by its name,
 * titled by its first heading, pointing at the file. `docs/REGISTRY.md`: one project or tool per table row.
 * Only titles and one-line descriptions are read into the store; the pages stay where they are.
 */
const DAY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/** Folders that may hold `docs/`: the roots, their direct children (BB-сервис is a folder, not a repository) and every repository. */
export async function docRoots(roots: readonly string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const root of roots) {
    out.add(root);
    try { for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) out.add(join(root, entry.name)); } catch { /* unreadable root */ }
  }
  for (const repo of await discoverRepos(roots)) out.add(repo);
  return [...out].sort();
}

async function markdownFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await markdownFiles(path, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const clean = (text: string): string => text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();

export function parseJournalHead(text: string, fileName: string): { title: string; chat: string | null } {
  const head = text.split("\n").slice(0, 40);
  const heading = head.find((line) => /^#{1,3}\s+\S/.test(line));
  const title = clean((heading ?? "").replace(/^#+\s+/, "")) || clean(fileName.replace(/\.md$/, "").replace(DAY_PREFIX, "").replace(/^-/, "").replace(/-/g, " ")) || fileName;
  return { title: title.slice(0, 160), chat: /\bthr_[a-z0-9]{6,}\b/.exec(head.join("\n"))?.[0] ?? null };
}

export async function scanJournals(roots: readonly string[], since: number, until: number): Promise<SourceScan> {
  const records: SourceRecord[] = [];
  let files = 0;
  for (const base of await docRoots(roots)) {
    const journal = join(base, "docs", "project-life", "journal");
    if (!(await isDir(journal))) continue;
    for (const path of await markdownFiles(journal)) {
      files += 1;
      const name = basename(path);
      const day = DAY_PREFIX.exec(name);
      const info = await stat(path);
      const at = day ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12) : Math.floor(info.mtimeMs);
      if (at < since || at >= until) continue;
      const { title, chat } = parseJournalHead(await readFile(path, "utf8"), name);
      const rel = `${basename(base)}/${relative(journal, path)}`;
      records.push({
        kind: "event", key: `journal:${rel}`, title, statement: title,
        attributes: { origin: "journal", project: basename(base), ...(chat ? { chat } : {}), ...(isClientPath(base) ? { relation: "client-work" } : {}) },
        ...(isClientPath(base) ? { sensitivity: "sensitive" as const } : {}),
        confidence: 0.8, firstSeen: at, lastSeen: at, evidence: [{ source: "journal", ref: `${basename(base)}/docs/project-life/journal/${relative(journal, path)}`, at }],
      });
    }
  }
  return { source: "journal", items: files, records };
}

export function parseRegistry(text: string): Array<{ section: string; cells: string[] }> {
  const rows: Array<{ section: string; cells: string[] }> = [];
  let section = "", inTable = false, headerSeen = false;
  for (const line of text.split("\n")) {
    const heading = /^#{2,3}\s+(.*)/.exec(line);
    if (heading) { section = heading[1]!.trim(); inTable = false; headerSeen = false; continue; }
    if (!line.trim().startsWith("|")) { inTable = false; headerSeen = false; continue; }
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => clean(cell));
    if (!inTable) { inTable = true; headerSeen = false; continue; }          // the header row
    if (!headerSeen) { headerSeen = true; if (cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))) continue; }
    rows.push({ section, cells });
  }
  return rows;
}

export async function scanRegistry(roots: readonly string[], now: number): Promise<SourceScan> {
  const records: SourceRecord[] = [];
  let rows = 0;
  for (const base of await docRoots(roots)) {
    const path = join(base, "docs", "REGISTRY.md");
    if (!(await exists(path))) continue;
    const text = await readFile(path, "utf8");
    const snapshot = /Снимок:\s*(\d{4})-(\d{2})-(\d{2})/.exec(text);
    const at = snapshot ? Date.UTC(Number(snapshot[1]), Number(snapshot[2]) - 1, Number(snapshot[3]), 12) : Math.floor((await stat(path)).mtimeMs);
    for (const { section, cells } of parseRegistry(text)) {
      const id = cells[0]?.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!id || id.length > 80) continue;
      rows += 1;
      const plugin = /плагин|plugin/i.test(section);
      const projectLike = /проект|машин|project|machine/i.test(section);
      if (!plugin && !projectLike) continue;
      const statement = cells.slice(1, 3).filter(Boolean).join(" — ").slice(0, 300);
      records.push({
        kind: plugin ? "tool" : "project", key: plugin ? `plugin:${id}` : `registry:${id}`, title: id, statement,
        attributes: { origin: "registry", section, registry: `${basename(base)}/docs/REGISTRY.md` },
        confidence: 0.7, firstSeen: at, lastSeen: at, evidence: [{ source: "registry", ref: `${basename(base)}/docs/REGISTRY.md#${id}`, at: Math.min(at, now) }],
      });
    }
  }
  return { source: "registry", items: rows, records };
}
