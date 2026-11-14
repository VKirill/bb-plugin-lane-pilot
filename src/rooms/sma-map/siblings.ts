// The sibling repositories a map node's proof can live in (docs/sma-evidence.md «Proofs in a sibling repository»): the BB
// core with its vk layer (`core:` anchors) and the owner's Telegram plugin (`telegram:` anchors). This is the one place
// that says where a sibling's checkout is, how its tests run, and where the mutation runner may write:
//   1. an environment override (SMA_SIBLING_CORE / SMA_SIBLING_TELEGRAM): a batch agent points the tools at ITS OWN
//      worktree of the sibling; `off` (or a path that does not exist) makes the sibling absent — it never falls through;
//   2. the proofs worktree `<worktree root>/<repo>/sma-proofs` (made by `npm run sma:sibling -- setup <name>`);
//   3. the default locations (the shared checkouts: read-only for the tools, never mutated).
// A sibling that resolves nowhere is absent: every tool says `absentSibling(name)` for the nodes that need it.
// No imports from other rooms: this ships in the plugin and runs under plain tsx in scripts.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SiblingName = "core" | "telegram";
export const SIBLING_NAMES: readonly SiblingName[] = ["core", "telegram"];

export type SiblingSpec = {
  name: SiblingName;
  /** The folder name under the worktree root and the name tools print. */
  repo: string;
  /** The environment override. */
  env: string;
  /** The branch the proofs worktree is cut from, and the branch proofs are committed on. */
  baseRef: string;
  proofBranch: string;
  /** How its tests run: vitest from the package that holds the test, or node:test through tsx from the root. */
  runner: "vitest" | "node-test";
  /** Git pathspecs of its test files (read from git at a commit, so the index is deterministic). */
  testGlobs: readonly string[];
  /** Commands that give a fresh worktree its dependencies, offline, from the machine's package store. */
  setup: ReadonlyArray<readonly string[]>;
  /** The plugin id on the hub when the sibling is a plugin: its nodes need it enabled there (`bb plugin list --json`). */
  hubPlugin?: string;
};

export const SIBLINGS: Readonly<Record<SiblingName, SiblingSpec>> = {
  core: {
    name: "core", repo: "bb-core", env: "SMA_SIBLING_CORE", baseRef: "vk/experimental", proofBranch: "sma/core-proofs", runner: "vitest",
    testGlobs: [":(glob)**/*.test.ts", ":(glob)**/*.test.tsx"],
    // pnpm workspace: each package gets its own node_modules linked from the store; the native sqlite binary and the plugin
    // SDK's dist (plugins resolve @get-bb/plugin-sdk through it) come from turbo's shared worktree cache.
    setup: [["pnpm", "install", "--frozen-lockfile", "--offline"], ["node", "scripts/ensure-native-modules.mjs"], ["pnpm", "exec", "turbo", "run", "build", "--filter=@get-bb/plugin-sdk", "--output-logs=errors-only"]],
  },
  telegram: {
    name: "telegram", repo: "bb-plugin-telegram-projects", env: "SMA_SIBLING_TELEGRAM", baseRef: "HEAD", proofBranch: "sma/proofs", runner: "node-test",
    testGlobs: [":(glob)test/**/*.test.ts"],
    setup: [["npm", "ci", "--offline", "--no-audit", "--no-fund"]],
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
/** The machine's one worktree root (docs/worktrees.md; mirrors laneWorktreeRoot of the verification room). */
export const worktreeRoot = (env: Env = process.env, home = homedir()) => env.LANE_PILOT_WORKTREE_ROOT?.trim() || join(home, ".lane-pilot", "worktrees");
/** Where the proofs worktree of a sibling lives, and where every worktree the mutation runner may write must live. */
export const siblingWorktreeDir = (name: SiblingName, env: Env = process.env, home = homedir()) => join(worktreeRoot(env, home), SIBLINGS[name].repo);
export const proofsWorktree = (name: SiblingName, env: Env = process.env, home = homedir()) => join(siblingWorktreeDir(name, env, home), "sma-proofs");

/** The shared checkouts: where the sibling usually is on a machine (OVH, the hub, a Mac checkout beside the plugin). Read-only. */
export function defaultSiblingLocations(name: SiblingName, cwd: string, home = homedir()): string[] {
  const up = (...parts: string[]) => [join(cwd, "..", ...parts), join(cwd, "..", "..", "..", "..", ...parts)];
  return name === "core"
    ? [join(home, ".local", "share", "bb-source-vk"), join(home, "BB-service", "bb-core", "vk"), ...up("bb-core", "vk")]
    : [join(home, "BB-service", "bb-plugin-telegram-projects"), ...up("bb-plugin-telegram-projects")];
}

export type SiblingRoot = { root: string; from: "env" | "proofs-worktree" | "default" } | { root: null; why: string };

/** Where sibling `name` is on this machine (see the header for the order). */
export function resolveSibling(name: SiblingName, cwd: string = process.cwd(), env: Env = process.env, home = homedir()): SiblingRoot {
  const override = env[SIBLINGS[name].env]?.trim();
  if (override) {
    if (override === "off") return { root: null, why: `${absentSibling(name)} (${SIBLINGS[name].env}=off)` };
    const path = resolve(cwd, override);
    return existsSync(path) ? { root: path, from: "env" } : { root: null, why: `${absentSibling(name)} (${SIBLINGS[name].env} points at ${path}, which does not exist)` };
  }
  const proofs = proofsWorktree(name, env, home);
  if (existsSync(join(proofs, ".git"))) return { root: proofs, from: "proofs-worktree" };
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

/** The main checkout of the repository `root` belongs to (the working tree of its common git dir), or null. */
export function mainCheckoutOf(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return root;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!gitdir) return null;
    const linked = resolve(root, gitdir);
    const common = readFileSync(join(linked, "commondir"), "utf8").trim();
    return dirname(resolve(linked, common));
  } catch { return null; }
}

/**
 * Why the mutation runner may NOT write `path` (relative to the sibling checkout `root`), or null when it may. The shared
 * checkouts are where the core is built and deployed from and where other agents work: a mutation happens only in a linked
 * worktree under `<worktree root>/<repo>/`, never in the repository's main checkout, never in a default location, and the
 * file must stay inside that worktree after symbolic links are followed.
 */
export function refuseMutation(name: SiblingName, root: string, path: string, cwd: string = process.cwd(), env: Env = process.env, home = homedir()): string | null {
  const repo = SIBLINGS[name].repo;
  const at = real(root);
  const allowed = real(siblingWorktreeDir(name, env, home));
  const shared = [...defaultSiblingLocations(name, cwd, home), mainCheckoutOf(root)].filter((p): p is string => !!p && existsSync(p)).map(real);
  const hit = shared.find((checkout) => inside(at, checkout) || inside(checkout, at));
  if (hit) return `refused: ${root} is (or holds) the shared checkout ${hit} of ${repo}; mutate only in a worktree under ${allowed}${sep} (npm run sma:sibling -- setup ${name})`;
  if (!inside(at, allowed) || at === allowed) return `refused: ${root} is not a worktree under ${allowed}${sep}; run npm run sma:sibling -- setup ${name} and point ${SIBLINGS[name].env} at it`;
  try { if (!statSync(join(at, ".git")).isFile()) return `refused: ${root} is not a linked worktree (its .git is not a file)`; } catch { return `refused: ${root} is not a git checkout`; }
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) return `refused: ${path} must be a path inside the sibling checkout`;
  const file = join(at, path);
  if (existsSync(file) && !inside(real(file), at)) return `refused: ${path} resolves outside ${root} (a symbolic link)`;
  return null;
}
