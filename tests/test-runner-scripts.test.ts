import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runner-script fixtures: the real scripts/test-full.sh and scripts/test-changed.mjs are copied into a temp repo
// whose bin/ holds stub `git` and `npx` commands, so the scripts' decisions are checked without a real suite.
// A git answer of "@<shell>" is emitted verbatim (for stateful stubs); anything else is printed literally.

type GitAnswers = Record<string, string>;

const nodeVersion = () => execFileSync("node", ["-v"], { encoding: "utf8" }).trim();

const gitStub = (dir: string, answers: GitAnswers) => {
  const answerDir = join(dir, "git-answers");
  mkdirSync(answerDir, { recursive: true });
  const arms = Object.entries(answers).map(([args, out], index) => {
    if (out.startsWith("@")) return `  ${JSON.stringify(args)}) ${out.slice(1)} ;;`;
    writeFileSync(join(answerDir, `a${index}`), out);
    return `  ${JSON.stringify(args)}) cat "${answerDir}/a${index}" ;;`;
  });
  const script = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GIT_LOG"
case "$*" in
${arms.join("\n")}
  *) exit 1 ;;
esac
`;
  writeFileSync(join(dir, "bin", "git"), script);
  chmodSync(join(dir, "bin", "git"), 0o755);
};

const npxStub = (dir: string) => {
  writeFileSync(join(dir, "bin", "npx"), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_NPX_LOG"
[ -n "\${FAKE_NPX_TOUCH:-}" ] && touch "$FAKE_NPX_TOUCH"
printf '%s' "\${FAKE_NPX_OUT:-}"
exit "\${FAKE_NPX_STATUS:-0}"
`);
  chmodSync(join(dir, "bin", "npx"), 0o755);
};

