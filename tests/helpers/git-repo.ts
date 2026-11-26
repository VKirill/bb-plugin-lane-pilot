import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Runs git in `cwd` with a deterministic test author identity, returning raw stdout. */
export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  });

export interface GitRepoOptions {
  /** Explicit directory for the repository. When omitted, a temp dir is created under `tmpdir()`. */
  path?: string;
  /** Temp dir prefix when `path` is omitted. */
  prefix?: string;
  /** Subdirectory inside `root` for the repository (e.g. `"main"`), so sibling worktrees stay inside `root`. */
  subdir?: string;
  /** Initial files relative to the repository root. */
  files?: Record<string, string | Buffer>;
  /** Initial commit message, or `false` to only stage (`git add -A`) without committing. */
  commit?: string | false;
  /** Default branch prefix used by `worktree(name)` when `branch` is omitted. */
  worktreeBranchPrefix?: string;
}

export interface GitRepo {
  root: string;
  base: string;
  worktree: (name: string, branch?: string) => string;
}

/** Creates an initialized git repository on `main` with local user identity and an optional first commit. */
export function createGitRepo(options: GitRepoOptions = {}): GitRepo {
  const {
    path,
    prefix = "lp-repo-",
    subdir,
    files = { "a.txt": "a\n" },
    commit = "base",
    worktreeBranchPrefix = "bb/",
  } = options;
  const root = path ?? mkdtempSync(join(tmpdir(), prefix));
  const base = subdir ? join(root, subdir) : root;
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  git(base, "config", "user.name", "t");
  git(base, "config", "user.email", "t@t");
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(base, rel);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }
  if (Object.keys(files).length > 0) {
    git(base, "add", "-A");
  }
  if (commit !== false) {
    git(base, "commit", "-qm", commit);
  }
  const worktree = (name: string, branch = `${worktreeBranchPrefix}${name}`) => {
    const wtPath = join(root, name);
    git(base, "worktree", "add", "-q", "-b", branch, wtPath, "main");
    return wtPath;
  };
  return { root, base, worktree };
}
