import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProjectGit, type ProjectGitDeps } from "../../src/rooms/project-git/server";

/**
 * A host that runs commands in local temp folders, with a `gh` stub on PATH: «GitHub» is a JSON file and bare
 * repositories under the temp root, so create, readback and push are real git and nothing leaves the machine.
 */
const GH_STUB = String.raw`#!/usr/bin/env python3
import json, os, subprocess, sys, datetime
path = os.environ["GH_STUB_STATE"]
st = json.load(open(path))
def save(): json.dump(st, open(path, "w"))
a = sys.argv[1:]
if os.environ.get("GH_HOST") not in (None, "github.com"): print("wrong host", file=sys.stderr); sys.exit(4)
if "--hostname" in a:
    i = a.index("--hostname")
    if a[i + 1] != "github.com": print("wrong host", file=sys.stderr); sys.exit(4)
    a = a[:i] + a[i + 2:]
st.setdefault("calls", []).append(" ".join(a)); save()
def repo_json(full):
    r = st["repos"][full]
    refs = subprocess.run(["git", "--git-dir", r["bare"], "for-each-ref"], capture_output=True, text=True).stdout.strip() if os.path.isdir(r["bare"]) else ""
    return {"description": r.get("description"), "size": 1 if refs else 0,"id": r["id"], "full_name": full, "private": r["private"], "visibility": "private" if r["private"] else "public",
            "owner": {"login": full.split("/")[0]}, "clone_url": "file://" + r["bare"], "created_at": r["created_at"]}
if a[:2] == ["auth", "status"]:
    if st.get("authed"): sys.exit(0)
    print("You are not logged into any GitHub hosts. To log in, run: gh auth login", file=sys.stderr); sys.exit(1)
if a[:2] == ["auth", "git-credential"]: sys.exit(0)
if a == ["api", "user"]: print(json.dumps({"login": st["login"]})); sys.exit(0)
if a[0] == "api" and a[1].startswith("repos/"):
    full = a[1][len("repos/"):]
    if full in st["repos"]: print(json.dumps(repo_json(full))); sys.exit(0)
    print("gh: Not Found (HTTP 404)", file=sys.stderr); sys.exit(1)
if a[:2] == ["repo", "create"]:
    full = a[2]
    st["creates"] = st.get("creates", 0) + 1
    bare = os.path.join(os.environ["GH_STUB_REMOTES"], full + ".git")
    os.makedirs(os.path.dirname(bare), exist_ok=True)
    subprocess.run(["git", "init", "-q", "--bare", bare], check=True)
    st["repos"][full] = {"id": 1000 + st["creates"], "private": "--private" in a and not st.get("forcePublic"), "bare": bare,
                         "description": a[a.index("--description") + 1] if "--description" in a else None,
                         "created_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    lose = st.pop("loseAck", False); save()
    if lose: print("error connecting to api.github.com", file=sys.stderr); sys.exit(1)
    print("https://github.com/" + full); sys.exit(0)
print("unsupported: " + " ".join(a), file=sys.stderr); sys.exit(2)
`;

export type GhState = { authed: boolean; login: string; repos: Record<string, { id: number; private: boolean; bare: string; created_at: string; description?: string }>; creates?: number; loseAck?: boolean; forcePublic?: boolean; calls?: string[] };

export function makeFixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "lp-project-git-")));
  const bin = join(base, "bin");
  const remotes = join(base, "remotes");
  mkdirSync(bin); mkdirSync(remotes);
  writeFileSync(join(bin, "gh"), GH_STUB); chmodSync(join(bin, "gh"), 0o755);
  const statePath = join(base, "gh-state.json");
  const gitconfig = join(base, "gitconfig");
  writeFileSync(gitconfig, "[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n");
  const gh = (patch?: Partial<GhState>): GhState => {
    const current: GhState = (() => { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return { authed: true, login: "octo", repos: {} }; } })();
    if (patch) writeFileSync(statePath, JSON.stringify({ ...current, ...patch }));
    return patch ? { ...current, ...patch } : current;
  };
  gh({});
  const env = (): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: statePath, GH_STUB_REMOTES: remotes, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", HOME: base,
      // A host whose gh points elsewhere by default: every call must still name github.com.
      GH_HOST: "ghe.example.invalid" };
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CEILING_DIRECTORIES"]) delete out[name];
    return out;
  };
  const commands: string[] = [];
  const host = {
    online: true,
    async call(_method: "runCommand", input: { command: string; cwd: string }, _options: { hostId: string }) {
      if (!host.online) throw new Error("host offline");
      commands.push(input.command);
      const ran = spawnSync("bash", ["-c", input.command], { cwd: input.cwd, env: env(), encoding: "utf8" });
      if (ran.error) throw ran.error;
      return { hostId: "h1", exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
    },
  };
  const store = new Map<string, unknown>();
  const kv = { get: async <T>(key: string) => store.get(key) as T | undefined, set: async (key: string, value: never) => { store.set(key, structuredClone(value)); } };
  const asks: Array<{ question: string; detail?: string; options?: readonly string[] }> = [];
  let answer: (options: readonly string[]) => Awaited<ReturnType<ProjectGitDeps["ownerAsk"]["ask"]>> = () => ({ outcome: "cancelled", reason: "timeout" });
  const ownerAsk: ProjectGitDeps["ownerAsk"] = {
    ask: async (_threadId, request) => { asks.push({ question: request.question, detail: request.detail, options: request.options }); await new Promise((r) => setTimeout(r, 5)); return answer(request.options ?? []); },
  };
  const live = { runId: null as string | null };
  const invalidated: string[] = [];
  const projectGit = createProjectGit({
    host, kv, ownerAsk, log: () => {},
    activeLiveRun: async () => live.runId,
    invalidate: async ({ root }) => { invalidated.push(root); },
  });
  const folder = (rel: string, files: Record<string, string> = {}) => {
    const dir = join(base, rel);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); }
    return dir;
  };
  const sh = (cwd: string, command: string) => spawnSync("bash", ["-c", command], { cwd, env: env(), encoding: "utf8" });
  return { base, host, kv, store, gh, asks, commands, live, invalidated, projectGit, folder, sh, setAnswer: (fn: typeof answer) => { answer = fn; } };
}
