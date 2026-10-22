import { isAbsolute, posix, relative, resolve } from "node:path";
import { matchOwnsPath } from "@lane-pilot/kit";

/**
 * Trusted tooling (SMA wall 9, P2-4): the files that run on their own or decide whether work counts. A writer that edits
 * one silently changes what «green» means (a hook, a CI workflow, the project's own check script), so they are in every
 * task's never_touch unless the task names them in owns_paths. This is protection from mistakes, not from a malicious
 * agent: one explicit owns_paths line lifts it, and nobody is asked.
 */
export const TRUSTED_TOOLING_PATTERNS = [".git/hooks/**", ".husky/**", ".claude/**", "lane-stack/hooks/**", ".github/workflows/**"] as const;

type Guarded = {
  project_cwd:string;
  owns_paths:string[];
  never_touch:string[];
  expected_outputs:string[];
  files?:Array<{ path:string }> | undefined;
  verification:Array<{ command:string; cwd:string }>;
};

const WILDCARD = /[*?[]/;
const SCRIPT_RUNNERS = new Set(["bash", "sh", "zsh", "node", "tsx", "ts-node", "python", "python3", "ruby", "perl", "bun", "deno"]);
const SCRIPT_FILE = /\.(sh|bash|zsh|mjs|cjs|js|ts|mts|cts|py|rb|pl)$/;
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$/;

function clean(path:string):string {
  return posix.normalize(path.replaceAll("\\", "/").replace(/^\.\//, "")).replace(/\/+$/, "");
}

/** The part of a pattern before its first wildcard («.github/workflows/**» gives «.github/workflows»). */
function literalBase(pattern:string):string {
  const parts:string[] = [];
  for (const part of clean(pattern).split("/")) {
    if (WILDCARD.test(part)) break;
    parts.push(part);
  }
  return parts.join("/");
}

/** One of the two lies inside the other. A pattern with no literal base («**», «*.ts») targets nothing in particular. */
function targets(owned:string, trusted:string):boolean {
  const x = literalBase(owned), y = literalBase(trusted);
  if (!x || x === ".") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/**
 * The check scripts a task's verification[] runs: `bash scripts/check.sh`, `node tools/verify.mjs`, `npx tsx bin/probe.ts`,
 * `./scripts/gate.sh`. Test files are not among them: a writer updates the tests of the code it changes. Paths are
 * relative to the project, never outside it.
 */
export function verificationScriptPaths(task:Pick<Guarded, "project_cwd" | "verification">):string[] {
  const found = new Set<string>();
  for (const check of task.verification) {
    for (const segment of check.command.split(/&&|\|\||;|\||\n/)) {
      const tokens = segment.trim().split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, "")).filter(Boolean);
      while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
      if (tokens[0] === "npx" || tokens[0] === "bunx") tokens.shift();
      const program = tokens.shift();
      if (!program) continue;
      const script = SCRIPT_RUNNERS.has(program.split("/").pop()!) ? tokens.find((token) => !token.startsWith("-")) : (program.startsWith("./") ? program : undefined);
      if (!script || /[$`~*?[]/.test(script) || !SCRIPT_FILE.test(script)) continue;
      const absolute = isAbsolute(script) ? script : resolve(isAbsolute(check.cwd) ? check.cwd : resolve(task.project_cwd, check.cwd), script);
      const rel = relative(resolve(task.project_cwd), absolute).replaceAll("\\", "/");
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || TEST_FILE.test(rel)) continue;
      found.add(rel);
    }
  }
  return [...found].sort();
}

/** Everything a task names as its own work: owns_paths, path-like expected_outputs and files[]. */
function namedPaths(task:Pick<Guarded, "owns_paths" | "expected_outputs" | "files">):string[] {
  return [
    ...task.owns_paths,
    ...task.expected_outputs.filter((entry) => !/\s/.test(entry.trim()) && (entry.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(entry))),
    ...(task.files ?? []).map((file) => file.path),
  ];
}

/** The trusted-tooling patterns that stay in force for this task: the defaults and its check scripts, minus what its own paths name. */
export function trustedToolingFor(task:Guarded):string[] {
  const named = namedPaths(task);
  return [...TRUSTED_TOOLING_PATTERNS, ...verificationScriptPaths(task)].filter((pattern) => !named.some((own) => targets(own, pattern)));
}

/**
 * The contract with the trusted tooling added to never_touch. Idempotent (a pattern already there is not added twice),
 * keeps the PM's own entries first, and leaves out what owns_paths / expected_outputs / files[] explicitly name.
 */
export function applyTrustedTooling<T extends Guarded>(task:T):T {
  const have = new Set(task.never_touch.map(clean));
  const added = trustedToolingFor(task).filter((pattern) => !have.has(clean(pattern)));
  return added.length ? { ...task, never_touch:[...task.never_touch, ...added] } : task;
}

/** The files among `paths` that are trusted tooling for this task (the defaults or one of its check scripts). */
export function trustedToolingHits(paths:readonly string[], task:Pick<Guarded, "project_cwd" | "verification">):string[] {
  const patterns = [...TRUSTED_TOOLING_PATTERNS, ...verificationScriptPaths(task)];
  return paths.filter((path) => patterns.some((pattern) => matchOwnsPath(clean(path), pattern)));
}

/** What a refusal says when a rejected file is trusted tooling: why, and the one thing to do. Null when none is. */
export function trustedToolingHint(paths:readonly string[], task:Pick<Guarded, "project_cwd" | "verification">):string | null {
  const hits = trustedToolingHits(paths, task);
  if (!hits.length) return null;
  return `${hits.slice(0, 5).join(", ")} is trusted tooling (hooks, CI workflows, .claude and the task's own check scripts are kept out of reach by default); undo that change, or, if this task has to change it, dispatch it again with that exact path in owns_paths`;
}
