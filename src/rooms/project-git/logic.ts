/**
 * Private Git bootstrap of a project folder that has none (roadmap P03.04–08): the pure half. What the host probe
 * answers and how it is read, the starter ignore block, the curated-baseline gates, the repository name and the
 * authenticated readback rule. The server half (server/bootstrap.ts) runs these on the folder's own host.
 */

/** origin: a repository with an origin remote; localNoOrigin: a repository without one; noGit: git looked and found none; unknown: anything else. */
export type GitProbeState = "origin" | "localNoOrigin" | "noGit" | "unknown";

export type GitProbe = {
  state: GitProbeState;
  /** The folder as the host resolves it (realpath). */
  cwd?: string;
  /** The work tree root the folder belongs to (origin and localNoOrigin): a parent repository is reused, never nested. */
  root?: string;
  origin?: string;
  /** Whether the repository has a commit (origin and localNoOrigin). */
  hasCommit?: boolean;
  reason?: string;
};

/** Marks the block Lane Pilot appends to `.gitignore`; present means the block was written already. */
export const IGNORE_MARKER = "# lane-pilot private bootstrap: secrets, generated files and private agent history";

/**
 * Kept out of the first commit and of every later `git add`: secrets, dependencies, build output, and the agents'
 * private history (BB chat storage, Lane Pilot run and memory folders). The owner sees it as the first commit's `.gitignore`.
 */
export const IGNORE_PATTERNS = [
  ".env", ".env.*", "!.env.example", "!.env.sample", "!.env.template",
  "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ecdsa*", "id_ed25519*",
  ".npmrc", ".pypirc", ".netrc", ".ssh/", ".aws/", ".gnupg/", "secrets/", "*.sqlite", "*.sqlite3", "*.db",
  "node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", "coverage/", ".next/", ".nuxt/", ".turbo/", ".vite/", ".cache/",
  "*.log", ".DS_Store",
  ".bb/", ".agents/runs/", ".agents/memory/", ".claude/settings.local.json",
] as const;

export const IGNORE_BLOCK = `${IGNORE_MARKER}\n${IGNORE_PATTERNS.join("\n")}\n`;

/** Python `re` sources of content that is a credential wherever it sits; a hit stops the baseline (the file is named, never shown). */
export const SECRET_CONTENT_PATTERNS = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----",
  "\\bgh[pousr]_[A-Za-z0-9]{36,}",
  "\\bgithub_pat_[A-Za-z0-9_]{40,}",
  "\\bAKIA[0-9A-Z]{16}\\b",
  "\\bxox[abprs]-[A-Za-z0-9-]{10,}",
  "\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}",
  "\\bAIza[0-9A-Za-z_-]{35}",
] as const;

export const BASELINE_LIMITS = { maxFileBytes: 5 * 1024 * 1024, maxFiles: 20_000, scanBytes: 1024 * 1024 } as const;

export const BASELINE_MESSAGE = "Initial baseline: the folder as it was before Lane Pilot's first task";

/** A GitHub repository name from the folder's name: letters, digits, `.`, `-`, `_`; null when nothing usable is left. */
export function repoNameFor(root: string): string | null {
  const base = root.replace(/\/+$/, "").split("/").pop() ?? "";
  const name = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "").slice(0, 100);
  return name && name !== "." && name !== ".." ? name : null;
}

export type RepoReadback = { id: number; fullName: string; owner: string; cloneUrl: string; createdAt: string | null };

/**
 * The authenticated read of the repository after create: the exact `owner/name`, `private: true` and the same id as
 * before (when one was recorded). An anonymous 404 never proves privacy; this read is the only proof.
 */
