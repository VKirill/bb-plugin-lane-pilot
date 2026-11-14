import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The mutation runner across repositories (scripts/sma-mutate.mjs, src/rooms/sma-map/siblings.ts) on fixture siblings in a
// temp folder: a strong test is killed, a hollow one survives, a crashing mutation is a crash (in both runners: vitest for
// the core, node:test through tsx for the Telegram plugin), an absent sibling is reported absent, a spec pointing into the
// shared checkout is refused — and after every run no fixture file is left mutated. A journal a killed run left behind is
// restored by the next run.
const ROOT = resolve(__dirname, "..");
const NODE_MODULES = (() => { for (let dir = ROOT; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, "node_modules", ".bin", "vitest"))) return join(dir, "node_modules"); throw new Error("no node_modules with vitest above the plugin"); })();
const SUBJECT = `export function verdict(score: number): { status: "pass" | "rework"; score: number } {
  if (score >= 7) return { status: "pass", score };
  return { status: "rework", score };
}
`;
let tmp = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=fx@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8", stdio: "pipe" });
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A sibling repository: its shared main checkout and one linked worktree under the fixture worktree root. */
function sibling(repo: string, files: Record<string, string>): { shared: string; worktree: string } {
  const shared = join(tmp, "shared", repo);
  for (const [path, text] of Object.entries(files)) write(join(shared, path), text);
  git(shared, "init", "-q", "-b", "main");
  git(shared, "add", ".");
  git(shared, "commit", "-q", "-m", "fixture");
  const worktree = join(tmp, "wt", repo, "fx");
  git(shared, "worktree", "add", "-q", worktree);
  // Dependencies: the fixtures import vitest / run tsx, so both checkouts see the node_modules this plugin resolves from
  // (a worktree of the plugin resolves them from the main checkout above it).
  for (const at of [shared, worktree]) symlinkSync(NODE_MODULES, join(at, "node_modules"));
  return { shared, worktree };
}

