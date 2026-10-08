import type { DirtSnapshot } from "./cli-outcome";
import { fileAllowedByOwns, fileBlockedByNeverTouch } from "@lane-pilot/kit";

/**
 * «Folder without git» mode: the owner runs the orchestrator in a plain folder and writers edit the live files. There is
 * no worktree, no commit and no merge; a content-hash snapshot of the folder stands in for `git status`, and the files a
 * task owns are copied aside before each attempt so a rejected attempt can be rolled back. Every script here runs on the
 * folder's own host through `runCommand` (the hub cannot see a remote folder).
 */

/** `workspace_decision.reason` of an attempt that works in a folder without git. */
export const LIVE_FOLDER_REASON = "live_folder";
/** The receipt's `workspace` value of an accepted attempt in such a folder. */
export const LIVE_FOLDER_RECEIPT = "live-folder";
/** More files than this and the snapshot would be slower than the work: the owner puts the folder under git. */
export const LIVE_FOLDER_FILE_CAP = 50_000;
/** Files above this size are fingerprinted by size and mtime, not by content. */
export const LIVE_FOLDER_BIG_BYTES = 20 * 1024 * 1024;
export const LIVE_BACKUP_KEEP_DAYS = 7;
/** A task whose owned files weigh more than this cannot be backed up for a rollback. */
export const LIVE_BACKUP_BYTES_CAP = 2 * 1024 ** 3;
/** One command line carries at most ~128 KB on Linux; a path list travels in chunks well below it. */
const CHUNK_JSON_BYTES = 60_000;

export const isLiveDecision = (decision: unknown): boolean =>
  Boolean(decision && typeof decision === "object" && (decision as { reason?: unknown }).reason === LIVE_FOLDER_REASON);

export const LIVE_FOLDER_PROBE_COMMAND = "git rev-parse --is-inside-work-tree";

export type FolderProbe = "git" | "no-git" | "unknown";

/** Git answers 128 «not a git repository» in a plain folder and the shell 127 when git is not installed at all. */
export function classifyFolderProbe(ran: { exitCode?: unknown; stderr?: unknown } | null | undefined): FolderProbe {
  if (!ran || typeof ran.exitCode !== "number") return "unknown";
  if (ran.exitCode === 0) return "git";
  if (ran.exitCode === 127) return "no-git";
  if (ran.exitCode === 128 && /not a git repository/i.test(String(ran.stderr ?? ""))) return "no-git";
  return "unknown";
}

/** Directories skipped at any depth; `.agents/runs` and `.agents/memory` are skipped as paths. */
export const LIVE_SNAPSHOT_SKIP_DIRS = [".git", "node_modules", ".bb", ".cache", ".vite", ".vitest", ".turbo", ".next", ".nuxt", "dist", "coverage", "__pycache__", ".venv", "venv"];
export const LIVE_SNAPSHOT_SKIP_PATHS = [".agents/runs", ".agents/memory"];

/** Wraps a python script and its JSON payload into one command (the payload is base64: no quoting, no heredoc clash). */
export function pythonCommand(script: string, payload: unknown = {}): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `python3 - <<'PY'\nimport base64, json\nPAYLOAD = json.loads(base64.b64decode("${encoded}").decode("utf-8"))\n${script}PY`;
}

/** Lists every regular file and symlink of the folder (cwd) with a sha256; run by python3 in the folder. */
export const LIVE_SNAPSHOT_SCRIPT = String.raw`import hashlib, os, sys
SKIP_DIRS = set(PAYLOAD["skip_dirs"])
SKIP_PATHS = set(PAYLOAD["skip_paths"])
rows = []
for dirpath, dirnames, filenames in os.walk(".", followlinks=False):
    rel_dir = os.path.relpath(dirpath, ".").replace(os.sep, "/")
    if rel_dir == ".":
        rel_dir = ""
    keep = []
    for name in sorted(dirnames):
        rel = rel_dir + "/" + name if rel_dir else name
        if name in SKIP_DIRS or rel in SKIP_PATHS:
            continue
        if os.path.islink(os.path.join(dirpath, name)):
            rows.append(rel)
        else:
            keep.append(name)
    dirnames[:] = keep
    for name in filenames:
        if name == ".git":
            continue
        full = os.path.join(dirpath, name)
        if os.path.islink(full) or os.path.isfile(full):
            rows.append(rel_dir + "/" + name if rel_dir else name)
if len(rows) > PAYLOAD["cap"]:
    sys.stderr.write("too_large:%d\n" % len(rows))
    sys.exit(3)
out = []
for rel in sorted(rows):
    full = os.path.join(".", rel)
    try:
        if os.path.islink(full):
            digest = hashlib.sha256(b"symlink:" + os.fsencode(os.readlink(full))).hexdigest()
        else:
            info = os.stat(full)
            if info.st_size > PAYLOAD["big"]:
                digest = hashlib.sha256(("big:%d:%d" % (info.st_size, info.st_mtime_ns)).encode()).hexdigest()
            else:
                hasher = hashlib.sha256()
                with open(full, "rb") as stream:
                    for chunk in iter(lambda: stream.read(1 << 20), b""):
                        hasher.update(chunk)
                digest = hasher.hexdigest()
    except FileNotFoundError:
        continue
    out.append({"path": rel, "sha256": digest})
print(json.dumps(out, ensure_ascii=True))
`;

