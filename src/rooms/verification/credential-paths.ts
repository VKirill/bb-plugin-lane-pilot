import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Single source of truth for owner credential directories and files that sandboxes,
 * strict-worker probes, and writer isolation settings must keep unreadable.
 * Also mirrored in `scripts/lp-worker-user.sh` (parity tested in `tests/writer-isolation.test.ts`).
 */
export const CREDENTIAL_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gh",
  ".bb",
  ".codex",
  ".claude",
] as const;

export const CREDENTIAL_FILES = [
  ".git-credentials",
  ".netrc",
  ".claude.json",
  ".codex/auth.json",
  ".claude/.credentials.json",
] as const;

export const CREDENTIAL_SYMLINK_DIRS = [".codex", ".claude"] as const;

export function credentialDirs(options: { sshKeys?: boolean } = {}): string[] {
  return options.sshKeys === true
    ? CREDENTIAL_DIRS.filter((name) => name !== ".ssh")
    : [...CREDENTIAL_DIRS];
}

function resolveSymlinkTarget(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) return resolve(dirname(path), readlinkSync(path));
    } catch { /* absent */ }
    return null;
  }
}

/**
 * Resolves owner credential directories and files relative to `home`, including the real
 * targets of symlinked `~/.codex` and `~/.claude` directories.
 */
export function resolveCredentialPaths(
  home = homedir(),
  options: { sshKeys?: boolean; existingOnly?: boolean } = {},
): { dirs: string[]; files: string[] } {
  const existingOnly = options.existingOnly ?? true;
  const dirs: string[] = [];
  const dirSeen = new Set<string>();
  const addDir = (p: string, requireExists: boolean) => {
    if (requireExists && !existsSync(p)) return;
    if (dirSeen.has(p)) return;
    dirSeen.add(p);
    dirs.push(p);
  };

  const symlinkTargets = new Map<string, string>();
  for (const rel of credentialDirs(options)) {
    const joined = join(home, rel);
    addDir(joined, existingOnly);
    if ((CREDENTIAL_SYMLINK_DIRS as readonly string[]).includes(rel)) {
      const target = resolveSymlinkTarget(joined);
      if (target && target !== joined) {
        symlinkTargets.set(rel, target);
        addDir(target, existingOnly);
      }
    }
  }

  const files: string[] = [];
  const fileSeen = new Set<string>();
  const addFile = (p: string, requireExists: boolean) => {
    if (requireExists && !existsSync(p)) return;
    if (fileSeen.has(p)) return;
    fileSeen.add(p);
    files.push(p);
  };

  for (const rel of CREDENTIAL_FILES) {
    const joined = join(home, rel);
    addFile(joined, existingOnly);
    const parent = CREDENTIAL_SYMLINK_DIRS.find((dir) => rel.startsWith(`${dir}/`));
    if (parent) {
      const targetDir = symlinkTargets.get(parent);
      if (targetDir) {
        addFile(join(targetDir, rel.slice(parent.length + 1)), existingOnly);
      }
    }
    const targetFile = resolveSymlinkTarget(joined);
    if (targetFile && targetFile !== joined) {
      addFile(targetFile, existingOnly);
    }
  }

  return { dirs, files };
}
