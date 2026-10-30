import { createHash } from "node:crypto";

/** A repo-relative path a note names (`src/rooms/memory/memory.ts`). Bare words are not paths. */
const PATH_RE = /(?:^|[\s`'"(])((?:[\w.@+-]+\/)+[\w.@+-]+\.\w+)/g;

export function pathsNamed(text: string): string[] {
  return [...new Set([...text.matchAll(PATH_RE)].map((match) => match[1]!))].filter((path) => !path.split("/").includes("..")).sort();
}

/**
 * Short hash of the named files, in path order. A missing file is not the same as an empty one.
 * Stored as `file_fingerprint` when the write can read the workspace. `mixWriterMemory` skips a note whose hash no longer matches.
 */
export function fileFingerprint(parts: ReadonlyArray<{ path: string; bytes: Uint8Array | null }>): string {
  const hash = createHash("sha256");
  for (const part of [...parts].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(part.path);
    hash.update("\0");
    if (part.bytes) hash.update(part.bytes);
    hash.update(part.bytes ? "\0file" : "\0missing");
  }
  return hash.digest("hex").slice(0, 16);
}

/** The files a note named have changed since `stored` was taken. No stored hash and no paths: nothing to recheck. */
export function filesDrifted(stored: string | null | undefined, paths: readonly string[], read: (path: string) => Uint8Array | null): boolean {
  if (!stored || paths.length === 0) return false;
  return stored !== fileFingerprint(paths.map((path) => ({ path, bytes: read(path) })));
}
