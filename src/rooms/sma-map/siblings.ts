// The sibling repositories a map node's proof can live in (docs/sma-evidence.md «Proofs in a sibling repository»): the BB
// core with its vk layer (`core:` anchors) and the owner's Telegram plugin (`telegram:` anchors). This is the one place
// that says where a sibling's checkout is, how its tests run, and where the mutation runner may write. The tools READ a
// sibling from:
//   1. an environment override (SMA_SIBLING_CORE / SMA_SIBLING_TELEGRAM): any checkout of it; `off` (or a path that does
//      not exist) makes the sibling absent — it never falls through;
//   2. the default locations, the first that holds a checkout.
// A sibling that resolves nowhere is absent: every tool says `absentSibling(name)` for the nodes that need it.
// The mutation runner writes only in the checkout selected by the coordinator: the plugin's cwd for local nodes, or the
// sibling root selected by `resolveSibling` for sibling nodes. Linked worktrees and independent clones are valid selected
// roots; `refuseMutation` below still checks that the selected root is a valid git checkout and that its target stays inside.
// The coordinator owns the exclusive mutation window (docs/sma-evidence.md); the runner does not enforce that window.
// No imports from other rooms: this ships in the plugin and runs under plain tsx in scripts.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { headOf, worktreeRootOf } from "./sibling-git";

export type SiblingName = "core" | "telegram";
export const SIBLING_NAMES: readonly SiblingName[] = ["core", "telegram"];

export type SiblingSpec = {
  name: SiblingName;
  /** The folder name under the worktree root and the name tools print. */
  repo: string;
  /** The environment override. */
  env: string;
  /** The branch used by the historical proof checkout and status guidance. */
  branch: string;
  /** Historical proof branch; recorded pins may still point at it. */
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
/** Historical status metadata for the plugin's usual checkout. Mutation accepts any valid branch or detached HEAD. */
export const PLUGIN_BRANCH = "main";

/** The shared checkouts: where the sibling usually is on a machine (OVH, the hub, a Mac checkout beside the plugin). */
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

/** The first default checkout of sibling `name` (after symbolic links), or null. */
export function canonicalSibling(name: SiblingName, cwd: string = process.cwd(), home = homedir()): string | null {
  const found = defaultSiblingLocations(name, cwd, home).find((path) => existsSync(join(path, ".git")));
  return found ? real(found) : null;
}

/**
 * Why the mutation runner may NOT write `path` (relative to the checkout `root`) of sibling `name` — or, with `name` null,
 * of this plugin, whose selected checkout is `cwd` — or null when it may. A sibling root must be the exact checkout selected
 * by `resolveSibling` (after symbolic links); the plugin root must be `cwd`. Any valid git checkout is allowed, including a
 * linked worktree, an independent clone, an arbitrary branch, or a detached HEAD. The file must stay inside it after links
 * are followed.
 */
export function refuseMutation(name: SiblingName | null, root: string, path: string, cwd: string = process.cwd(), home = homedir()): string | null {
  const repo = name ? SIBLINGS[name].repo : "this plugin";
  const at = real(root);
  const selected = name ? resolveSibling(name, cwd, process.env, home) : { root: real(cwd) };
  if (selected.root === null) return `refused: ${root} is not the selected checkout of ${repo} (${selected.why})`;
  const selectedAt = real(selected.root);
  if (at !== selectedAt) return `refused: ${root} is not the selected checkout of ${repo} (${selectedAt})`;
  const worktreeRoot = worktreeRootOf(at);
  if (!worktreeRoot || real(worktreeRoot) !== at) return `refused: ${root} is not a valid git worktree checkout`;
  if (!headOf(at)) return `refused: ${root} is not a valid git checkout`;
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return `refused: ${path} must be a path inside the checkout`;
  const file = join(at, path);
  if (existsSync(file) && !inside(real(file), at)) return `refused: ${path} resolves outside ${root} (a symbolic link)`;
  return null;
}
