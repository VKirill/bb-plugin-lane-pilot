import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Rename errors a lock holder lets go of in a moment: a Windows antivirus scan or an open file gives EPERM/EBUSY. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Temp file and rename for Windows too (SMA k_lib_fsatomics): the rename is retried on a lock, anything else throws at once. */
export async function renameRetry(from: string, to: string, renameFn: (from: string, to: string) => Promise<void> = rename, tries = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await renameFn(from, to); return; }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (attempt >= tries || !code || !RENAME_RETRY_CODES.has(code)) throw cause;
      await new Promise((done) => setTimeout(done, 20 * attempt + Math.floor(Math.random() * 20)));
    }
  }
}

/** One writer-visible write of a small text file: tmp + rename, so a reader never sees half a file. */
export async function atomicText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, text, { mode: 0o600, flag: "wx" }); await renameRetry(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}
