import { inflateSync } from "node:zlib";
import { BOUNDED_READ_MAX_FILE_BYTES } from "@lane-pilot/kit";
import { LIVE_BACKUP_KEEP_DAYS, pythonCommand } from "./live-folder";

/**
 * Reads the before-side of a live-folder attempt from its backup in ~/.lane-pilot/live-backups/<id>/, written by
 * LIVE_BACKUP_SCRIPT. Run on the folder's own host with cwd = the live folder, so manifest.cwd (the backup's realpath)
 * is checked against the folder exactly like LIVE_RESTORE_SCRIPT does. Two outcomes, never a fallback to the current
 * file: `bytes` (the backed-up content) or `unknown` with a reason. A path missing from files.txt is `not_in_backup`,
 * NOT proof the file is new: the manifest lists only the paths the backup covered (the task's owned files), so absence
 * says nothing about whether the file existed before — the caller needs separate before-time coverage evidence before
 * it can treat a path as writer-created.
 *
 * Symlink/containment checks are best-effort on a plugin-private backup tree: they reject symlinked ancestors and
 * verify realpath containment, but a hostile process racing writes inside the backup directory between check and open
 * is outside the guaranteed envelope (the tree is not concurrently writable by design).
 */

/** Prefix of a compressed answer: `z:` + base64 of the zlib-compressed file bytes (same wire shape as the snapshot). */
const COMPRESSED_PREFIX = "z:";
/** The host worker refuses answers above 8 MiB; the serialized answer stays under it with margin for the JSON wrapper. */
export const LIVE_BACKUP_READ_MAX_OUTPUT_BYTES = 8 * 1024 * 1024 - 4096;
/** files.txt is scanned whole; bound it so a planted huge index cannot exhaust memory. */
export const LIVE_BACKUP_READ_MAX_INDEX_BYTES = 8 * 1024 * 1024;

/**
 * manifest.json exists only when the backup finished, so its presence means complete; the whole files.txt index is
 * validated (canonical paths, {p,l} rows, no duplicates) before any lookup; manifest.cwd must equal realpath(cwd);
 * created_at older than the keep time reads as expired even if pruning has not run yet; backup id rejects dot/dotdot;
 * paths must be canonical relative (no abs, empty, dot or dotdot segments); every ancestor of the content file is
 * checked for symlinks and the resolved path must stay inside the resolved files root; output is zlib+base64 with a
 * serialized-size check because incompressible bytes do not shrink.
 */
export const LIVE_BACKUP_READ_SCRIPT = String.raw`import base64, json, os, re, sys, time, zlib
backup_id = PAYLOAD["id"]
if not re.fullmatch(r"[A-Za-z0-9_.-]+", backup_id) or backup_id in (".", ".."):
    sys.exit("bad backup id")
def canonical(rel):
    if not rel or os.path.isabs(rel):
        return None
    parts = rel.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return "/".join(parts)
rel = canonical(PAYLOAD["path"])
if rel is None:
    print(json.dumps({"state": "unknown", "reason": "unsafe_path"}))
    sys.exit(0)
lane = os.path.join(os.path.expanduser("~"), ".lane-pilot")
base = os.path.join(lane, "live-backups")
bdir = os.path.join(base, backup_id)
files_root = os.path.join(bdir, "files")
manifest_path = os.path.join(bdir, "manifest.json")
listing_path = os.path.join(bdir, "files.txt")
cwd = os.getcwd()
def unknown(reason):
    print(json.dumps({"state": "unknown", "reason": reason}))
    sys.exit(0)
for ancestor in (lane, base, bdir, files_root):
    if os.path.islink(ancestor):
        unknown("unsafe_backup")
if not os.path.isdir(bdir):
    unknown("no_backup")
for meta in (manifest_path, listing_path):
    if os.path.islink(meta):
        unknown("unsafe_backup")
try:
    saved = json.load(open(manifest_path))
except (OSError, ValueError):
    unknown("partial_backup")
if not isinstance(saved, dict) or saved.get("cwd") != os.path.realpath(cwd):
    unknown("backup_of_another_folder")
created = saved.get("created_at")
if not isinstance(created, (int, float)) or time.time() - created > PAYLOAD["max_age_seconds"]:
    unknown("expired")
if not os.path.isdir(files_root):
    unknown("partial_backup")
try:
    if os.path.getsize(listing_path) > PAYLOAD["max_index_bytes"]:
        unknown("too_large")
    with open(listing_path, "r", encoding="utf-8") as stream:
        lines = stream.read().splitlines()
except OSError:
    unknown("partial_backup")
rows = []
seen = set()
for line in lines:
    try:
        entry = json.loads(line)
    except ValueError:
        unknown("invalid_index")
    if not isinstance(entry, dict) or not isinstance(entry.get("p"), str) or canonical(entry["p"]) != entry["p"]:
        unknown("invalid_index")
    if "l" not in entry or (entry["l"] is not None and not isinstance(entry["l"], str)):
        unknown("invalid_index")
    if entry["p"] in seen:
        unknown("duplicate_index")
    seen.add(entry["p"])
    rows.append((entry["p"], entry["l"]))
match = [link for path, link in rows if path == rel]
if not match:
    unknown("not_in_backup")
if match[0] is not None:
    unknown("symlink")
segments = rel.split("/")
node = files_root
for part in segments[:-1]:
    node = os.path.join(node, part)
    if os.path.islink(node):
        unknown("unsafe_backup")
src = os.path.join(node, segments[-1])
real_root = os.path.realpath(files_root)
real_src = os.path.realpath(src)
try:
    inside = os.path.commonpath((real_root, real_src)) == real_root
except ValueError:
    inside = False
if not inside or real_src == real_root or os.path.islink(src):
    unknown("unsafe_backup")
if not os.path.isfile(src):
    unknown("unreadable")
if os.path.getsize(src) > PAYLOAD["max_bytes"]:
    unknown("too_large")
try:
    with open(src, "rb") as stream:
        data = stream.read(PAYLOAD["max_bytes"] + 1)
except OSError:
    unknown("unreadable")
if len(data) > PAYLOAD["max_bytes"]:
    unknown("too_large")
answer = json.dumps({"state": "bytes", "content": "z:" + base64.b64encode(zlib.compress(data, 9)).decode("ascii")})
if len(answer.encode("utf-8")) > PAYLOAD["max_output"]:
    unknown("too_large")
print(answer)
`;