const fixture = (opts: {
  script: "test-full.sh" | "test-changed.mjs";
  git?: GitAnswers;
  npxOut?: string;
  npxStatus?: number;
  npxTouch?: string;
  files?: Record<string, string>;
}) => {
  const dir = mkdtempSync(join(tmpdir(), "lp-runner-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  cpSync(join(process.cwd(), "scripts", opts.script), join(dir, "scripts", opts.script));
  for (const [path, content] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  gitStub(dir, opts.git ?? {});
  npxStub(dir);
  const env = {
    ...process.env,
    PATH: `${join(dir, "bin")}:${process.env.PATH}`,
    FAKE_GIT_LOG: join(dir, "git.log"),
    FAKE_NPX_LOG: join(dir, "npx.log"),
    FAKE_NPX_OUT: opts.npxOut ?? "",
    ...(opts.npxStatus !== undefined ? { FAKE_NPX_STATUS: String(opts.npxStatus) } : {}),
    ...(opts.npxTouch ? { FAKE_NPX_TOUCH: opts.npxTouch } : {}),
    LP_TEST_RECEIPTS: join(dir, "receipts"),
  };
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return {
    dir,
    env,
    npxCalls: () => read("npx.log").split("\n").filter(Boolean),
    gitCalls: () => read("git.log").split("\n").filter(Boolean),
    runShell: (args: string[]) => spawnSync("bash", args, { cwd: dir, env, encoding: "utf8" }),
    runNode: (args: string[]) => spawnSync("node", args, { cwd: dir, env, encoding: "utf8" }),
  };
};

const TREE = "treehash0001";
const receiptFile = (dir: string) => join(dir, "receipts", `${TREE}-${nodeVersion()}`);
const cleanGit = (over: GitAnswers = {}): GitAnswers => ({
  "rev-parse HEAD": "headhash0001",
  "rev-parse HEAD^{tree}": TREE,
  "status --porcelain --untracked-files=no": "",
  "ls-files --others --exclude-standard --directory": "",
  ...over,
});
const VITEST_OK = "      Tests  42 passed (42)\n";

describe("test-full.sh receipt", () => {
  it("reuses a green receipt on a clean full run and runs nothing", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit(), npxOut: VITEST_OK });
    mkdirSync(join(f.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(f.dir), "2026-01-01T00:00:00+0000 Tests  1 passed (1)\n");
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("already passed");
    expect(f.npxCalls()).toEqual([]);
  });

  it("explicit args always execute: no receipt reuse, no receipt issuance", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit(), npxOut: VITEST_OK });
    mkdirSync(join(f.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(f.dir), "sentinel\n");
    const res = f.runShell(["scripts/test-full.sh", "tests/foo.test.ts"]);
    expect(res.status).toBe(0);
    expect(f.npxCalls()).toEqual(["vitest run tests/foo.test.ts"]);
    expect(readFileSync(receiptFile(f.dir), "utf8")).toBe("sentinel\n");
  });

  it("a green full run on a clean tree writes the state-bound receipt", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit(), npxOut: VITEST_OK });
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("receipt written");
    expect(readFileSync(receiptFile(f.dir), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T.* Tests {2}\d+ passed/);
  });

  it("suite-affecting untracked files block reuse and issuance; evidence does not", () => {
    const dirty = fixture({
      script: "test-full.sh",
      git: cleanGit({ "ls-files --others --exclude-standard --directory": "tests/new.test.ts\n" }),
      npxOut: VITEST_OK,
    });
    mkdirSync(join(dirty.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(dirty.dir), "sentinel\n");
    expect(dirty.runShell(["scripts/test-full.sh"]).status).toBe(0);
    expect(dirty.npxCalls()).toEqual(["vitest run"]); // ran instead of reusing
    expect(readFileSync(receiptFile(dirty.dir), "utf8")).toBe("sentinel\n"); // and did not rewrite it

    const fresh = fixture({
      script: "test-full.sh",
      git: cleanGit({ "ls-files --others --exclude-standard --directory": "tests/new.test.ts\n" }),
      npxOut: VITEST_OK,
    });
    expect(fresh.runShell(["scripts/test-full.sh"]).status).toBe(0);
    expect(existsSync(receiptFile(fresh.dir))).toBe(false); // green, but no receipt for an uncommitted suite input

    const evidence = fixture({
      script: "test-full.sh",
      git: cleanGit({ "ls-files --others --exclude-standard --directory": ".agents/\ndocs/\n" }),
      npxOut: VITEST_OK,
    });
    mkdirSync(join(evidence.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(evidence.dir), "sentinel\n");
    const res = evidence.runShell(["scripts/test-full.sh"]);
    expect(res.stdout).toContain("already passed");
    expect(evidence.npxCalls()).toEqual([]);
  });

  it("tracked edits count as dirty", () => {
    const f = fixture({
      script: "test-full.sh",
      git: cleanGit({ "status --porcelain --untracked-files=no": " M src/widget.ts\n" }),
      npxOut: VITEST_OK,
    });
    mkdirSync(join(f.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(f.dir), "sentinel\n");
    expect(f.runShell(["scripts/test-full.sh"]).status).toBe(0);
    expect(f.npxCalls()).toEqual(["vitest run"]);
  });

  it("HEAD moving during the run voids the receipt", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "lp-move-")), "moved");
    const f = fixture({
      script: "test-full.sh",
      git: cleanGit({
        "rev-parse HEAD": `@if [ -f "${marker}" ]; then echo headhash0002; else echo headhash0001; fi`,
      }),
      npxOut: VITEST_OK,
      npxTouch: marker,
    });
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("no receipt written");
    expect(existsSync(receiptFile(f.dir))).toBe(false);
  });

  it("a failing suite writes no receipt", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit(), npxStatus: 1 });
    expect(f.runShell(["scripts/test-full.sh"]).status).toBe(1);
    expect(existsSync(receiptFile(f.dir))).toBe(false);
  });

  it("an untracked dir entry may hide suite files and counts as dirty", () => {
    const f = fixture({
      script: "test-full.sh",
      git: cleanGit({ "ls-files --others --exclude-standard --directory": "fixtures/\n" }),
      npxOut: VITEST_OK,
    });
    mkdirSync(join(f.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(f.dir), "sentinel\n");
    expect(f.runShell(["scripts/test-full.sh"]).status).toBe(0);
    expect(f.npxCalls()).toEqual(["vitest run"]);
    expect(readFileSync(receiptFile(f.dir), "utf8")).toBe("sentinel\n");
  });

  it("a run that started dirty writes no receipt, even when the edits are reverted before it ends", () => {
    // Release audit 2026-11-15: start dirty against HEAD, the suite sees the edits, they go away during the run — the end
    // state matches HEAD, but the green was not for HEAD.
    const marker = join(mkdtempSync(join(tmpdir(), "lp-revert-")), "reverted");
    const f = fixture({
      script: "test-full.sh",
      git: cleanGit({
        "status --porcelain --untracked-files=no": `@if [ -f "${marker}" ]; then :; else echo " M src/widget.ts"; fi`,
      }),
      npxOut: VITEST_OK,
      npxTouch: marker,
    });
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("started on a dirty tree");
    expect(f.npxCalls()).toEqual(["vitest run"]);
    expect(existsSync(receiptFile(f.dir))).toBe(false);
  });

  it("a git status that cannot be read is never «clean»: a full run stops before running and writes nothing", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit({ "status --porcelain --untracked-files=no": "@exit 128" }), npxOut: VITEST_OK });
    mkdirSync(join(f.dir, "receipts"), { recursive: true });
    writeFileSync(receiptFile(f.dir), "sentinel\n");
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot read git status");
    expect(f.npxCalls()).toEqual([]);
    expect(readFileSync(receiptFile(f.dir), "utf8")).toBe("sentinel\n");
  });

  it("an untracked list that cannot be read after the run voids the receipt and fails", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "lp-lsfail-")), "ran");
    const f = fixture({
      script: "test-full.sh",
      git: cleanGit({ "ls-files --others --exclude-standard --directory": `@if [ -f "${marker}" ]; then exit 128; fi` }),
      npxOut: VITEST_OK,
      npxTouch: marker,
    });
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("after the run");
    expect(existsSync(receiptFile(f.dir))).toBe(false);
  });

  it("a receipt write failure fails the run instead of claiming success", () => {
    const f = fixture({ script: "test-full.sh", git: cleanGit(), npxOut: VITEST_OK });
    writeFileSync(join(f.dir, "receipts"), "not a dir\n"); // mkdir -p cannot create over a file
    const res = f.runShell(["scripts/test-full.sh"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("cannot create");
  });
});