export const liveSnapshotCommand = (cap = LIVE_FOLDER_FILE_CAP): string => pythonCommand(LIVE_SNAPSHOT_SCRIPT, {
  skip_dirs: LIVE_SNAPSHOT_SKIP_DIRS, skip_paths: LIVE_SNAPSHOT_SKIP_PATHS, cap, big: LIVE_FOLDER_BIG_BYTES,
});

/** The snapshot command's answer as dirt snapshots, or the reason the owner reads. */
export function parseLiveSnapshot(ran: { exitCode: number; stdout: string; stderr: string }): { ok: true; snapshots: DirtSnapshot[] } | { ok: false; reason: string } {
  if (ran.exitCode === 3) {
    const count = /too_large:(\d+)/.exec(ran.stderr)?.[1];
    if (count) return { ok: false, reason: `folder too large for no-git mode: ${count} files; put it under git` };
  }
  if (ran.exitCode !== 0) return { ok: false, reason: `cannot snapshot the folder (no git): ${ran.stderr.trim() || `exit ${ran.exitCode}`}` };
  try {
    const parsed = JSON.parse(ran.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.some((row) => !row || typeof row !== "object"
      || typeof (row as DirtSnapshot).path !== "string" || typeof (row as DirtSnapshot).sha256 !== "string")) {
      return { ok: false, reason: "cannot snapshot the folder (no git): unexpected answer" };
    }
    return { ok: true, snapshots: (parsed as DirtSnapshot[]).map((row) => ({ path: row.path, sha256: row.sha256 })) };
  } catch {
    return { ok: false, reason: "cannot snapshot the folder (no git): invalid answer" };
  }
}

/** The files of a snapshot a task may change: matching owns_paths and not never_touch. */
export function liveOwnedFiles(paths: readonly string[], task: { owns_paths: string[]; never_touch: string[] }): string[] {
  return paths.filter((path) => fileAllowedByOwns(path, task.owns_paths) && !fileBlockedByNeverTouch(path, task.never_touch));
}

