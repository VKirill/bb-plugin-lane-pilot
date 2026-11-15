// The sibling repositories a map node's proof can live in (docs/sma-evidence.md «Proofs in a sibling repository»): the BB
// core with its vk layer (`core:` anchors) and the owner's Telegram plugin (`telegram:` anchors). This is the one place
// that says where a sibling's checkout is, how its tests run, and where the mutation runner may write. The tools READ a
// sibling from:
//   1. an environment override (SMA_SIBLING_CORE / SMA_SIBLING_TELEGRAM): any checkout of it; `off` (or a path that does
//      not exist) makes the sibling absent — it never falls through;
//   2. the default locations, the first that holds a checkout: its PRIMARY checkout.
// A sibling that resolves nowhere is absent: every tool says `absentSibling(name)` for the nodes that need it.
// The mutation runner WRITES only in the canonical PRIMARY checkout of a repository (owner, 2026-11-15: PRIMARY only; the
// earlier linked proofs worktrees under ~/.lane-pilot/worktrees are gone): `refuseMutation` below. That PRIMARY is where the
// core is built and deployed from, so a mutation runs only inside the coordinator's exclusive window (no edit, build or
// deploy there) — the runner checks the checkout's identity, it does not enforce the window (docs/sma-evidence.md).
// No imports from other rooms: this ships in the plugin and runs under plain tsx in scripts.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type SiblingName = "core" | "telegram";
export const SIBLING_NAMES: readonly SiblingName[] = ["core", "telegram"];

export type SiblingSpec = {
  name: SiblingName;
  /** The folder name under the worktree root and the name tools print. */
  repo: string;
  /** The environment override. */
  env: string;
  /** The branch its PRIMARY checkout has out: the only branch the mutation runner works on. */
  branch: string;
  /** Historical: the branch the proofs were written on before the PRIMARY-only rule; recorded pins may still point at it. */
  proofBranch: string;
  /** How its tests run: vitest from the package that holds the test, or node:test through tsx from the root. */
  runner: "vitest" | "node-test";
  /** Git pathspecs of its test files (read from git at a commit, so the index is deterministic). */
  testGlobs: readonly string[];
  /** The plugin id on the hub when the sibling is a plugin: its nodes need it enabled there (`bb plugin list --json`). */
  hubPlugin?: string;
};

export const SIBLINGS: Readonly<Record<SiblingName, SiblingSpec>> = {
  core: {
    name: "core", repo: "bb-core", env: "SMA_SIBLING_CORE", branch: "vk/experimental", proofBranch: "sma/core-proofs", runner: "vitest",
    testGlobs: [":(glob)**/*.test.ts", ":(glob)**/*.test.tsx"],
  },
  telegram: {
    name: "telegram", repo: "bb-plugin-telegram-projects", env: "SMA_SIBLING_TELEGRAM", branch: "main", proofBranch: "sma/proofs", runner: "node-test",
    testGlobs: [":(glob)test/**/*.test.ts"],
    hubPlugin: "telegram-projects",
  },
};

export const SIBLING_PREFIX = /^(core|telegram):(.*)$/s;
/** `core:packages/x.ts` → { sibling: "core", path: "packages/x.ts" }; a local path → { sibling: null, path }. */
export function splitSiblingPath(where: string): { sibling: SiblingName | null; path: string } {
  const hit = SIBLING_PREFIX.exec(where);
  return hit ? { sibling: hit[1] as SiblingName, path: hit[2]! } : { sibling: null, path: where };
}
export const siblingOf = (where: string | undefined): SiblingName | null => (where ? splitSiblingPath(where).sibling : null);

export const absentSibling = (name: SiblingName) => `sibling repository ${SIBLINGS[name].repo} is not on this machine`;

type Env = Readonly<Record<string, string | undefined>>;
/** The branch this plugin's own PRIMARY checkout has out: the runner mutates a local node only there. */
export const PLUGIN_BRANCH = "main";