const widgetRepo = {
  "src/widget.ts": "export function widget() { return 1 }\n",
  "tests/alpha.test.ts": 'import { widget } from "../src/widget";\nconsole.log(widget());\n',
  "tests/beta.test.ts": "console.log('unrelated');\n",
};
const dirtyGit = (over: GitAnswers = {}): GitAnswers => ({
  "status --porcelain": " M src/widget.ts\n",
  "diff --name-only HEAD": "src/widget.ts\n",
  "ls-files --others --exclude-standard": "",
  "rev-parse --short HEAD": "headsha",
  ...over,
});

describe("test-changed.mjs", () => {
  it("--list prints the selection and never calls vitest", () => {
    const f = fixture({ script: "test-changed.mjs", git: dirtyGit(), files: widgetRepo });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/alpha.test.ts");
    expect(res.stdout).not.toContain("tests/beta.test.ts");
    expect(f.npxCalls()).toEqual([]);
  });

  it("--graph runs vitest run --changed; --graph --list runs vitest list, never run", () => {
    const run = fixture({ script: "test-changed.mjs", git: dirtyGit(), files: widgetRepo });
    expect(run.runNode(["scripts/test-changed.mjs", "--graph"]).status).toBe(0);
    expect(run.npxCalls()).toEqual(["vitest run --changed HEAD --passWithNoTests"]);

    const list = fixture({ script: "test-changed.mjs", git: dirtyGit(), files: widgetRepo });
    expect(list.runNode(["scripts/test-changed.mjs", "--graph", "--list"]).status).toBe(0);
    expect(list.npxCalls()).toEqual(["vitest list --changed HEAD --passWithNoTests"]);
  });

  it("a clean tree on main diffs against the last commit, not HEAD itself", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: {
        "status --porcelain": "",
        "rev-parse HEAD": "headhash0002",
        "merge-base HEAD main": "headhash0002", // on main: merge-base is HEAD itself
        "rev-parse --verify --quiet HEAD~1": "prevhash0001",
        "rev-parse --short HEAD~1": "prevhash",
        "diff --name-only HEAD~1": "src/widget.ts\n",
        "ls-files --others --exclude-standard": "",
      },
      files: widgetRepo,
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("since prevhash");
    expect(res.stdout).toContain("tests/alpha.test.ts");
    expect(f.gitCalls()).toContain("diff --name-only HEAD~1");
    expect(f.gitCalls()).not.toContain("diff --name-only HEAD");
  });

  it("an explicit base is used as given and skips the default lookup", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: {
        "rev-parse --short mybase": "mybase",
        "diff --name-only mybase": "src/widget.ts\n",
        "ls-files --others --exclude-standard": "",
      },
      files: widgetRepo,
    });
    const res = f.runNode(["scripts/test-changed.mjs", "mybase", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/alpha.test.ts");
    expect(f.gitCalls().some((call) => call.includes("merge-base") || call === "status --porcelain")).toBe(false);
    expect(f.gitCalls()).toContain("diff --name-only mybase");
  });

  it("a deleted source still selects the tests that import it", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "src/widget.ts\n" }),
      files: { "tests/alpha.test.ts": widgetRepo["tests/alpha.test.ts"], "tests/beta.test.ts": widgetRepo["tests/beta.test.ts"] }, // src/widget.ts absent: deleted
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/alpha.test.ts");
    expect(res.stdout).not.toContain("tests/beta.test.ts");
    expect(res.stdout).toContain("1 importer");
  });

  it("a workflow JSON selects the suite that names it; a runner script selects its fixture suite", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "workflows/phase.json\nscripts/test-full.sh\n" }),
      files: {
        ...widgetRepo,
        "workflows/phase.json": "{}\n",
        "tests/phase.test.ts": 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync("workflows/phase.json", "utf8"));\n',
        "tests/runner.test.ts": 'const script = "test-full.sh";\nconsole.log(script);\n',
      },
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/phase.test.ts");
    expect(res.stdout).toContain("tests/runner.test.ts");
    expect(res.stdout).not.toContain("tests/beta.test.ts");
    expect(res.stdout).toContain("name workflows/phase.json");
    expect(res.stdout).toContain("name test-full.sh");
  });

  it("an unmapped config or root-level code exits nonzero as needing scope, never 'nothing to run'", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "config.json\nscratch/helper.ts\n" }),
      files: { ...widgetRepo, "scratch/helper.ts": "export const x = 1;\n" },
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("no known owning suite");
    expect(res.stderr).toContain("config.json");
    expect(res.stderr).toContain("scratch/helper.ts");
    expect(res.stdout).not.toContain("nothing to run");
    expect(f.npxCalls()).toEqual([]);
  });

  it("docs and media alone still run nothing; a mapped change beside an unmapped one warns and exits nonzero", () => {
    const docs = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "docs/x.md\nassets/logo.png\n" }),
      files: widgetRepo,
    });
    const res = docs.runNode(["scripts/test-changed.mjs", "--graph"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing to run");
    expect(docs.npxCalls()).toEqual([]);

    const mixed = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "src/widget.ts\nconfig.json\n" }),
      files: { ...widgetRepo, "config.json": "{}\n" },
    });
    const mixedRes = mixed.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(mixedRes.status).toBe(2);
    expect(mixedRes.stdout).toContain("tests/alpha.test.ts");
    expect(mixedRes.stderr).toContain("config.json");
  });

  it("a deleted test file selects nothing and does not fail the run", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "tests/old.test.ts\n" }),
      files: widgetRepo, // tests/old.test.ts absent: deleted
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("nothing to run");
    expect(f.npxCalls()).toEqual([]);
  });

  it("--graph on a literal-only change runs the named suite, not vitest --changed", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({ "diff --name-only HEAD": "scripts/test-full.sh\n" }),
      files: {
        ...widgetRepo,
        "tests/runner.test.ts": 'const script = "test-full.sh";\nconsole.log(script);\n',
      },
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--graph"]);
    expect(res.status).toBe(0);
    expect(f.npxCalls()).toEqual(["vitest run tests/runner.test.ts"]);
  });

  it("a required git read that fails stops nonzero, never «nothing to run»; an optional base probe may fail softly", () => {
    // Release audit 2026-11-15 (TP02): a failed diff used to read as an empty change set and exit 0.
    for (const failing of ["diff --name-only HEAD", "ls-files --others --exclude-standard", "status --porcelain", "rev-parse --short HEAD"]) {
      const f = fixture({ script: "test-changed.mjs", git: dirtyGit({ [failing]: "@exit 128" }), files: widgetRepo });
      const res = f.runNode(["scripts/test-changed.mjs"]);
      expect(res.status, failing).toBe(1);
      expect(res.stderr, failing).toContain(`git ${failing} failed`);
      expect(res.stdout, failing).not.toContain("nothing to run");
      expect(f.npxCalls(), failing).toEqual([]);
    }
    // The default-base candidates are probes: main and origin/main both missing still falls back to the last commit.
    const probes = fixture({
      script: "test-changed.mjs",
      git: {
        "status --porcelain": "",
        "rev-parse HEAD": "headhash0002",
        "merge-base HEAD main": "@exit 1",
        "merge-base HEAD origin/main": "@exit 1",
        "rev-parse --verify --quiet HEAD~1": "prevhash0001",
        "rev-parse --short HEAD~1": "prevhash",
        "diff --name-only HEAD~1": "src/widget.ts\n",
        "ls-files --others --exclude-standard": "",
      },
      files: widgetRepo,
    });
    const res = probes.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/alpha.test.ts");
  });

  it("an untracked test file selects itself", () => {
    const f = fixture({
      script: "test-changed.mjs",
      git: dirtyGit({
        "diff --name-only HEAD": "",
        "ls-files --others --exclude-standard": "tests/new.test.ts\n",
      }),
      files: { ...widgetRepo, "tests/new.test.ts": "console.log('new');\n" },
    });
    const res = f.runNode(["scripts/test-changed.mjs", "--list"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("tests/new.test.ts");
    expect(f.npxCalls()).toEqual([]);
  });
});
