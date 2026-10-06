/**
 * Lists the writer workspace's dirty paths with a content hash each; run by python3 in the workspace. Paths are
 * relative to the workspace, also when it is a subfolder of a larger repo: git prints them from the repo root, and
 * only the workspace's host can tell the prefix (treba-sites on OVH, 2026-10-06, read from the hub as repo-relative).
 */
export const WORKSPACE_DIRT_SCRIPT = String.raw`import hashlib, json, os, subprocess
prefix = subprocess.run(["git", "rev-parse", "--show-prefix"], check=True, stdout=subprocess.PIPE).stdout.strip()
raw = subprocess.run(["git", "status", "--porcelain", "-z", "-uall", "--", "."], check=True, stdout=subprocess.PIPE).stdout
parts = raw.split(bytes([0]))
paths = []
def keep(name):
    if name.startswith(prefix) and name[len(prefix):]:
        paths.append(name[len(prefix):])
i = 0
while i < len(parts) and parts[i]:
    item = parts[i]
    i += 1
    name = item[3:]
    if not name:
        raise ValueError("empty git path")
    keep(name)
    if item[0:1] in (b"R", b"C") or item[1:2] in (b"R", b"C"):
        if i >= len(parts) or not parts[i]:
            raise ValueError("missing rename source")
        keep(parts[i])
        i += 1
rows = []
for raw_path in sorted(set(paths)):
    path = os.fsdecode(raw_path)
    if os.path.islink(path):
        digest = hashlib.sha256(b"symlink:" + os.fsencode(os.readlink(path))).hexdigest()
    elif os.path.isfile(path):
        hasher = hashlib.sha256()
        with open(path, "rb") as stream:
            for chunk in iter(lambda: stream.read(1 << 20), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
    elif os.path.isdir(path) and os.path.lexists(os.path.join(path, ".git")):
        # A nested repository or submodule shows as one directory; its HEAD and status stand for its content.
        head = subprocess.run(["git", "-C", path, "rev-parse", "-q", "--verify", "HEAD"], stdout=subprocess.PIPE).stdout
        status = subprocess.run(["git", "-C", path, "status", "--porcelain", "-z", "-uall"], check=True, stdout=subprocess.PIPE).stdout
        digest = hashlib.sha256(b"repo:" + head + bytes([0]) + status).hexdigest()
    elif os.path.lexists(path):
        raise ValueError("dirty path is not regular: " + path)
    else:
        digest = ""
    rows.append({"path": path, "sha256": digest})
print(json.dumps(rows, ensure_ascii=True))
`;

export const WORKSPACE_DIRT_COMMAND = `python3 - <<'PY'\n${WORKSPACE_DIRT_SCRIPT}PY`;
