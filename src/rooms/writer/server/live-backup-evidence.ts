import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import { liveBackupReadCommand, parseLiveBackupRead, type LiveBackupRead } from "../live-backup-read";

/** Read only from the attempt's backup on the live folder's own host. */
export async function readLiveBefore(host: RunCommandHost, hostId: string, cwd: string, attemptId: string, path: string): Promise<LiveBackupRead> {
  try {
    return parseLiveBackupRead(await runOnHost(host, { hostId, cwd, command:liveBackupReadCommand({ id:attemptId, path }), timeoutSec:30 }));
  } catch {
    return { state:"unknown", reason:"host_unavailable" };
  }
}

/** A complete replacement hunk, bounded so the critic never receives a silently partial diff. */
export function liveBackupPatch(path: string, before: string, after: string): string | null {
  if (before === after) return `--- a/${path}\n+++ b/${path}\n`;
  if (Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8") > 64 * 1024) return null;
  const lines = (text: string, prefix: string) => {
    if (!text) return { count:0, text:"" };
    const rows = text.split("\n");
    const newline = text.endsWith("\n");
    if (newline) rows.pop();
    return { count:rows.length, text:rows.map((row, i) => `${prefix}${row}\n${!newline && i === rows.length - 1 ? "\\ No newline at end of file\n" : ""}`).join("") };
  };
  const old = lines(before, "-"), next = lines(after, "+");
  const patch = `--- a/${path}\n+++ b/${path}\n@@ -${old.count ? 1 : 0},${old.count} +${next.count ? 1 : 0},${next.count} @@\n${old.text}${next.text}`;
  return Buffer.byteLength(patch, "utf8") <= 64 * 1024 ? patch : null;
}
