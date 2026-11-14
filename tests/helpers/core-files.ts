import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A fake of `bb.sdk.files.write` that follows the BB core (bb-core vk packages/file-transfer replace-file.ts), so a test sees what the core does:
 *   - `expectedSha256` key absent (or undefined): replace the file unconditionally;
 *   - `expectedSha256: null`: the file must not exist, otherwise `{ outcome: "conflict", currentSha256 }` is RETURNED, nothing is written, nothing throws;
 *   - `expectedSha256: "<hash>"`: replace only when the file's hash equals it, otherwise the same conflict.
 * A fake that overwrites whatever it is given hid a silent no-op for the whole life of the task home (0.1.567).
 */
export type FileStore = { get(path: string): string | null; set(path: string, content: string): void };

export const mapStore = (files: Map<string, string>): FileStore => ({ get: (path) => files.get(path) ?? null, set: (path, content) => { files.set(path, content); } });

export const diskStore = (): FileStore => ({
  get: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  set: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8"); },
});

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function coreFileWrite(store: FileStore, onWritten?: (path: string, content: string) => void) {
  return async (args: unknown): Promise<{ outcome: "written"; sha256: string; sizeBytes: number } | { outcome: "conflict"; currentSha256: string | null }> => {
    const { path, content, expectedSha256 } = args as { path: string; content: string; expectedSha256?: string | null };
    const current = store.get(path);
    const currentSha256 = current === null ? null : sha(current);
    if (expectedSha256 !== undefined && expectedSha256 !== currentSha256) return { outcome: "conflict", currentSha256 };
    store.set(path, content);
    onWritten?.(path, content);
    return { outcome: "written", sha256: sha(content), sizeBytes: Buffer.byteLength(content) };
  };
}
