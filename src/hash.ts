import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

export function sha256Buffer(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function sha256Tree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        hash.update(`L:${next}->${await readlink(abs)}\n`);
      } else if (entry.isDirectory()) {
        hash.update(`D:${next}\n`);
        await walk(abs, next);
      } else if (entry.isFile()) {
        hash.update(`F:${next}:${await sha256File(abs)}\n`);
      }
    }
  }
  await walk(root, "");
  return hash.digest("hex");
}

export async function hashPath(path: string): Promise<{
  kind: "file" | "directory" | "symlink" | "other";
  sha256: string | null;
  symlinkTarget: string | null;
}> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    return { kind: "symlink", sha256: sha256Buffer(target), symlinkTarget: target };
  }
  if (info.isFile()) return { kind: "file", sha256: await sha256File(path), symlinkTarget: null };
  if (info.isDirectory()) return { kind: "directory", sha256: await sha256Tree(path), symlinkTarget: null };
  return { kind: "other", sha256: null, symlinkTarget: null };
}

export async function sha256FileOrNull(path: string): Promise<string | null> {
  try {
    return sha256Buffer(await readFile(path));
  } catch {
    return null;
  }
}
