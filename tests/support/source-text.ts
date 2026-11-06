import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "tests") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) yield path;
  }
}

/**
 * Text of the one source file under `within` that carries `marker`, with its path relative to the plugin root.
 * A guard that belongs to "wherever this code lives", not to a file path: a file move keeps the check, a removal
 * still fails it.
 */
export function fileContaining(marker: string, within = "src"): { path: string; text: string } {
  const found: Array<{ path: string; text: string }> = [];
  for (const file of sources(join(ROOT, within))) {
    const text = readFileSync(file, "utf8");
    if (text.includes(marker)) found.push({ path: file.slice(ROOT.length + 1), text });
    if (found.length > 1) break;
  }
  if (found.length > 1) throw new Error(`marker ${JSON.stringify(marker)} is in more than one file under ${within}/: ${found.map((f) => f.path).join(", ")} — pick a unique marker`);
  if (!found.length) throw new Error(`no source file under ${within}/ contains ${JSON.stringify(marker)}`);
  return found[0]!;
}

/** All source files under `within` carrying `marker` (paths relative to the plugin root), for "no file may" guards. */
export function filesContaining(marker: string | RegExp, within = "src"): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const file of sources(join(ROOT, within))) {
    const text = readFileSync(file, "utf8");
    const hit = typeof marker === "string" ? text.includes(marker) : marker.test(text);
    if (hit) out.push({ path: file.slice(ROOT.length + 1), text });
  }
  return out;
}
