/**
 * Sibling repositories of the SMA proof (src/rooms/sma-map/siblings.ts, docs/sma-evidence.md «Proofs in a sibling repository»).
 *   npx tsx scripts/sma-sibling.ts status                       where each sibling resolves, its HEAD and the pins
 *   npx tsx scripts/sma-sibling.ts setup core|telegram [--id <id>] [--branch <name>] [--from <ref>]
 * `setup` makes a linked worktree of the sibling under the machine's one worktree root, `<root>/<repo>/<id>` (default id
 * `sma-proofs`, the proofs worktree the tools find by themselves; a batch agent passes its own id and exports the printed
 * SMA_SIBLING_* line), on a new branch (`sma/core-proofs` / `sma/proofs`, or `<that>-<id>`) cut from that branch when it exists,
 * else from the sibling's base (`vk/experimental` / HEAD). Then it installs the dependencies offline from the machine's package
 * store and prints how long each step took. It writes nothing into the shared checkout's working tree (git records the new
 * worktree and branch in the repository's .git, as every worktree does). An existing worktree is reused: setup only installs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SMA_SIBLING_TESTS_AT } from "../src/rooms/sma-map/contracts";
import SMA_PROVENANCE from "../src/rooms/sma-map/provenance.json";
import { headOf, isDirty } from "../src/rooms/sma-map/sibling-git";
import { defaultSiblingLocations, mainCheckoutOf, resolveSibling, SIBLING_NAMES, SIBLINGS, siblingWorktreeDir, type SiblingName } from "../src/rooms/sma-map/siblings";

const root = join(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const flag = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const say = (line: string) => process.stdout.write(`${line}\n`);
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch { return null; } };

function status(): number {
  for (const name of SIBLING_NAMES) {
    const at = resolveSibling(name, root);
    const pins = `contracts pin ${SMA_SIBLING_TESTS_AT[name] ?? "none"}, provenance pin ${(SMA_PROVENANCE as { siblingsAt?: Partial<Record<SiblingName, string>> }).siblingsAt?.[name] ?? "none"}`;
    if (at.root === null) { say(`${name.padEnd(9)} ${at.why}; ${pins}`); continue; }
    say(`${name.padEnd(9)} ${SIBLINGS[name].repo} at ${at.root} (${at.from}); HEAD ${headOf(at.root)}${isDirty(at.root) ? "+dirty" : ""} on ${tryGit(at.root, "branch", "--show-current") || "(detached)"}; ${pins}`);
  }
  return 0;
}

function run(cwd: string, command: readonly string[]): { ok: boolean; seconds: number; tail: string } {
  const started = Date.now();
  const done = spawnSync(command[0]!, command.slice(1), { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  return { ok: done.status === 0, seconds: (Date.now() - started) / 1000, tail: `${done.stdout ?? ""}${done.stderr ?? ""}`.trim().split("\n").slice(-6).join("\n") };
}

function setup(name: SiblingName): number {
  const spec = SIBLINGS[name];
  const id = flag("--id") ?? "sma-proofs";
  if (!/^[\w.-]+$/.test(id)) { say(`--id ${id}: letters, digits, dot, dash, underscore only`); return 2; }
  const target = join(siblingWorktreeDir(name), id);
  // The repository to fork: the main checkout behind whatever this machine resolves the sibling to.
  const resolved = resolveSibling(name, root);
  const repo = (resolved.root ? mainCheckoutOf(resolved.root) : null) ?? defaultSiblingLocations(name, root).find((path) => existsSync(join(path, ".git")));
  if (!repo) { say(`${spec.repo} is not on this machine: clone it first (the default places: ${defaultSiblingLocations(name, root).join(", ")})`); return 2; }
  if (!existsSync(join(target, ".git"))) {
    const branch = flag("--branch") ?? (id === "sma-proofs" ? spec.proofBranch : `${spec.proofBranch}-${id}`);
    const from = flag("--from") ?? (tryGit(repo, "rev-parse", "--verify", "-q", `refs/heads/${spec.proofBranch}`) && branch !== spec.proofBranch ? spec.proofBranch : spec.baseRef);
    mkdirSync(siblingWorktreeDir(name), { recursive: true });
    const exists = !!tryGit(repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    const started = Date.now();
    try { git(repo, "worktree", "add", ...(exists ? [target, branch] : ["-b", branch, target, from])); } catch (cause) { say(`git worktree add failed: ${cause instanceof Error ? cause.message.split("\n")[0] : cause}`); return 1; }
    say(`worktree ${target} on ${branch}${exists ? "" : ` (new, from ${from})`} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } else say(`worktree ${target} exists (HEAD ${headOf(target)} on ${tryGit(target, "branch", "--show-current") || "(detached)"}): installing only`);
  for (const command of spec.setup) {
    const done = run(target, command);
    say(`${done.ok ? "ok  " : "FAIL"} ${command.join(" ")} (${done.seconds.toFixed(1)} s)${done.ok ? "" : `\n${done.tail}`}`);
    if (!done.ok) return 1;
  }
  say(`\nready. Point the tools at it: export ${spec.env}=${target}${id === "sma-proofs" ? "   (the proofs worktree is also found without it)" : ""}`);
  return 0;
}

const [command, name] = argv;
if (command === "status") process.exit(status());
if (command === "setup" && SIBLING_NAMES.includes(name as SiblingName)) process.exit(setup(name as SiblingName));
say("usage: npx tsx scripts/sma-sibling.ts status | setup core|telegram [--id <id>] [--branch <name>] [--from <ref>]");
process.exit(2);