export type LiveBackupRead =
  | { state: "bytes"; content: string }
  | { state: "unknown"; reason: string };

export const liveBackupReadCommand = (input: { id: string; path: string; maxBytes?: number; maxAgeSeconds?: number }): string =>
  pythonCommand(LIVE_BACKUP_READ_SCRIPT, {
    id: input.id,
    path: input.path,
    max_bytes: Math.min(input.maxBytes ?? BOUNDED_READ_MAX_FILE_BYTES, BOUNDED_READ_MAX_FILE_BYTES),
    max_age_seconds: input.maxAgeSeconds ?? LIVE_BACKUP_KEEP_DAYS * 86400,
    max_index_bytes: LIVE_BACKUP_READ_MAX_INDEX_BYTES,
    max_output: LIVE_BACKUP_READ_MAX_OUTPUT_BYTES,
  });

/**
 * The reader's answer as bytes or unknown; every failure mode collapses to unknown with a reason. `maxBytes` is the
 * caller's configured bound (clamped to BOUNDED_READ_MAX_FILE_BYTES): the compressed wire size is checked before
 * decoding and inflateSync's maxOutputLength enforces the decoded bound, so a compact payload cannot expand past it.
 */
export function parseLiveBackupRead(ran: { exitCode: number; stdout: string; stderr: string }, maxBytes = BOUNDED_READ_MAX_FILE_BYTES): LiveBackupRead {
  if (ran.exitCode !== 0) return { state: "unknown", reason: `command_failed:${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
  const cap = Math.min(maxBytes, BOUNDED_READ_MAX_FILE_BYTES);
  // The whole serialized answer is bounded before JSON.parse: an oversized stdout is refused without parsing it.
  if (Buffer.byteLength(ran.stdout, "utf8") > Math.ceil(cap / 3) * 4 + 8448) return { state: "unknown", reason: "too_large" };
  try {
    const parsed = JSON.parse(ran.stdout.trim()) as { state?: unknown; reason?: unknown; content?: unknown };
    if (parsed.state === "unknown" && typeof parsed.reason === "string" && parsed.reason) return { state: "unknown", reason: parsed.reason };
    if (parsed.state !== "bytes" || typeof parsed.content !== "string" || !parsed.content.startsWith(COMPRESSED_PREFIX)) {
      return { state: "unknown", reason: "invalid_answer" };
    }
    const wire = parsed.content.slice(COMPRESSED_PREFIX.length);
    if (wire.length > Math.ceil(cap / 3) * 4 + 8192) return { state: "unknown", reason: "too_large" };
    let inflated: Buffer;
    try {
      inflated = inflateSync(Buffer.from(wire, "base64"), { maxOutputLength: cap });
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      return { state: "unknown", reason: code === "ERR_BUFFER_TOO_LARGE" || cause instanceof RangeError ? "too_large" : "invalid_answer" };
    }
    return { state: "bytes", content: inflated.toString("utf8") };
  } catch {
    return { state: "unknown", reason: "invalid_answer" };
  }
}