export function verifyReadback(raw: unknown, expected: { owner: string; name: string; id?: number }):
  { ok: true; repo: RepoReadback } | { ok: false; reason: string } {
  const row = raw as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown; owner?: { login?: unknown }; clone_url?: unknown; created_at?: unknown } | null;
  if (!row || typeof row !== "object") return { ok: false, reason: "readback is not a repository" };
  const want = `${expected.owner}/${expected.name}`.toLowerCase();
  if (typeof row.full_name !== "string" || row.full_name.toLowerCase() !== want) return { ok: false, reason: `readback names ${String(row.full_name)}, expected ${want}` };
  if (typeof row.owner?.login !== "string" || row.owner.login.toLowerCase() !== expected.owner.toLowerCase()) return { ok: false, reason: "readback owner differs" };
  if (row.private !== true || (row.visibility !== undefined && row.visibility !== "private")) return { ok: false, reason: "the repository is not private" };
  if (typeof row.id !== "number") return { ok: false, reason: "readback has no repository id" };
  if (expected.id !== undefined && row.id !== expected.id) return { ok: false, reason: `repository id ${row.id} differs from the recorded ${expected.id}` };
  if (typeof row.clone_url !== "string" || !row.clone_url) return { ok: false, reason: "readback has no clone url" };
  return { ok: true, repo: { id: row.id, fullName: row.full_name, owner: row.owner.login, cloneUrl: row.clone_url, createdAt: typeof row.created_at === "string" ? row.created_at : null } };
}

/** One spelling of a remote for comparison: https, ssh `git@host:path` and `ssh://` forms, `.git` and case dropped. */
export function sameRemote(a: string, b: string): boolean {
  const norm = (url: string) => url.trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/^https:\/\/[^@/]+@/, "https://")
    .replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Whether `child` is `parent` or inside it (host paths, already canonical). */
export function isWithin(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, "") || "/";
  return child === p || child.startsWith(p === "/" ? "/" : `${p}/`);
}

export type ScopeChoice = { scope: "project" | "section"; root: string };

/** The only question: which folder becomes the repository. Options carry the host paths verbatim. */
export function scopeQuestion(candidates: ScopeChoice[], locale: "ru" | "en"): { question: string; detail: string; options: string[] } {
  const ru = locale === "ru";
  return {
    question: ru ? "В папке нет Git. Какую область сделать приватным репозиторием?" : "This folder has no Git. Which scope should become a private repository?",
    detail: ru
      ? "Lane Pilot создаст локальный Git, первый коммит из текущих файлов (без секретов, node_modules и истории агентов) и приватный репозиторий GitHub через gh на этой машине. Закройте форму, чтобы не делать этого сейчас."
      : "Lane Pilot will create local Git, a first commit of the current files (no secrets, node_modules or agent history) and a private GitHub repository through gh on this machine. Dismiss the form to skip it for now.",
    options: candidates.map((c) => c.scope === "project" ? `${ru ? "Весь проект" : "Whole project"}: ${c.root}` : `${ru ? "Только раздел" : "This section only"}: ${c.root}`),
  };
}

/** Durable progress of one bootstrap, kept per host and root; each stage's result is written as soon as it is known. */
export type BootstrapRecord = {
  v: 1;
  hostId: string;
  root: string;
  /** Set before `git init`: a repository found here later without a commit is this bootstrap's own. */
  baselineStartedAt?: number;
  baseline?: { commit: string; files: number; reused: boolean; at: number };
  repo?: { owner: string; name: string; requestedAt?: number; id?: number; fullName?: string; cloneUrl?: string; verifiedAt?: number };
  origin?: { url: string; at: number };
  push?: { branch: string; sha: string; at: number };
  invalidated?: { at: number; skipped?: boolean };
  doneAt?: number;
  lastError?: { stage: BootstrapStage; code: string; detail: string; at: number };
};

export type BootstrapStage = "guard" | "probe" | "baseline" | "auth" | "repo" | "origin" | "push" | "invalidate";

export const bootstrapKey = (hostId: string, root: string) => `project-git:bootstrap:${hostId}:${root}`;
export const scopeKey = (hostId: string, projectRoot: string, sectionPath: string | null) => `project-git:scope:${hostId}:${projectRoot}:${sectionPath ?? ""}`;
export const declinedKey = (taskKey: string) => `project-git:declined:${taskKey}`;
