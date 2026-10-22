import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_PATHS, MEMORY_PRIMITIVES, type MemoryPrimitive } from "../src/rooms/memory/memory-paths";

const ROOT = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "node_modules") sourceFiles(path, out); }
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Calls of each primitive per file, by file path relative to the repository: definitions, imports, comments and the RPC contract are not calls. */
function scan(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const rel = relative(ROOT, file);
    // The contract only names the RPC methods; the probe and the retrieval evaluation are verifiers, not paths (they call the helpers to look at what they return).
    if (rel.startsWith("src/rooms/contracts/") || rel === "src/rooms/memory-probe/server/memory-probe.ts" || rel.startsWith("src/rooms/memory-eval/")) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const text = line.trim();
      if (!text || text.startsWith("//") || text.startsWith("*") || text.startsWith("/*") || text.startsWith("import ") || text.startsWith("export {") || text.startsWith("export type")) continue;
      for (const primitive of MEMORY_PRIMITIVES) {
        if (new RegExp(`^(export\\s+)?(async\\s+)?function\\s+${primitive}\\b`).test(text)) continue;
        const hits = text.match(new RegExp(`\\b${primitive}\\s*[(:]`, "g"));
        if (hits) found.set(`${rel}|${primitive}`, (found.get(`${rel}|${primitive}`) ?? 0) + hits.length);
      }
    }
  }
  return found;
}

describe("memory path registry", () => {
  const registered = new Map<string, number>();
  for (const entry of MEMORY_PATHS) for (const site of entry.sites) registered.set(`${site.file}|${site.primitive}`, (registered.get(`${site.file}|${site.primitive}`) ?? 0) + site.count);

  it("knows every place that injects or fetches memory, rules or owner facts for an agent", () => {
    const found = scan();
    const unregistered = [...found].filter(([key, count]) => registered.get(key) !== count).map(([key, count]) => `${key} x${count} (registry: ${registered.get(key) ?? 0})`);
    const stale = [...registered].filter(([key]) => !found.has(key)).map(([key, count]) => `${key} x${count} (not in the source any more)`);
    expect(unregistered, "add the new site to MEMORY_PATHS in src/rooms/memory/memory-paths.ts (a path with a probe, or an exempt one with a reason)").toEqual([]);
    expect(stale, "remove the site from MEMORY_PATHS").toEqual([]);
  });

  it("has unique ids, and each entry is either probed or says why not", () => {
    expect(new Set(MEMORY_PATHS.map((entry) => entry.id)).size).toBe(MEMORY_PATHS.length);
    for (const entry of MEMORY_PATHS) {
      if (entry.status === "exempt") expect(entry.reason?.length, entry.id).toBeGreaterThan(20);
      else expect(entry.carries.length, entry.id).toBeGreaterThan(0);
      expect(entry.alwaysOn.every((kind) => entry.carries.includes(kind)), `${entry.id}: alwaysOn is a subset of carries`).toBe(entry.status === "probed" || entry.alwaysOn.length === 0);
    }
  });

  it("every primitive in the list is used somewhere (a dead name would hide a missing scan)", () => {
    const used = new Set([...scan().keys()].map((key) => key.split("|")[1] as MemoryPrimitive));
    expect([...MEMORY_PRIMITIVES].filter((name) => !used.has(name))).toEqual([]);
  });
});
