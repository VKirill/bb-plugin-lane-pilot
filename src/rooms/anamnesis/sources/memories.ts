import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Kind } from "../model";
import type { SourceRecord, SourceScan } from "./common";

/**
 * Memories that already exist (A3, read only). Claude Code's per-folder memory files: the front-matter `description` of each
 * topic file, never the body. BB's global memories: the `summary` of each. Only what is about the owner as a person is taken: Claude
 * memories of type `user` (a fact about him) and `feedback` (a preference); BB memories of kind `preference`. Project notes, references,
 * procedures, facts and decisions about the work describe the work, not the owner, and are skipped (counted).
 */
export function parseFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const out: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);   // `type` may sit under `metadata:`
    if (pair && pair[2]!.trim()) out[pair[1]!] = pair[2]!.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

const CLAUDE_KINDS: Record<string, Kind> = { user: "fact", feedback: "preference" };

export async function scanClaudeMemory(home: string): Promise<SourceScan> {
  const base = join(home, ".claude", "projects");
  const records: SourceRecord[] = [];
  let files = 0, skipped = 0;
  let folders: string[] = [];
  try { folders = await readdir(base); } catch { return { source: "claude-memory", items: 0, records, note: "no ~/.claude/projects" }; }
  for (const folder of folders.sort()) {
    const dir = join(base, folder, "memory");
    let names: string[];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names.sort()) {
      if (!name.endsWith(".md") || name === "MEMORY.md") continue;
      files += 1;
      const path = join(dir, name);
      const meta = parseFrontMatter(await readFile(path, "utf8"));
      const kind = CLAUDE_KINDS[meta.type ?? ""];
      if (!kind || !meta.name) { skipped += 1; continue; }
      const at = Math.floor((await stat(path)).mtimeMs);
      records.push({
        kind, key: `claude:${folder}/${name.replace(/\.md$/, "")}`, title: meta.name.slice(0, 160), statement: (meta.description ?? "").slice(0, 600),
        attributes: { origin: "claude-memory", type: meta.type, folder },
        confidence: 0.6, firstSeen: at, lastSeen: at, evidence: [{ source: "claude-memory", ref: `${folder}/${name}`, at }],
      });
    }
  }
  return { source: "claude-memory", items: files, records, ...(skipped ? { note: `${skipped} files without a usable type or name were skipped` } : {}) };
}

const BB_KINDS: Record<string, Kind> = { preference: "preference" };

type CatalogEntry = { id?: string; name?: string; summary?: string; kind?: string; tags?: string[]; importance?: number; version?: number; updatedAt?: number };

export function recordsFromBbCatalog(memories: CatalogEntry[]): SourceScan {
  const records: SourceRecord[] = [];
  let skipped = 0;
  for (const memory of memories) {
    const kind = BB_KINDS[memory.kind ?? ""];
    if (!kind || !memory.id || !memory.name) { skipped += 1; continue; }
    const at = typeof memory.updatedAt === "number" ? memory.updatedAt : 0;
    records.push({
      kind, key: `bbmem:${memory.name}`, title: memory.name.slice(0, 160), statement: (memory.summary ?? "").slice(0, 600),
      attributes: { origin: "bb-memory", memoryKind: memory.kind, tags: memory.tags ?? [], importance: memory.importance ?? null },
      confidence: 0.7, firstSeen: at, lastSeen: at, evidence: [{ source: "bb-memory", ref: `${memory.id}@v${memory.version ?? 1}`, at }],
    });
  }
  return { source: "bb-memory", items: memories.length, records, ...(skipped ? { note: `${skipped} memories (procedures, references) describe the work, not the owner, and were skipped` } : {}) };
}

/** BB's global memories through the `bb` CLI of the machine; without it the source reports why and adds nothing. */
export async function scanBbMemory(run: (args: string[]) => Promise<string> = defaultBb): Promise<SourceScan> {
  try {
    const parsed = JSON.parse(await run(["memory", "catalog", "--scope", "global", "--limit", "100", "--json"])) as { memories?: CatalogEntry[] };
    return recordsFromBbCatalog(Array.isArray(parsed.memories) ? parsed.memories : []);
  } catch (cause) {
    return { source: "bb-memory", items: 0, records: [], note: `bb memory unavailable here: ${cause instanceof Error ? cause.message.slice(0, 120) : String(cause)}` };
  }
}

function defaultBb(args: string[]): Promise<string> {
  const bin = process.env.LANE_PILOT_BB_BIN || "bb";
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":") } },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}
