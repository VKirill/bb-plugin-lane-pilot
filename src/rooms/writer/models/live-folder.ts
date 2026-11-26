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
/** Files above this size are fingerprinted by size and mtime, not by content. */
export const LIVE_FOLDER_BIG_BYTES = 20 * 1024 * 1024;
export const LIVE_BACKUP_KEEP_DAYS = 7;
/** A task whose owned files weigh more than this cannot be backed up for a rollback. */
export const LIVE_BACKUP_BYTES_CAP = 2 * 1024 ** 3;
/**
 * BB's host worker refuses a host call answer above 8 MiB (`host output for runCommand exceeds 8388608 bytes`). A plain
 * JSON listing costs ~180 bytes a file, so a folder well under the file cap overflowed it; the listing travels zlib-
 * compressed in base64 (~65 bytes a file) and the script refuses an answer above this budget with a reason the owner reads.
 */
export const LIVE_SNAPSHOT_OUTPUT_BYTES = 6 * 1024 * 1024;
/** Prefix of a compressed snapshot answer: `z:` + base64 of the zlib-compressed JSON rows. */
export const COMPRESSED_PREFIX = "z:";
/** One command line carries at most ~128 KB on Linux; a path list travels in chunks well below it. */
export const CHUNK_JSON_BYTES = 60_000;

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
/** A tracked file `git status` reports deleted inside a nested repository: it is listed so its removal reads as a change. */
export const LIVE_DELETED_SHA = "deleted";

/**
 * Lists every regular file and symlink of the folder (cwd) with a sha256; run by python3 in the folder. A nested git
 * repository (a folder with its own `.git`) is listed by `git status` only, its changed, untracked and deleted files:
 * its clean files are in its own git, and walked one by one an umbrella of 41 plugin repositories went past the file
 * cap (BB-сервис 2026-10-10: 51 467 files, of them ~1 700 changed). A repository git cannot read is walked like a folder.
 */
export const LIVE_SNAPSHOT_SCRIPT = String.raw`import hashlib, os, subprocess, sys, zlib
SKIP_DIRS = set(PAYLOAD["skip_dirs"])
SKIP_PATHS = set(PAYLOAD["skip_paths"])
rows = []
gone = set()
def is_repo(rel):
    return os.path.lexists(os.path.join(".", rel, ".git"))
def repo_changes(rel):
    try:
        ran = subprocess.run(["git", "-C", os.path.join(".", rel), "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return None
    if ran.returncode != 0:
        return None
    parts = ran.stdout.split(b"\0")
    found = []
    index = 0
    while index < len(parts):
        entry = parts[index]
        index += 1
        if len(entry) < 4:
            continue
        code = entry[:2].decode("ascii", "replace")
        found.append(os.fsdecode(entry[3:]))
        if "R" in code or "C" in code:
            if index < len(parts) and parts[index]:
                found.append(os.fsdecode(parts[index]))
            index += 1
    return found
def add_repo(rel):
    changes = repo_changes(rel)
    if changes is None:
        return False
    for path in changes:
        full_rel = rel + "/" + path.rstrip("/")
        if any(part in SKIP_DIRS for part in full_rel.split("/")):
            continue
        if path.endswith("/"):
            if not (is_repo(full_rel) and add_repo(full_rel)):
                walk(full_rel)
        else:
            rows.append(full_rel)
            gone.add(full_rel)
    return True
def walk(root):
    for dirpath, dirnames, filenames in os.walk(os.path.join(".", root) if root else ".", followlinks=False):
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
            elif not (is_repo(rel) and add_repo(rel)):
                keep.append(name)
        dirnames[:] = keep
        for name in filenames:
            if name == ".git":
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or os.path.isfile(full):
                rows.append(rel_dir + "/" + name if rel_dir else name)
walk("")
rows = sorted(set(rows))
if len(rows) > PAYLOAD["cap"]:
    sys.stderr.write("too_large:%d\n" % len(rows))
    sys.exit(3)
out = []
for rel in rows:
    full = os.path.join(".", rel)
    if rel in gone and not os.path.lexists(full):
        out.append({"path": rel, "sha256": PAYLOAD["deleted"]})
        continue
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
    except (FileNotFoundError, IsADirectoryError, NotADirectoryError):
        continue
    out.append({"path": rel, "sha256": digest})
answer = base64.b64encode(zlib.compress(json.dumps(out, ensure_ascii=True, separators=(",", ":")).encode("ascii"), 9)).decode("ascii")
if len(answer) > PAYLOAD["max_output"]:
    sys.stderr.write("too_large_output:%d:%d\n" % (len(out), len(answer)))
    sys.exit(3)
print("z:" + answer)
`;

