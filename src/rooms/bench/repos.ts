/**
 * A bench set stores the checkout path of the machine that accepted the task (often a Mac path under `/Users/vechkasov/`).
 * On OVH those paths are not there. `BENCH_REPOS_ROOT` (or `bench config repos_root=`) is the folder the sync script fills
 * from each repository's git origin; the series clones from `<root>/<folder name>` instead of the stored path.
 */
export const BENCH_REPOS_ROOT_ENV = "BENCH_REPOS_ROOT";

/** The last path segment, the folder name a clone lands under. */
export function repoLeaf(storedPath: string): string {
  return storedPath.split("/").filter(Boolean).at(-1) || "repo";
}

/** The checkout to clone from. An empty root keeps the stored path. A path already under the root is left as it is. */
export function resolveRepoPath(storedPath: string, root: string | null | undefined): string {
  const base = root?.trim().replace(/\/+$/, "") ?? "";
  if (!base) return storedPath;
  if (storedPath === base || storedPath.startsWith(`${base}/`)) return storedPath;
  return `${base}/${repoLeaf(storedPath)}`;
}
