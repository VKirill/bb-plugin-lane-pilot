import { matchOwnsPath } from "./owns-paths";

/**
 * Files hooks, the harness and sibling agents write into a checkout while a task runs. They are never a writer's
 * change: ownership gates skip them, a merge settles them to main's version, the critic diff leaves them out.
 * A project adds its own patterns with the `bookkeeping.paths` setting (owns_paths syntax).
 */
export const BOOKKEEPING_PATHS = [
  ".agents/PROGRESS.md",
  ".agents/CHANGELOG.md",
  ".agents/memory/episodes/**",
  ".agents/runs/**",
  ".agents/reports/**",
  ".bb/chats/**",
  "notes/lock/**",
];

/**
 * The bookkeeping folders that do not belong in a project's history: activation adds them to the repository's
 * `.git/info/exclude` (never `.gitignore`: no commit, no change the owner has to review). The leading double star
 * makes one line match at any depth, so a workspace that is a repo subfolder is covered too.
 */
export const BOOKKEEPING_EXCLUDE_LINES = [".agents/runs/", ".agents/reports/", ".bb/chats/", "notes/lock/"].map((dir) => `**/${dir}`);

export const BOOKKEEPING_SETTING = "bookkeeping.paths";

/** The project's extra bookkeeping patterns: an array, or one string split on newlines and commas. */
export function bookkeepingSetting(settings:Record<string, unknown>):string[] {
  const raw = settings[BOOKKEEPING_SETTING];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,]/) : [];
  const patterns = items.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim().slice(0, 300)] : []);
  // «..» and absolute patterns never name a bookkeeping file of the workspace.
  return [...new Set(patterns.filter((pattern) => !pattern.startsWith("/") && !pattern.split("/").includes("..")))].slice(0, 100);
}

export function isBookkeepingPath(path:string, extra:readonly string[] = []):boolean {
  const clean = path.replace(/^\.\//, "");
  return [...BOOKKEEPING_PATHS, ...extra].some((pattern) => matchOwnsPath(clean, pattern));
}

/** Cache folders tools write at any depth while checks run. */
export const TOOL_CACHE_DIRS = new Set(["node_modules",".vite",".vitest",".turbo",".cache",".parcel-cache",".eslintcache",".pytest_cache",".mypy_cache",".ruff_cache","__pycache__"]);

const NOISE_PREFIXES = [".agents/",".bb/",".repowise/",".worktrees/",".claude/worktrees/","node_modules/",".npm-cache/","npm-cache/",".npm/",".pnpm-store/","pnpm-store/",".yarn/cache/",".yarn/unplugged/",".cache/",".turbo/",".next/cache/","coverage/",".git/"];
const NOISE_FILES = new Set(["PROGRESS.md","LESSONS.md","AGENTS.md","CLAUDE.md"]);

/**
 * Paths no ownership decision may count as the writer's: bookkeeping (the list above and the project's own), the
 * wider agent folders, and tool caches. A merge settles only isBookkeepingPath, never this wider set: a task may
 * legitimately change AGENTS.md or a plan under .agents/.
 */
export function isOwnershipNoise(path:string, extra:readonly string[] = []):boolean {
  const clean = path.replace(/^\.\//, "");
  if (NOISE_PREFIXES.some((prefix) => clean.startsWith(prefix)) || NOISE_FILES.has(clean) || isBookkeepingPath(clean, extra)) return true;
  const parts = clean.split("/");
  // Tool caches inside a package of a monorepo (packages/contracts/.vite/vitest/…) are written by the checks
  // themselves, not by the writer (SelfyStudio, 2026-10-02).
  if (parts.slice(0, -1).some((part) => TOOL_CACHE_DIRS.has(part))) return true;
  return parts.includes("__pycache__") || parts.includes(".pytest_cache") || parts.includes(".mypy_cache") || parts.includes(".ruff_cache")
    || clean.endsWith(".pyc") || clean.endsWith(".pyo");
}

export function filterOwnershipNoise(paths:string[], extra:readonly string[] = []):string[] {
  return [...new Set(paths.map((path) => path.replace(/^\.\//, "")).filter((path) => !isOwnershipNoise(path, extra)))].sort();
}
