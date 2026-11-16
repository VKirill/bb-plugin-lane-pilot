import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_IDENTITY_ENV } from "../src/rooms/sma-map/sibling-git";

// The mutation runner across repositories (scripts/sma-mutate.mjs, src/rooms/sma-map/siblings.ts) on fixture siblings in a
// temp folder, each a selected checkout where the runner looks for it (a fake home's ~/BB-service/…): a strong test is killed,
// a hollow one survives, a crashing mutation is a crash (vitest for the core, node:test through tsx for the Telegram plugin),
// an absent sibling is reported absent, another selected clone without dependencies stops before writing, a second runner is locked out, a journal a killed run left
// is settled by the next run that touches that checkout — and a foreign edit is never overwritten — an uncommitted subject is
// refused, a HEAD that moves during the run voids the verdict. After every run no fixture file is left mutated.
const ROOT = resolve(__dirname, "..");
const NODE_MODULES = (() => { for (let dir = ROOT; dir !== dirname(dir); dir = dirname(dir)) if (existsSync(join(dir, "node_modules", ".bin", "vitest"))) return join(dir, "node_modules"); throw new Error("no node_modules with vitest above the plugin"); })();
const TSX = join(NODE_MODULES, ".bin", "tsx");
const SUBJECT = `export function verdict(score: number): { status: "pass" | "rework"; score: number } {
  if (score >= 7) return { status: "pass", score };
  return { status: "rework", score };
}
`;
const MUTANT = SUBJECT.replace("if (score >= 7)", "if (score < 7)");
let tmp = "", home = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=fx@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8", stdio: "pipe" });
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const sha = (path: string) => hash(readFileSync(path));

/** A sibling's default checkout at its default place under the fake home, on `branch`. */
function sibling(folder: string, branch: string, files: Record<string, string>): string {
  const at = join(home, "BB-service", ...folder.split("/"));
  for (const [path, text] of Object.entries({ ".gitignore": "node_modules\n", ...files })) write(join(at, path), text);
  git(at, "init", "-q", "-b", branch);
  git(at, "add", ".");
  git(at, "commit", "-q", "-m", "fixture");
  // Dependencies: the fixtures import vitest / run tsx from the node_modules this plugin resolves.
  symlinkSync(NODE_MODULES, join(at, "node_modules"));
  return at;
}

