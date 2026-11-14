// Fixture trees for region 27 «Shipping and honest numbers»: a small release candidate in a temp folder that `scripts/lp-ship.ts` judges
// through LP_SHIP_ROOT, with a stand-in `bb` on PATH. The four-proofs test (tests/sma/four-proofs-r27-a.test.ts) and the region scene
// (sma_r27.py through sma_r27_probe.ts) build their trees here, so the scene runs the same checks the test proves.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const repoRoot = join(import.meta.dirname, "../../..");
export const shipScript = join(repoRoot, "scripts/lp-ship.ts");

export type Tree = { root: string; bin: string; receipts: string };
export type TreeOptions = {
  /** Production dependencies as name → license: a real node_modules with these packages (no tsx, so no atlas check); without it node_modules links to the checkout's. */
  deps?: Record<string, string>;
  /** THIRD_PARTY_NOTICES.md body. */
  notices?: string;
};

const nodeModulesOfCheckout = (): string => {
  for (let dir = repoRoot; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, "node_modules", "tsx"))) return join(dir, "node_modules");
  throw new Error("no node_modules with tsx above the checkout");
};

export const git = (root: string, ...args: string[]): string => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
export const write = (root: string, path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
export const commit = (root: string, message: string): void => { git(root, "add", "-A"); git(root, "commit", "-qm", message); };

const CLI_COMMANDS = `export const commands = [
  { name:"task", summary:"show a task", usage:"task <id>" },
  { name:"phase", summary:"show a phase", usage:"phase <id>" },
];
`;

/** A clean release candidate: tag v0.1.0 on the first commit, version 0.1.1 with its CHANGELOG entry on the second, a built dist, a test-full receipt, a stand-in bb. */
export function releaseTree(options: TreeOptions = {}): Tree {
  const root = mkdtempSync(join(tmpdir(), "lp-r27-"));
  const bin = join(root, ".bin");
  const receipts = join(root, ".receipts");
  git(root, "init", "-q", "-b", "main");
  const pkg = (version: string) => JSON.stringify({ name: "fixture", version, license: "MIT", dependencies: Object.fromEntries(Object.keys(options.deps ?? {}).map((name) => [name, "1.0.0"])), bb: { server: "./server.ts", host: "./host.ts", app: "./app.tsx" } }, null, 2);
  const lock = (versions: Record<string, string>) => JSON.stringify({ packages: { "": {}, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])) } });
  write(root, ".gitignore", "node_modules\ndist/\n.bin/\n.receipts/\n.atlas-stale\n");
  write(root, "LICENSE", "MIT\n");
  for (const file of ["server.ts", "host.ts", "app.tsx"]) write(root, file, "export {};\n");
  write(root, "scripts/generate-atlas.ts", "import { existsSync } from \"node:fs\";\nprocess.exit(existsSync(\".atlas-stale\") ? 1 : 0);\n");
  write(root, "src/rooms/tools/server/cli-commands.ts", CLI_COMMANDS);
  // Proofs of the SMA map are judged only in a tree that carries the map's sources: an empty entries file makes the fixture such a tree.
  write(root, "src/rooms/sma-map/entries.ts", "export {};\n");
  write(root, "README.md", "# Fixture\n\nRun `bb lane-pilot task` and `bb lane-pilot phase`.\n");
  write(root, "package.json", pkg("0.1.0"));
  write(root, "package-lock.json", lock({ foo: "1.0.0", bar: "2.0.0" }));
  write(root, "CHANGELOG.md", "# Changelog\n\n## 0.1.0\n\n- First cut.\n");
  commit(root, "first");
  git(root, "tag", "v0.1.0");
  write(root, "package.json", pkg("0.1.1"));
  write(root, "package-lock.json", lock({ foo: "1.1.0", bar: "2.0.0", baz: "0.1.0" }));
  write(root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Added the second cut; measured by the drill.\n\n## 0.1.0\n\n- First cut.\n");
  commit(root, "second");
  for (const slot of ["server", "host", "app"]) {
    write(root, `dist/${slot}.js`, "// built\n");
    write(root, `dist/${slot}.meta.json`, JSON.stringify({ pluginVersion: "0.1.1" }));
  }
  if (options.deps) {
    for (const [name, license] of Object.entries(options.deps)) write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, license }));
    if (options.notices !== undefined) { write(root, "THIRD_PARTY_NOTICES.md", options.notices); commit(root, "notices"); }
  } else symlinkSync(nodeModulesOfCheckout(), join(root, "node_modules"));
  // The stand-in bb: `plugin build` exits BUILD_RC (default 0), `plugin list --json` answers the version in SERVED (nothing set: the hub cannot be asked), `task <id> --json` prints bin/task-<id>.json.
  mkdirSync(bin, { recursive: true });
  const bb = join(bin, "bb");
  writeFileSync(bb, `#!/bin/sh
case "$1 $2" in
  "plugin build") exit "\${BUILD_RC:-0}" ;;
  "plugin list") [ -n "$SERVED" ] || exit 1; echo "{\\"plugins\\":[{\\"id\\":\\"lane-pilot\\",\\"version\\":\\"$SERVED\\"}]}" ;;
  "lane-pilot task") f="$(dirname "$0")/task-$3.json"; [ -f "$f" ] && cat "$f" || exit 1 ;;
esac
`);
  chmodSync(bb, 0o755);
  stampReceipt({ root, bin, receipts });
  return { root, bin, receipts };
}

/** The test-full receipt of the tree as it stands now (keyed by tree hash and node version). Call again after a commit. */
export function stampReceipt(tree: Tree): void {
  mkdirSync(join(tree.receipts, `${git(tree.root, "rev-parse", "HEAD^{tree}")}-${process.version}`), { recursive: true });
}

/** `lp-ship.ts <args>` against the tree. */
export function ship(tree: Tree, args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const done = spawnSync("npx", ["tsx", shipScript, ...args], {
    cwd: repoRoot, encoding: "utf8", timeout: 240_000,
    env: { ...process.env, LP_SHIP_ROOT: tree.root, LP_TEST_RECEIPTS: tree.receipts, BB_CLI: join(tree.bin, "bb"), PATH: `${tree.bin}:${process.env.PATH}`, ...env },
  });
  return { status: done.status, out: `${done.stdout}${done.stderr}` };
}

/** A backlog item the batch verb reads (.agents/todos/items/<id>/meta.yaml). */
export function todo(tree: Tree, id: string, fields: Record<string, string> = {}): void {
  const meta = { id, title: id, status: "ready", priority: "medium", estimate: "2", created: "2026-01-01", ...fields };
  write(tree.root, `.agents/todos/items/${id}/meta.yaml`, `${Object.entries(meta).map(([key, value]) => `${key}: ${value}`).join("\n")}\n`);
}

/** What `bb lane-pilot task <id> --json` answers in the stand-in bb. */
export function taskRecord(tree: Tree, id: string, record: { state: string; stages: Array<{ id: string; state: string }> }): void {
  write(tree.bin, `task-${id}.json`, JSON.stringify(record));
}