let core: { shared: string; worktree: string };
let telegram: { shared: string; worktree: string };
const env = (extra: Record<string, string> = {}) => ({ ...process.env, TMPDIR: join(tmp, "tmp"), LANE_PILOT_WORKTREE_ROOT: join(tmp, "wt"), SMA_SIBLING_CORE: core.worktree, SMA_SIBLING_TELEGRAM: telegram.worktree, ...extra });
function runSpecs(specs: unknown[], extra: Record<string, string> = {}): Array<{ id: string; result: string; detail?: string }> {
  const file = join(tmp, `specs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(specs));
  const run = spawnSync("node", [join(ROOT, "scripts/sma-mutate.mjs"), "--fixture", file, "--json"], { cwd: ROOT, encoding: "utf8", env: env(extra), timeout: 240_000 });
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  if (!last.startsWith("[")) throw new Error(`runner said: ${run.stdout}\n${run.stderr}`);
  return JSON.parse(last);
}
const flipSpec = (id: string, file: string, tests: string[], pattern: string) => ({ id, file, find: "if (score >= 7)", replace: "if (score < 7)", kind: "flipped-branch", tests, pattern });
const crashSpec = (id: string, file: string, tests: string[], pattern: string) => ({ id, file, find: "return { status: \"pass\", score };", replace: "return { status: \"pass\", score: (score as unknown as { a: { b: number } }).a.b };", kind: "distorted-field", tests, pattern });

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "sma-siblings-"));
  mkdirSync(join(tmp, "tmp"));
  core = sibling("bb-core", {
    "packages/fx/vitest.config.ts": "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"src/**/*.test.ts\"] } });\n",
    "packages/fx/src/subject.ts": SUBJECT,
    "packages/fx/src/subject.test.ts": "import { expect, it } from \"vitest\";\nimport { verdict } from \"./subject\";\nit(\"[sma:fx_core] seven passes, six is sent back\", () => {\n  expect(verdict(7)).toEqual({ status: \"pass\", score: 7 });\n  expect(verdict(6)).toEqual({ status: \"rework\", score: 6 });\n});\n",
    "packages/fx/src/hollow.test.ts": "import { expect, it } from \"vitest\";\nimport { verdict } from \"./subject\";\nit(\"[sma:fx_hollow] returns a verdict\", () => {\n  expect(typeof verdict(7).status).toBe(\"string\");\n});\n",
  });
  telegram = sibling("bb-plugin-telegram-projects", {
    "subject.ts": SUBJECT,
    "test/subject.test.ts": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { verdict } from \"../subject\";\ntest(\"[sma:fx_tg] seven passes, six is sent back\", () => {\n  assert.deepEqual(verdict(7), { status: \"pass\", score: 7 });\n  assert.deepEqual(verdict(6), { status: \"rework\", score: 6 });\n});\ntest(\"another test the filter leaves out\", () => { assert.ok(true); });\n",
  });
});
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("sma-mutate across repositories (fixture siblings)", () => {
  it("core (vitest from the package): a strong test kills, a hollow one survives, a crash is a crash; nothing is left mutated", () => {
    const subject = join(core.worktree, "packages/fx/src/subject.ts");
    const before = sha(subject);
    const results = runSpecs([
      flipSpec("strong", "core:packages/fx/src/subject.ts", ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]"),
      flipSpec("hollow", "core:packages/fx/src/subject.ts", ["core:packages/fx/src/hollow.test.ts"], "\\[sma:fx_hollow\\]"),
      crashSpec("crash", "core:packages/fx/src/subject.ts", ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]"),
    ]);
    expect(results.map((r) => [r.id, r.result])).toEqual([["strong", "killed"], ["hollow", "survived"], ["crash", "crash"]]);
    expect(results[0]!.detail).toMatch(/AssertionError/);
    expect(results[2]!.detail).toMatch(/TypeError/);
    expect(sha(subject)).toBe(before);
    expect(git(core.worktree, "status", "--porcelain", "--untracked-files=no").trim()).toBe("");
  }, 240_000);

  it("telegram (node:test through tsx, JUnit report): a strong test kills, a crash is a crash; the filter runs only the [sma:] test", () => {
    const subject = join(telegram.worktree, "subject.ts");
    const before = sha(subject);
    const results = runSpecs([
      flipSpec("strong", "telegram:subject.ts", ["telegram:test/subject.test.ts"], "\\[sma:fx_tg\\]"),
      crashSpec("crash", "telegram:subject.ts", ["telegram:test/subject.test.ts"], "\\[sma:fx_tg\\]"),
    ]);
    expect(results.map((r) => [r.id, r.result])).toEqual([["strong", "killed"], ["crash", "crash"]]);
    expect(results[0]!.detail).toMatch(/ERR_ASSERTION|AssertionError/);
    expect(sha(subject)).toBe(before);
  }, 240_000);

  it("an absent sibling is reported absent (never run, never killed)", () => {
    const results = runSpecs([flipSpec("absent", "core:packages/fx/src/subject.ts", ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]")], { SMA_SIBLING_CORE: "off" });
    expect(results[0]!.result).toBe("absent");
    expect(results[0]!.detail).toContain("sibling repository bb-core is not on this machine");
  }, 120_000);

  it("a spec that resolves into the shared checkout is refused and the shared file is untouched", () => {
    const shared = join(core.shared, "packages/fx/src/subject.ts");
    const before = sha(shared);
    const results = runSpecs([flipSpec("shared", "core:packages/fx/src/subject.ts", ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]")], { SMA_SIBLING_CORE: core.shared });
    expect(results[0]!.result).toBe("refused");
    expect(results[0]!.detail).toMatch(/shared checkout/);
    expect(sha(shared)).toBe(before);
  }, 120_000);

  it("a sibling file a killed run (kill -9) left mutated is restored by the next run, whatever that run is for", () => {
    const subject = join(core.worktree, "packages/fx/src/subject.ts");
    const original = readFileSync(subject);
    const state = join(tmp, "tmp", "sma-mutate", createHash("sha256").update(core.worktree).digest("hex").slice(0, 12));
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "backup"), original);
    writeFileSync(join(state, "journal.json"), JSON.stringify({ file: subject }));
    writeFileSync(join(state, "lock"), "999999999"); // a runner that is gone
    writeFileSync(subject, SUBJECT.replace("if (score >= 7)", "if (score < 7)"));
    runSpecs([]);
    expect(readFileSync(subject).equals(original)).toBe(true);
  }, 120_000);
});