/** Splits a path list so each part fits one command line. */
export function chunkPaths(paths: readonly string[], maxJsonBytes = CHUNK_JSON_BYTES): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 2;
  for (const path of paths) {
    const bytes = Buffer.byteLength(JSON.stringify(path), "utf8") + 1;
    if (current.length && size + bytes > maxJsonBytes) { chunks.push(current); current = []; size = 2; }
    current.push(path);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const BACKUP_PRELUDE = String.raw`import os, re, shutil, sys, time
backup_id = PAYLOAD["id"]
if not re.fullmatch(r"[A-Za-z0-9_.-]+", backup_id):
    sys.exit("bad backup id")
base = os.path.join(os.path.expanduser("~"), ".lane-pilot", "live-backups")
bdir = os.path.join(base, backup_id)
cwd = os.getcwd()
def safe(rel):
    if os.path.isabs(rel) or ".." in rel.split("/"):
        sys.exit("unsafe path: " + rel)
    return rel
`;

/** Copies owned files into ~/.lane-pilot/live-backups/<id>/files (chunk by chunk) and prunes backups older than the keep time. */
export const LIVE_BACKUP_SCRIPT = BACKUP_PRELUDE + String.raw`manifest = os.path.join(bdir, "manifest.json")
if os.path.exists(manifest):
    print(json.dumps({"reused": True}))
    sys.exit(0)
listing = os.path.join(bdir, "files.txt")
counter = os.path.join(bdir, "bytes.txt")
if PAYLOAD["begin"]:
    os.makedirs(base, exist_ok=True)
    cutoff = time.time() - PAYLOAD["keep_days"] * 86400
    for entry in os.listdir(base):
        old = os.path.join(base, entry)
        if entry != backup_id and re.fullmatch(r"[A-Za-z0-9_.-]+", entry) and os.path.isdir(old) and not os.path.islink(old) and os.path.getmtime(old) < cutoff:
            shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(bdir):
        shutil.rmtree(bdir, ignore_errors=True)
    os.makedirs(os.path.join(bdir, "files"))
    with open(listing, "w") as stream:
        pass
    with open(counter, "w") as stream:
        stream.write("0")
total = int(open(counter).read() or "0")
copied = 0
with open(listing, "a") as stream:
    for rel in PAYLOAD["files"]:
        safe(rel)
        src = os.path.join(cwd, rel)
        if os.path.islink(src):
            stream.write(json.dumps({"p": rel, "l": os.readlink(src)}) + "\n")
            copied += 1
        elif os.path.isfile(src):
            total += os.path.getsize(src)
            if total > PAYLOAD["cap_bytes"]:
                sys.stderr.write("too_large_backup:%d\n" % total)
                sys.exit(3)
            dest = os.path.join(bdir, "files", rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(src, dest)
            stream.write(json.dumps({"p": rel, "l": None}) + "\n")
            copied += 1
with open(counter, "w") as stream:
    stream.write(str(total))
if PAYLOAD["finish"]:
    with open(manifest, "w") as stream:
        json.dump({"cwd": os.path.realpath(cwd), "created_at": time.time(), "bytes": total}, stream)
print(json.dumps({"copied": copied}))
`;

/** Puts every backed-up file back as it was (when it differs or is gone) and prints the backed-up list. */
export const LIVE_RESTORE_SCRIPT = BACKUP_PRELUDE + String.raw`import filecmp
try:
    saved = json.load(open(os.path.join(bdir, "manifest.json")))
except OSError:
    sys.stderr.write("no_backup\n")
    sys.exit(4)
if saved["cwd"] != os.path.realpath(cwd):
    sys.stderr.write("backup_of_another_folder\n")
    sys.exit(5)
files, restored, failed = [], [], []
for line in open(os.path.join(bdir, "files.txt")):
    row = json.loads(line)
    rel = safe(row["p"])
    files.append(rel)
    dst = os.path.join(cwd, rel)
    try:
        if row["l"] is not None:
            if os.path.islink(dst) and os.readlink(dst) == row["l"]:
                continue
            if os.path.lexists(dst):
                os.remove(dst)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.symlink(row["l"], dst)
        else:
            src = os.path.join(bdir, "files", rel)
            if os.path.isfile(dst) and not os.path.islink(dst) and filecmp.cmp(src, dst, shallow=False):
                continue
            if os.path.islink(dst):
                os.remove(dst)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
        restored.append(rel)
    except OSError as error:
        failed.append(rel + ": " + str(error))
print(json.dumps({"files": files, "restored": restored, "failed": failed}))
`;

/** Takes the files a writer created inside owns_paths out of the folder: agent-trash when the host has it, else into the backup dir. Never rm. */
export const LIVE_TRASH_SCRIPT = BACKUP_PRELUDE + String.raw`import subprocess
trash = os.path.join(os.path.expanduser("~"), ".agents", "bin", "agent-trash")
removed = []
for rel in PAYLOAD["created"]:
    safe(rel)
    path = os.path.join(cwd, rel)
    if not (os.path.islink(path) or os.path.isfile(path)):
        continue
    if os.access(trash, os.X_OK):
        ran = subprocess.run([trash, "-f", "--", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ran.returncode == 0 and not os.path.lexists(path):
            removed.append(rel)
            continue
    dest = os.path.join(bdir, "created", rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.move(path, dest)
    removed.append(rel)
print(json.dumps({"removed": removed}))
`;

export const liveBackupCommand = (input: { id: string; files: string[]; begin: boolean; finish: boolean }): string =>
  pythonCommand(LIVE_BACKUP_SCRIPT, { ...input, keep_days: LIVE_BACKUP_KEEP_DAYS, cap_bytes: LIVE_BACKUP_BYTES_CAP });
export const liveRestoreCommand = (id: string): string => pythonCommand(LIVE_RESTORE_SCRIPT, { id });
export const liveTrashCommand = (id: string, created: string[]): string => pythonCommand(LIVE_TRASH_SCRIPT, { id, created });

/** The reason a failed backup command is rejected with; the size cap gets its own text. */
export function parseBackupFailure(ran: { exitCode: number; stderr: string }): string {
  const bytes = /too_large_backup:(\d+)/.exec(ran.stderr)?.[1];
  if (ran.exitCode === 3 && bytes) return `owned files too large for no-git mode: ${Math.round(Number(bytes) / 1024 / 1024)} MB cannot be backed up for a rollback; narrow owns_paths`;
  return `cannot back up the owned files (no git): ${ran.stderr.trim() || `exit ${ran.exitCode}`}`;
}
