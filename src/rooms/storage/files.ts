import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "@lane-pilot/kit";

export const WORKFLOW_FILE_ID = /^[a-z][a-z0-9.-]{0,47}$/;
export const sha256Text = (text: string): string => sha256Hex(text);

export type WorkflowWrite = {
  status: "applied" | "conflict";
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  reason: string | null;
};

/**
 * Writes `<dir>/<id>.json` when the file is as the caller last saw it (`expectedSha256`, null for «does not exist»), so a
 * publish never overwrites a chain somebody else wrote or edited by hand. The file appears whole or not at all.
 */
export async function casWriteWorkflowFile(dir: string, id: string, content: string, expectedSha256: string | null): Promise<WorkflowWrite> {
  if (!WORKFLOW_FILE_ID.test(id)) throw new Error(`workflow id is not a file name: ${id}`);
  const path = join(dir, `${id}.json`);
  const before = await readFile(path, "utf8").then(sha256Text, (cause: NodeJS.ErrnoException) => { if (cause.code === "ENOENT") return null; throw cause; });
  if (before !== expectedSha256) {
    return {
      status: "conflict", path, beforeSha256: before, afterSha256: null,
      reason: before === null ? "the file was removed since it was published" : expectedSha256 === null ? "a file with this id already exists and was not published from this draft" : "the file was changed since it was published",
    };
  }
  await mkdir(dir, { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o644, flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return { status: "applied", path, beforeSha256: before, afterSha256: sha256Text(content), reason: null };
}
