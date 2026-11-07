import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** One writer-visible write of a small text file: tmp + rename, so a reader never sees half a file. */
export async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, text, { mode: 0o600, flag: "wx" }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
