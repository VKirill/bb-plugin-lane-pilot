/**
 * A write through the bb file API that replaces the file. In the bb core `expectedSha256: null` means "the file must not exist": an
 * existing file answers `{ outcome: "conflict" }` (HTTP 200, nothing thrown, nothing written), so every second write of a path through
 * it is a silent no-op. This helper leaves the key out (replace unconditionally) and throws when the answer says anything but `written`.
 */
export type ReplacingWrite = { hostId: string; rootPath: string; path: string; content: string; createParents: boolean };

export async function writeReplacing(
  files: { write(args: ReplacingWrite & { contentEncoding: "utf8" }): Promise<unknown> | unknown },
  args: ReplacingWrite,
): Promise<void> {
  const result = await files.write({ ...args, contentEncoding: "utf8" });
  const outcome = result && typeof result === "object" ? (result as { outcome?: unknown }).outcome : undefined;
  if (outcome !== undefined && outcome !== "written") throw new Error(`the write of ${args.path} was not applied (${String(outcome)})`);
}
