import { BASELINE_LIMITS, baselineMessage, IGNORE_BLOCK, IGNORE_MARKER, SECRET_CONTENT_PATTERNS, type GitProbe } from "./logic";

/** A python script and its JSON payload as one shell command (base64 payload: no quoting, no heredoc clash). */
function pythonCommand(script: string, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `python3 - <<'PY'\nimport base64, json\nPAYLOAD = json.loads(base64.b64decode("${encoded}").decode("utf-8"))\n${script}PY`;
}

/**
 * Asked in the folder on its own host. «No Git» is only git's own «not a git repository (or any of the parent
 * directories)» with no `.git` anywhere up the path: a filesystem boundary, a broken gitdir, dubious ownership or a
 * missing git is `unknown`, never a reason to create a repository.
 */
const PROBE_SCRIPT = String.raw`import os, shutil, subprocess
def say(**kw):
    print(json.dumps(kw)); raise SystemExit(0)
cwd = os.path.realpath(os.getcwd())
if not shutil.which("git"): say(state="unknown", cwd=cwd, reason="git is not installed on this host")
def git(*args, at=None):
    return subprocess.run(["git", *args], cwd=at or cwd, capture_output=True, text=True)
top = git("rev-parse", "--show-toplevel")
if top.returncode == 0:
    root = os.path.realpath(top.stdout.strip())
    commit = git("rev-parse", "--verify", "-q", "HEAD", at=root).returncode == 0
    origin = git("remote", "get-url", "origin", at=root)
    if origin.returncode == 0 and origin.stdout.strip():
        say(state="origin", cwd=cwd, root=root, origin=origin.stdout.strip(), hasCommit=commit)
    if origin.returncode == 2 or "no such remote" in origin.stderr.lower():
        say(state="localNoOrigin", cwd=cwd, root=root, hasCommit=commit)
    say(state="unknown", cwd=cwd, root=root, reason="origin unreadable: " + origin.stderr.strip()[:300])
err = top.stderr.strip()
if top.returncode == 128 and "(or any of the parent directories)" in err:
    at = cwd
    while True:
        if os.path.lexists(os.path.join(at, ".git")): say(state="unknown", cwd=cwd, reason="a .git exists at " + at + " but git does not read it")
        up = os.path.dirname(at)
        if up == at: break
        at = up
    say(state="noGit", cwd=cwd)
say(state="unknown", cwd=cwd, reason=(err or "exit " + str(top.returncode))[:300])
`;

export const probeCommand = (): string => pythonCommand(PROBE_SCRIPT, {});

export function parseProbe(ran: { exitCode: number; stdout: string; stderr: string }): GitProbe {
  if (ran.exitCode !== 0) return { state: "unknown", reason: (ran.stderr.trim() || `exit ${ran.exitCode}`).slice(0, 300) };
  try {
    const row = JSON.parse(ran.stdout.trim().split("\n").pop() ?? "") as GitProbe;
    if (!["origin", "localNoOrigin", "noGit", "unknown"].includes(row.state)) return { state: "unknown", reason: "probe answer has no state" };
    return row;
  } catch { return { state: "unknown", reason: "probe answer is not JSON" }; }
}

/**
 * `git init` (only where git still finds no repository, or in the one this operation started) and the first commit of
 * the folder's real files: the ignore block first, then git's own list of untracked not-ignored files, each under the
 * size limit and scanned whole for credential-shaped content. Any blocked file stops it before anything is staged.
 * The commit is made from the checked tree with `commit-tree` (no hooks, no index race) onto an unborn branch.
 * A repository this operation did not start is never touched; an existing commit is recovered only when it is exactly
 * this operation's: the only commit in the repository, no parent, its trailer and the tree recorded before it was made.
 * Never `git add .`.
 */