/** The shared checkouts: where the sibling usually is on a machine (OVH, the hub, a Mac checkout beside the plugin). Read-only. */
export function defaultSiblingLocations(name: SiblingName, cwd: string, home = homedir()): string[] {
  const up = (...parts: string[]) => [join(cwd, "..", ...parts), join(cwd, "..", "..", "..", "..", ...parts)];
  return name === "core"
    ? [join(home, ".local", "share", "bb-source-vk"), join(home, "BB-service", "bb-core", "vk"), ...up("bb-core", "vk")]
    : [join(home, "BB-service", "bb-plugin-telegram-projects"), ...up("bb-plugin-telegram-projects")];
}

export type SiblingRoot = { root: string; from: "env" | "default" } | { root: null; why: string };

/** Where sibling `name` is on this machine (see the header for the order). */
export function resolveSibling(name: SiblingName, cwd: string = process.cwd(), env: Env = process.env, home = homedir()): SiblingRoot {
  const override = env[SIBLINGS[name].env]?.trim();
  if (override) {
    if (override === "off") return { root: null, why: `${absentSibling(name)} (${SIBLINGS[name].env}=off)` };
    const path = resolve(cwd, override);
    return existsSync(path) ? { root: path, from: "env" } : { root: null, why: `${absentSibling(name)} (${SIBLINGS[name].env} points at ${path}, which does not exist)` };
  }
  const found = defaultSiblingLocations(name, cwd, home).find((path) => existsSync(join(path, ".git")));
  return found ? { root: found, from: "default" } : { root: null, why: absentSibling(name) };
}

/** The roots of every sibling present here (ProofRoots' core/telegram). */
export function siblingRoots(cwd: string = process.cwd(), env: Env = process.env, home = homedir()): Partial<Record<SiblingName, string>> {
  const out: Partial<Record<SiblingName, string>> = {};
  for (const name of SIBLING_NAMES) { const at = resolveSibling(name, cwd, env, home); if (at.root) out[name] = at.root; }
  return out;
}

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (child: string, parent: string) => { const rel = relative(parent, child); return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel)); };

/** The canonical PRIMARY checkout of sibling `name` (the first default location holding a checkout, its real path), or null. */
export function canonicalSibling(name: SiblingName, cwd: string = process.cwd(), home = homedir()): string | null {
  const found = defaultSiblingLocations(name, cwd, home).find((path) => existsSync(join(path, ".git")));
  return found ? real(found) : null;
}

/**
 * Why the mutation runner may NOT write `path` (relative to the checkout `root`) of sibling `name` — or, with `name` null,
 * of this plugin, whose checkout is `cwd` — or null when it may. One rule for every repository: `root` is its canonical
 * PRIMARY checkout (after symbolic links; an override pointing anywhere else is read, never written), a main checkout (a
 * linked worktree is refused), on its branch (core vk/experimental, telegram main, this plugin main), and the file stays
 * inside it after symbolic links are followed.
 */
export function refuseMutation(name: SiblingName | null, root: string, path: string, cwd: string = process.cwd(), home = homedir()): string | null {
  const repo = name ? SIBLINGS[name].repo : "this plugin";
  const at = real(root);
  const canonical = name ? canonicalSibling(name, cwd, home) : real(cwd);
  if (!canonical || at !== canonical) return `refused: ${root} is not the PRIMARY checkout of ${repo}${canonical ? ` (${canonical})` : " (none on this machine)"}; a mutation runs only there`;
  try { if (!statSync(join(at, ".git")).isDirectory()) return `refused: ${root} is a linked worktree (its .git is a file); a mutation runs only in the PRIMARY checkout`; } catch { return `refused: ${root} is not a git checkout`; }
  const want = name ? SIBLINGS[name].branch : PLUGIN_BRANCH;
  const branch = (() => { try { return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(join(at, ".git", "HEAD"), "utf8"))?.[1]?.trim() ?? null; } catch { return null; } })();
  if (branch !== want) return `refused: ${root} has ${branch ?? "a detached HEAD"} out, not ${want}`;
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return `refused: ${path} must be a path inside the checkout`;
  const file = join(at, path);
  if (existsSync(file) && !inside(real(file), at)) return `refused: ${path} resolves outside ${root} (a symbolic link)`;
  return null;
}
