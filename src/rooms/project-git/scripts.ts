import { BASELINE_LIMITS, BASELINE_MESSAGE, IGNORE_BLOCK, IGNORE_MARKER, SECRET_CONTENT_PATTERNS, type GitProbe } from "./logic";

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
 * `git init` (only where git still finds no repository, or in the one this bootstrap started) and the first commit of
 * the folder's real files: the ignore block first, then git's own list of untracked not-ignored files, each under the
 * size limit and free of credential-shaped content. Any blocked file stops it before anything is staged. An existing
 * commit is reused (a lost answer of an earlier run). Never `git add .`.
 */
const BASELINE_SCRIPT = String.raw`import os, re, subprocess
P = PAYLOAD
def say(**kw):
    print(json.dumps(kw)); raise SystemExit(0)
def git(*args):
    return subprocess.run(["git", *args], capture_output=True)
root = os.path.realpath(os.getcwd())
if os.path.lexists(".git"):
    if not P["resume"]: say(ok=False, code="existing_repo", detail="a repository exists here that this bootstrap did not start")
else:
    top = git("rev-parse", "--show-toplevel")
    err = top.stderr.decode("utf-8", "replace")
    if top.returncode == 0: say(ok=False, code="inside_work_tree", detail="the folder is inside the repository " + top.stdout.decode().strip())
    if top.returncode != 128 or "(or any of the parent directories)" not in err: say(ok=False, code="probe_unknown", detail=err.strip()[:300])
    made = git("init", "-q")
    if made.returncode != 0: say(ok=False, code="init_failed", detail=made.stderr.decode("utf-8", "replace").strip()[:300])
head = git("rev-parse", "--verify", "-q", "HEAD")
if head.returncode == 0:
    files = git("ls-files", "-z").stdout.count(b"\0")
    say(ok=True, commit=head.stdout.decode().strip(), files=files, reused=True)
existing = open(".gitignore", encoding="utf-8").read() if os.path.isfile(".gitignore") else ""
if P["marker"] not in existing:
    with open(".gitignore", "w", encoding="utf-8") as out:
        out.write(P["block"] if not existing else existing + ("" if existing.endswith("\n") else "\n") + "\n" + P["block"])
# The index of a bootstrap that stopped after staging starts empty again: only this run's checked list is committed.
git("read-tree", "--empty")
listed = git("ls-files", "-z", "--others", "--exclude-standard")
if listed.returncode != 0: say(ok=False, code="list_failed", detail=listed.stderr.decode("utf-8", "replace").strip()[:300])
paths = [p.decode("utf-8", "surrogateescape") for p in listed.stdout.split(b"\0") if p]
secrets = [re.compile(s.encode()) for s in P["secrets"]]
blocked = []
for path in paths:
    if path.endswith("/"):
        blocked.append({"path": path, "why": "a nested repository"}); continue
    try:
        st = os.lstat(path)
    except OSError as e:
        blocked.append({"path": path, "why": "unreadable"}); continue
    if os.path.islink(path): continue
    if st.st_size > P["maxFileBytes"]:
        blocked.append({"path": path, "why": "larger than " + str(P["maxFileBytes"] // (1024 * 1024)) + " MB"}); continue
    try:
        with open(path, "rb") as f: head_bytes = f.read(P["scanBytes"])
    except OSError:
        blocked.append({"path": path, "why": "unreadable"}); continue
    if any(rx.search(head_bytes) for rx in secrets): blocked.append({"path": path, "why": "looks like it holds a credential"})
if len(paths) > P["maxFiles"]: say(ok=False, code="too_many_files", detail=str(len(paths)) + " files to commit, the limit is " + str(P["maxFiles"]))
if blocked: say(ok=False, code="blocked_files", detail=str(len(blocked)) + " file(s) cannot go into the first commit", blocked=blocked[:50])
for i in range(0, len(paths), 200):
    added = git("add", "--", *paths[i:i + 200])
    if added.returncode != 0: say(ok=False, code="add_failed", detail=added.stderr.decode("utf-8", "replace").strip()[:300])
staged = set(p.decode("utf-8", "surrogateescape") for p in git("diff", "--cached", "--name-only", "-z").stdout.split(b"\0") if p)
if staged != set(paths): say(ok=False, code="staged_mismatch", detail="the index differs from the checked list")
if not staged: say(ok=False, code="nothing_to_commit", detail="the folder has nothing to commit")
done = git("commit", "-q", "--no-verify", "-m", P["message"])
if done.returncode != 0:
    err = done.stderr.decode("utf-8", "replace")
    code = "git_identity_missing" if ("user.email" in err or "Please tell me who you are" in err) else "commit_failed"
    say(ok=False, code=code, detail=err.strip()[:300])
say(ok=True, commit=git("rev-parse", "HEAD").stdout.decode().strip(), files=len(paths), reused=False)
`;

export const baselineCommand = (resume: boolean): string => pythonCommand(BASELINE_SCRIPT, {
  resume, marker: IGNORE_MARKER, block: IGNORE_BLOCK, secrets: SECRET_CONTENT_PATTERNS, message: BASELINE_MESSAGE, ...BASELINE_LIMITS,
});

export type BaselineAnswer =
  | { ok: true; commit: string; files: number; reused: boolean }
  | { ok: false; code: string; detail: string; blocked?: Array<{ path: string; why: string }> };

export function parseBaseline(ran: { exitCode: number; stdout: string; stderr: string }): BaselineAnswer {
  if (ran.exitCode !== 0) return { ok: false, code: "baseline_failed", detail: (ran.stderr.trim() || `exit ${ran.exitCode}`).slice(0, 300) };
  try { return JSON.parse(ran.stdout.trim().split("\n").pop() ?? "") as BaselineAnswer; } catch { return { ok: false, code: "baseline_failed", detail: "baseline answer is not JSON" }; }
}