const BASELINE_SCRIPT = String.raw`import hashlib, os, re, subprocess
P = PAYLOAD
def say(**kw):
    print(json.dumps(kw)); raise SystemExit(0)
def git(*args):
    return subprocess.run(["git", *args], capture_output=True)
def out(ran):
    return ran.stdout.decode("utf-8", "replace").strip()
if os.path.realpath(os.getcwd()) != P["root"]: say(ok=False, code="not_canonical", detail="the folder resolves to " + os.path.realpath(os.getcwd()) + ", not " + P["root"])
if os.path.lexists(".gitignore") and (os.path.islink(".gitignore") or not os.path.isfile(".gitignore")):
    say(ok=False, code="gitignore_not_plain", detail=".gitignore is a link or not a file; it is never written through")
MARK = os.path.join(".git", "lane-pilot-bootstrap")
def read_mark():
    try:
        with open(MARK, encoding="utf-8") as f: return json.load(f)
    except Exception: return None
def write_mark(mark):
    with open(MARK, "w", encoding="utf-8") as f: json.dump(mark, f)
if os.path.lexists(".git"):
    mark = read_mark()
    if os.path.islink(".git") or not os.path.isdir(".git") or not mark or mark.get("opId") != P["opId"]:
        say(ok=False, code="existing_repo", detail="a repository exists here that this bootstrap did not start")
else:
    top = git("rev-parse", "--show-toplevel")
    err = top.stderr.decode("utf-8", "replace")
    if top.returncode == 0: say(ok=False, code="inside_work_tree", detail="the folder is inside the repository " + out(top))
    if top.returncode != 128 or "(or any of the parent directories)" not in err: say(ok=False, code="probe_unknown", detail=err.strip()[:300])
    # The repository is made under a name of this operation, marked, and only then renamed to .git: a .git without the
    # mark is never this operation's, and a stop before the rename leaves the marked directory for the retry to finish.
    TMP = ".git-lp-" + P["opId"]
    if os.path.lexists(TMP):
        try:
            with open(os.path.join(TMP, "lane-pilot-bootstrap"), encoding="utf-8") as f: mark = json.load(f)
        except Exception: mark = None
        if os.path.islink(TMP) or not os.path.isdir(TMP) or not mark or mark.get("opId") != P["opId"]: say(ok=False, code="existing_repo", detail=TMP + " is not this bootstrap's")
    else:
        made = git("--git-dir=" + TMP, "init", "-q")
        if made.returncode != 0: say(ok=False, code="init_failed", detail=made.stderr.decode("utf-8", "replace").strip()[:300])
        git("--git-dir=" + TMP, "config", "core.bare", "false")
        mark = {"opId": P["opId"]}
        with open(os.path.join(TMP, "lane-pilot-bootstrap"), "w", encoding="utf-8") as f: json.dump(mark, f)
    os.rename(TMP, ".git")
    if os.path.realpath(out(git("rev-parse", "--absolute-git-dir"))) != os.path.join(P["root"], ".git"): say(ok=False, code="init_failed", detail="git reads its directory elsewhere")
if git("rev-parse", "--verify", "-q", "HEAD").returncode == 0:
    commit = out(git("rev-parse", "HEAD"))
    ours = (out(git("rev-list", "--all", "--count")) == "1"
            and out(git("rev-list", "--parents", "-n", "1", "HEAD")) == commit
            and out(git("log", "-1", "--format=%B", "HEAD")) == P["message"].strip()
            and mark.get("tree") and out(git("rev-parse", "HEAD^{tree}")) == mark["tree"])
    if not ours: say(ok=False, code="existing_history", detail="the repository has commits this bootstrap did not make; its history is never published")
    say(ok=True, commit=commit, tree=mark["tree"], branch=out(git("symbolic-ref", "--short", "HEAD")), files=git("ls-tree", "-r", "-z", "--name-only", "HEAD").stdout.count(b"\0"), reused=True)
try:
    existing = open(".gitignore", encoding="utf-8").read() if os.path.isfile(".gitignore") else ""
except (OSError, UnicodeDecodeError) as e:
    say(ok=False, code="gitignore_unreadable", detail=str(e)[:300])
if P["marker"] not in existing:
    with open(".gitignore", "w", encoding="utf-8") as f:
        f.write(P["block"] if not existing else existing + ("" if existing.endswith("\n") else "\n") + "\n" + P["block"])
# The index of a bootstrap that stopped after staging starts empty again: only this run's checked list is committed.
git("read-tree", "--empty")
listed = git("ls-files", "-z", "--others", "--exclude-standard")
if listed.returncode != 0: say(ok=False, code="list_failed", detail=listed.stderr.decode("utf-8", "replace").strip()[:300])
paths = [p.decode("utf-8", "surrogateescape") for p in listed.stdout.split(b"\0") if p]
if len(paths) > P["maxFiles"]: say(ok=False, code="too_many_files", detail=str(len(paths)) + " files to commit, the limit is " + str(P["maxFiles"]))
secrets = [re.compile(s.encode()) for s in P["secrets"]]
fmt = out(git("rev-parse", "--show-object-format")) or "sha1"
blobs = {}
blocked = []
for path in paths:
    if path.endswith("/"):
        blocked.append({"path": path, "why": "a nested repository"}); continue
    try:
        st = os.lstat(path)
    except OSError:
        blocked.append({"path": path, "why": "unreadable"}); continue
    if os.path.islink(path):
        blocked.append({"path": path, "why": "a link (links are not published in the first commit)"}); continue
    if st.st_size > P["maxFileBytes"]:
        blocked.append({"path": path, "why": "larger than " + str(P["maxFileBytes"] // (1024 * 1024)) + " MB"}); continue
    try:
        with open(path, "rb") as f: body = f.read(P["maxFileBytes"] + 1)
    except OSError:
        blocked.append({"path": path, "why": "unreadable"}); continue
    if len(body) > P["maxFileBytes"]: blocked.append({"path": path, "why": "grew while it was read"}); continue
    if any(rx.search(body) for rx in secrets): blocked.append({"path": path, "why": "looks like it holds a credential"}); continue
    blobs[path] = hashlib.new(fmt, b"blob %d\0" % len(body) + body).hexdigest()
if blocked: say(ok=False, code="blocked_files", detail=str(len(blocked)) + " file(s) cannot go into the first commit", blocked=blocked[:50])
for i in range(0, len(paths), 200):
    added = git("add", "--", *paths[i:i + 200])
    if added.returncode != 0: say(ok=False, code="add_failed", detail=added.stderr.decode("utf-8", "replace").strip()[:300])
staged = set(p.decode("utf-8", "surrogateescape") for p in git("diff", "--cached", "--name-only", "-z").stdout.split(b"\0") if p)
if staged != set(paths): say(ok=False, code="staged_mismatch", detail="the index differs from the checked list")
# The bytes git stored must be the bytes that were scanned: a file changed since, or a clean filter or EOL conversion, stops it.
for entry in git("ls-files", "-s", "-z").stdout.split(b"\0"):
    if not entry: continue
    meta, _, name = entry.partition(b"\t")
    path = name.decode("utf-8", "surrogateescape")
    if path in blobs and meta.split(b" ")[1].decode() != blobs[path]:
        git("read-tree", "--empty")
        say(ok=False, code="changed_while_scanned", detail=path + " in the index is not the content that was scanned")
if not staged: say(ok=False, code="nothing_to_commit", detail="the folder has nothing to commit")
tree = out(git("write-tree"))
mark["tree"] = tree
write_mark(mark)
made = git("commit-tree", tree, "-m", P["message"])
if made.returncode != 0:
    err = made.stderr.decode("utf-8", "replace")
    code = "git_identity_missing" if ("user.email" in err or "Please tell me who you are" in err) else "commit_failed"
    say(ok=False, code=code, detail=err.strip()[:300])
commit = out(made)
moved = git("update-ref", "-m", "lane-pilot baseline", "HEAD", commit, "0" * len(commit))
if moved.returncode != 0: say(ok=False, code="commit_failed", detail=moved.stderr.decode("utf-8", "replace").strip()[:300])
say(ok=True, commit=commit, tree=tree, branch=out(git("symbolic-ref", "--short", "HEAD")), files=len(paths), reused=False)
`;

export const baselineCommand = (input: { root: string; opId: string }): string => pythonCommand(BASELINE_SCRIPT, {
  root: input.root, opId: input.opId, marker: IGNORE_MARKER, block: IGNORE_BLOCK, secrets: SECRET_CONTENT_PATTERNS, message: baselineMessage(input.opId), ...BASELINE_LIMITS,
});

export type BaselineAnswer =
  | { ok: true; commit: string; tree: string; branch: string; files: number; reused: boolean }
  | { ok: false; code: string; detail: string; blocked?: Array<{ path: string; why: string }> };

export function parseBaseline(ran: { exitCode: number; stdout: string; stderr: string }): BaselineAnswer {
  if (ran.exitCode !== 0) return { ok: false, code: "baseline_failed", detail: (ran.stderr.trim() || `exit ${ran.exitCode}`).slice(0, 300) };
  try { return JSON.parse(ran.stdout.trim().split("\n").pop() ?? "") as BaselineAnswer; } catch { return { ok: false, code: "baseline_failed", detail: "baseline answer is not JSON" }; }
}