export function liveOwnedFiles(paths: readonly string[], task: { owns_paths: string[]; never_touch: string[] }): string[] {
  return paths.filter((path) => fileAllowedByOwns(path, task.owns_paths) && !fileBlockedByNeverTouch(path, task.never_touch));
}

/** The folders (or files) owns_paths can reach: each pattern up to its first wildcard; "" is the whole folder. */
export function liveOwnedRoots(ownsPaths: readonly string[]): string[] {
  const roots = ownsPaths.map((pattern) => {
    const parts: string[] = [];
    for (const part of pattern.replaceAll("\\", "/").replace(/^\.\//, "").split("/")) {
      if (/[*?\[]/.test(part)) break;
      parts.push(part);
    }
    return parts.filter(Boolean).join("/");
  });
  return roots.includes("") ? [""] : [...new Set(roots)].sort();
}

/**
 * Every file and symlink under the task's owned roots, nested repositories included: the backup and the rollback need
 * the clean files too, which the snapshot leaves out of a nested repository. Paths only, no hashes.
 */
export const LIVE_OWNED_LIST_SCRIPT = String.raw`import os, sys, zlib
SKIP_DIRS = set(PAYLOAD["skip_dirs"])
SKIP_PATHS = set(PAYLOAD["skip_paths"])
rows = set()
for root in PAYLOAD["roots"]:
    if root and (os.path.isabs(root) or ".." in root.split("/")):
        continue
    top = os.path.join(".", root) if root else "."
    if os.path.islink(top) or os.path.isfile(top):
        rows.add(root)
        continue
    for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
        rel_dir = os.path.relpath(dirpath, ".").replace(os.sep, "/")
        if rel_dir == ".":
            rel_dir = ""
        keep = []
        for name in sorted(dirnames):
            rel = rel_dir + "/" + name if rel_dir else name
            if name in SKIP_DIRS or rel in SKIP_PATHS:
                continue
            if os.path.islink(os.path.join(dirpath, name)):
                rows.add(rel)
            else:
                keep.append(name)
        dirnames[:] = keep
        for name in filenames:
            if name == ".git":
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full) or os.path.isfile(full):
                rows.add(rel_dir + "/" + name if rel_dir else name)
    if len(rows) > PAYLOAD["cap"]:
        sys.stderr.write("too_large:%d\n" % len(rows))
        sys.exit(3)
print("z:" + base64.b64encode(zlib.compress(json.dumps(sorted(rows), ensure_ascii=True, separators=(",", ":")).encode("ascii"), 9)).decode("ascii"))
`;

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
trash = os.path.join(os.path.expanduser("~"), ".agents", "lane-pilot", "bin", "agent-trash")
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

export function parseBackupFailure(ran: { exitCode: number; stderr: string }): string {
  const bytes = /too_large_backup:(\d+)/.exec(ran.stderr)?.[1];
  if (ran.exitCode === 3 && bytes) return `owned files too large for no-git mode: ${Math.round(Number(bytes) / 1024 / 1024)} MB cannot be backed up for a rollback; narrow owns_paths`;
  return `cannot back up the owned files (no git): ${ran.stderr.trim() || `exit ${ran.exitCode}`}`;
}