let core = "";
let telegram = "";
const env = (extra: Record<string, string> = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_IDENTITY_ENV.test(key))), HOME: home, TMPDIR: join(tmp, "tmp"), SMA_MUTATE_TSX: "1", SMA_SIBLING_CORE: core, SMA_SIBLING_TELEGRAM: telegram, ...extra });
function runSpecs(specs: unknown[], extra: Record<string, string> = {}): Array<{ id: string; result: string; detail?: string }> {
  const file = join(tmp, `specs-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(specs));
  const run = spawnSync(TSX, [join(ROOT, "scripts/sma-mutate.mjs"), "--fixture", file, "--json"], { cwd: ROOT, encoding: "utf8", env: env(extra), timeout: 240_000 });
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  if (!last.startsWith("[")) throw new Error(`runner said: ${run.stdout}\n${run.stderr}`);
  return JSON.parse(last);
}
const flipSpec = (id: string, file: string, tests: string[], pattern: string) => ({ id, file, find: "if (score >= 7)", replace: "if (score < 7)", kind: "flipped-branch", tests, pattern });
const crashSpec = (id: string, file: string, tests: string[], pattern: string) => ({ id, file, find: "return { status: \"pass\", score };", replace: "return { status: \"pass\", score: (score as unknown as { a: { b: number } }).a.b };", kind: "distorted-field", tests, pattern });
const CORE_SUBJECT = "core:packages/fx/src/subject.ts";
const strongCore = () => flipSpec("strong", CORE_SUBJECT, ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]");
/** The runner's journal of the core fixture, in its git directory. */
const coreState = () => join(core, ".git", "sma-mutate");
function leaveJournal(current: string, lockPid: number) {
  const subject = join(core, "packages/fx/src/subject.ts");
  mkdirSync(coreState(), { recursive: true });
  writeFileSync(join(coreState(), "backup"), SUBJECT);
  writeFileSync(join(coreState(), "journal.json"), JSON.stringify({ file: subject, original: hash(SUBJECT), mutant: hash(MUTANT) }));
  writeFileSync(join(coreState(), "lock"), String(lockPid));
  writeFileSync(subject, current);
  return subject;
}
const settle = () => { rmSync(coreState(), { recursive: true, force: true }); git(core, "checkout", "-q", "--", "."); };

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "sma-siblings-"));
  home = join(tmp, "home");
  mkdirSync(join(tmp, "tmp"));
  core = sibling("bb-core/vk", "vk/experimental", {
    "packages/fx/vitest.config.ts": "import { defineConfig } from \"vitest/config\";\nexport default defineConfig({ test: { include: [\"src/**/*.test.ts\"] } });\n",
    "packages/fx/src/subject.ts": SUBJECT,
    "packages/fx/src/subject.test.ts": "import { expect, it } from \"vitest\";\nimport { verdict } from \"./subject\";\nit(\"[sma:fx_core] seven passes, six is sent back\", () => {\n  expect(verdict(7)).toEqual({ status: \"pass\", score: 7 });\n  expect(verdict(6)).toEqual({ status: \"rework\", score: 6 });\n});\n",
    "packages/fx/src/hollow.test.ts": "import { expect, it } from \"vitest\";\nimport { verdict } from \"./subject\";\nit(\"[sma:fx_hollow] returns a verdict\", () => {\n  expect(typeof verdict(7).status).toBe(\"string\");\n});\n",
    // A red test that commits in its repository while it runs: a baseline-red verdict must hold the same identity.
    "packages/fx/src/red-move.test.ts": "import { execFileSync } from \"node:child_process\";\nimport { resolve } from \"node:path\";\nimport { expect, it } from \"vitest\";\nit(\"[sma:fx_red_move] is red\", () => {\n  execFileSync(\"git\", [\"-C\", resolve(__dirname, \"../../..\"), \"-c\", \"user.email=fx@example.invalid\", \"-c\", \"user.name=fixture\", \"commit\", \"-q\", \"--allow-empty\", \"-m\", \"moved\"]);\n  expect(1).toBe(2);\n});\n",
    // A strong test that also commits in its repository while it runs: the checkout's HEAD moves during the node.
    "packages/fx/src/move.test.ts": "import { execFileSync } from \"node:child_process\";\nimport { resolve } from \"node:path\";\nimport { expect, it } from \"vitest\";\nimport { verdict } from \"./subject\";\nit(\"[sma:fx_move] seven passes, six is sent back\", () => {\n  execFileSync(\"git\", [\"-C\", resolve(__dirname, \"../../..\"), \"-c\", \"user.email=fx@example.invalid\", \"-c\", \"user.name=fixture\", \"commit\", \"-q\", \"--allow-empty\", \"-m\", \"moved\"]);\n  expect(verdict(7)).toEqual({ status: \"pass\", score: 7 });\n  expect(verdict(6)).toEqual({ status: \"rework\", score: 6 });\n});\n",
  });
  telegram = sibling("bb-plugin-telegram-projects", "main", {
    "subject.ts": SUBJECT,
    "test/subject.test.ts": "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { verdict } from \"../subject\";\ntest(\"[sma:fx_tg] seven passes, six is sent back\", () => {\n  assert.deepEqual(verdict(7), { status: \"pass\", score: 7 });\n  assert.deepEqual(verdict(6), { status: \"rework\", score: 6 });\n});\ntest(\"another test the filter leaves out\", () => { assert.ok(true); });\n",
  });
});
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("sma-mutate across repositories (fixture selected checkouts)", () => {
  it("core (vitest from the package): a strong test kills, a hollow one survives, a crash is a crash; nothing is left mutated", () => {
    const subject = join(core, "packages/fx/src/subject.ts");
    const before = sha(subject);
    const results = runSpecs([
      strongCore(),
      flipSpec("hollow", CORE_SUBJECT, ["core:packages/fx/src/hollow.test.ts"], "\\[sma:fx_hollow\\]"),
      crashSpec("crash", CORE_SUBJECT, ["core:packages/fx/src/subject.test.ts"], "\\[sma:fx_core\\]"),
    ]);
    expect(results.map((r) => [r.id, r.result])).toEqual([["strong", "killed"], ["hollow", "survived"], ["crash", "crash"]]);
    expect(results[0]!.detail).toMatch(/AssertionError/);
    expect(results[2]!.detail).toMatch(/TypeError/);
    expect(sha(subject)).toBe(before);
    expect(git(core, "status", "--porcelain", "--untracked-files=all").trim()).toBe("");
    expect(existsSync(join(coreState(), "journal.json"))).toBe(false);
  }, 240_000);

  it("telegram (node:test through tsx, JUnit report): a strong test kills, a crash is a crash; the filter runs only the [sma:] test", () => {
    const subject = join(telegram, "subject.ts");
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
    const results = runSpecs([strongCore()], { SMA_SIBLING_CORE: "off" });
    expect(results[0]!.result).toBe("absent");
    expect(results[0]!.detail).toContain("sibling repository bb-core is not on this machine");
  }, 120_000);

  it("an override pointing at another clone is selected for mutation; missing dependencies stop before writing and the clone's file stays untouched", () => {
    const elsewhere = join(tmp, "elsewhere", "bb-core");
    execFileSync("git", ["clone", "-q", "-b", "vk/experimental", core, elsewhere]);
    const file = join(elsewhere, "packages/fx/src/subject.ts");
    const before = sha(file);
    const results = runSpecs([strongCore()], { SMA_SIBLING_CORE: elsewhere });
    expect(results[0]!.result).toBe("no-tests");
    expect(results[0]!.detail).toMatch(/pnpm install/);
    expect(sha(file)).toBe(before);
  }, 120_000);

  it("refuses an ambient Git directory before state, journal or contract-index writes", () => {
    const contracts = join(ROOT, "src/rooms/sma-map/contracts.ts");
    const before = sha(contracts);
    rmSync(coreState(), { recursive: true, force: true });
    const run = spawnSync(TSX, [join(ROOT, "scripts/sma-mutate.mjs"), "--node", "n560", "--json"], {
      cwd: ROOT, encoding: "utf8", env: env({ GIT_DIR: join(core, ".git") }), timeout: 120_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/active Git identity override GIT_DIR/);
    expect(sha(contracts)).toBe(before);
    expect(existsSync(coreState())).toBe(false);
    const help = spawnSync(TSX, [join(ROOT, "scripts/sma-mutate.mjs"), "--help"], {
      cwd: ROOT, encoding: "utf8", env: env({ GIT_DIR: join(core, ".git") }), timeout: 120_000,
    });
    expect(help.status).toBe(2);
    expect(help.stderr).toMatch(/active Git identity override GIT_DIR/);
    expect(sha(contracts)).toBe(before);
    expect(existsSync(coreState())).toBe(false);
  }, 120_000);

  it("a dirty file the subject does not name (a dependency, its config, an untracked file) refuses the checkout before anything is written", () => {
    const subject = join(core, "packages/fx/src/subject.ts");
    const config = join(core, "packages/fx/vitest.config.ts");
    const before = readFileSync(config, "utf8");
    writeFileSync(config, `${before}// an edit to a dependency\n`);
    try {
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/not committed .*packages\/fx\/vitest\.config\.ts/);
      expect(sha(subject)).toBe(hash(SUBJECT));
    } finally { git(core, "checkout", "-q", "--", "."); }
    write(join(core, "packages/fx/src/extra.ts"), "export const extra = 1;\n");
    try {
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/not committed .*packages\/fx\/src\/extra\.ts/);
    } finally { rmSync(join(core, "packages/fx/src/extra.ts"), { force: true }); }
  }, 120_000);

  it("a subject git status hides (assume-unchanged) is still compared byte for byte with HEAD and refused", () => {
    const subject = join(core, "packages/fx/src/subject.ts");
    git(core, "update-index", "--assume-unchanged", "packages/fx/src/subject.ts");
    writeFileSync(subject, `${SUBJECT}// hidden from git status\n`);
    try {
      expect(git(core, "status", "--porcelain").trim()).toBe("");
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/not the bytes HEAD has .*packages\/fx\/src\/subject\.ts/);
      expect(readFileSync(subject, "utf8")).toBe(`${SUBJECT}// hidden from git status\n`);
    } finally { git(core, "update-index", "--no-assume-unchanged", "packages/fx/src/subject.ts"); git(core, "checkout", "-q", "--", "."); }
  }, 120_000);

  it("a baseline-red verdict is held to the same identity: a HEAD that moved during the baseline makes it refused", () => {
    const head = git(core, "rev-parse", "HEAD").trim();
    try {
      const results = runSpecs([flipSpec("red", CORE_SUBJECT, ["core:packages/fx/src/red-move.test.ts"], "\\[sma:fx_red_move\\]")]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/changed while this node ran.*HEAD/);
    } finally { git(core, "reset", "-q", "--soft", head); }
  }, 240_000);

  it("a journal naming a file outside the checkout, or a link out of it, restores nothing: refused, the outside file and the journal stay", () => {
    const outside = join(tmp, "outside.ts");
    writeFileSync(outside, MUTANT);
    const link = join(core, "packages/fx/src/link.ts");
    for (const target of [outside, link]) {
      mkdirSync(coreState(), { recursive: true });
      writeFileSync(join(coreState(), "backup"), SUBJECT);
      writeFileSync(join(coreState(), "journal.json"), JSON.stringify({ file: target, original: hash(SUBJECT), mutant: hash(MUTANT) }));
      if (target === link) symlinkSync(outside, link);
      try {
        const results = runSpecs([strongCore()]);
        expect(results[0]!.result).toBe("refused");
        expect(results[0]!.detail).toMatch(/may not be written/);
        expect(readFileSync(outside, "utf8")).toBe(MUTANT);
        expect(existsSync(join(coreState(), "journal.json"))).toBe(true);
      } finally { rmSync(link, { force: true }); settle(); }
    }
  }, 120_000);

  it("a committed subject or test with uncommitted edits is refused before anything is written", () => {
    const subject = join(core, "packages/fx/src/subject.ts");
    writeFileSync(subject, `${SUBJECT}// an edit\n`);
    try {
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/not committed .*packages\/fx\/src\/subject\.ts/);
      expect(readFileSync(subject, "utf8")).toBe(`${SUBJECT}// an edit\n`);
    } finally { git(core, "checkout", "-q", "--", "."); }
  }, 120_000);

  it("a second runner is locked out of a checkout a live runner holds, and leaves its journal and mutated file alone", () => {
    const subject = leaveJournal(MUTANT, process.pid); // this test process is the live holder
    try {
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("locked");
      expect(readFileSync(subject, "utf8")).toBe(MUTANT);
      expect(existsSync(join(coreState(), "journal.json"))).toBe(true);
      expect(readFileSync(join(coreState(), "lock"), "utf8")).toBe(String(process.pid));
    } finally { settle(); }
  }, 120_000);

  it("a file a killed run (kill -9) left mutated is restored from the journal in the git directory by the next run there", () => {
    const subject = leaveJournal(MUTANT, 999_999_999); // a runner that is gone
    try {
      const results = runSpecs([strongCore()]);
      expect(readFileSync(subject, "utf8")).toBe(SUBJECT);
      expect(results[0]!.result).toBe("killed");
      expect(existsSync(join(coreState(), "journal.json"))).toBe(false);
      expect(existsSync(join(coreState(), "backup"))).toBe(false);
    } finally { settle(); }
  }, 120_000);

  it("a file somebody edited since the mutation is never overwritten: the checkout is refused, the journal and the backup stay", () => {
    const edit = `${SUBJECT}// somebody's edit after the crash\n`;
    const subject = leaveJournal(edit, 999_999_999);
    try {
      const results = runSpecs([strongCore()]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/neither the original nor the mutant/);
      expect(readFileSync(subject, "utf8")).toBe(edit);
      expect(readFileSync(join(coreState(), "backup"), "utf8")).toBe(SUBJECT);
      expect(existsSync(join(coreState(), "journal.json"))).toBe(true);
    } finally { settle(); }
  }, 120_000);

  it("a HEAD that moves while the node runs voids the verdict (refused, not killed), and the file is still restored", () => {
    const subject = join(core, "packages/fx/src/subject.ts");
    const head = git(core, "rev-parse", "HEAD").trim();
    try {
      const results = runSpecs([flipSpec("move", CORE_SUBJECT, ["core:packages/fx/src/move.test.ts"], "\\[sma:fx_move\\]")]);
      expect(results[0]!.result).toBe("refused");
      expect(results[0]!.detail).toMatch(/changed while this node ran.*HEAD/);
      expect(readFileSync(subject, "utf8")).toBe(SUBJECT);
    } finally { git(core, "reset", "-q", "--soft", head); }
  }, 240_000);
});
