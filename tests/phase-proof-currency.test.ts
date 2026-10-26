import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProofs, hostGit, phaseProofRecords, renderProofCurrency, type GitRun } from "../src/rooms/phase/server/proof-currency";
import { createAutoStages } from "../src/rooms/phase/server/auto-stages";
import type { Phase } from "../src/rooms/phase/logic";

// The server never runs git itself (the project lives on its host); a test runs it here, the way hostGit does there.
/** Git in a local folder: execFile with an argument array, no shell, and no inherited repository overrides. */
function localGit(cwd: string): GitRun {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
  return (args) => new Promise((resolve, reject) => {
    execFile("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: 0, stdout, stderr });
      const code = (error as { code?: unknown }).code;
      if (typeof code === "number") return resolve({ status: code, stdout, stderr });
      reject(new Error(`Cannot run git: ${error.message}`));
    });
  });
}

let repo = "";
let sandbox = "";
const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
const put = (path: string, text: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };

// c1: src/a.ts, src-extra/x.ts, docs/n.md; c2 changes src/a.ts; c3 changes docs/n.md only.
let c1 = "", c2 = "", c3 = "", side = "";
beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "lp-proof-currency-"));
  repo = join(sandbox, "repo");
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  put("src/a.ts", "a1"); put("src-extra/x.ts", "x1"); put("docs/n.md", "n1");
  c1 = commit("c1");
  put("src/a.ts", "a2");
  c2 = commit("c2");
  put("docs/n.md", "n2");
  c3 = commit("c3");
  git("checkout", "-q", "-b", "side", c1);
  put("side.txt", "s");
  side = commit("side");
  git("checkout", "-q", "main");
});
afterAll(() => { rmSync(sandbox, { recursive: true, force: true }); });

const verdictOf = async (commitId: string, paths?: string[]) => (await checkProofs([{ id: "p", kind: "t", commit: commitId, ...(paths ? { paths } : {}) }], localGit(repo)))[0]!;

describe("proof currency: the verdict of a recorded proof commit against HEAD", () => {
  it("current: the commit is HEAD and the covered paths are clean", async () => {
    expect((await verdictOf(c3, ["src"])).verdict).toBe("current");
  });
  it("still about these paths: an ancestor, and the covered paths did not move", async () => {
    const result = await verdictOf(c2, ["src", "src-extra"]);
    expect(result.verdict).toBe("still about these paths");
    expect(result.resolvedCommit).toBe(c2);
  });
  it("stale lists every changed covered path, and respects the path-segment boundary", async () => {
    const stale = await verdictOf(c1, ["src", "docs/n.md", "src-extra/x.ts"]);
    expect(stale.verdict).toBe("stale");
    expect(stale.changedPaths).toEqual(["docs/n.md", "src/a.ts"]);
    expect((await verdictOf(c1, ["src-extra"])).verdict).toBe("still about these paths");
    expect((await verdictOf(c1, ["sr"])).verdict).toBe("still about these paths");
  });
  it("no paths, an empty list or «.» cover every path", async () => {
    for (const paths of [undefined, [], ["."]]) expect((await verdictOf(c1, paths)).changedPaths).toEqual(["docs/n.md", "src/a.ts"]);
  });
  it("accepts an unambiguous short hash and calls a non-hash, a missing hash and a too short one unknown, comparing nothing", async () => {
    expect((await verdictOf(c2.slice(0, 7), ["src"])).resolvedCommit).toBe(c2);
    for (const bad of ["HEAD~1", "main", "zzzzzz", "abc", "0123456789abcdef0123456789abcdef01234567"]) {
      const result = await verdictOf(bad, ["src"]);
      expect(result.verdict, bad).toBe("unknown commit");
      expect(result.reason).toMatch(/^Unknown or ambiguous commit/);
      expect(result.changedPaths).toEqual([]);
      expect(result.resolvedCommit).toBeNull();
    }
  });
  it("calls a hash of an object that is not a commit unknown", async () => {
    const blob = git("rev-parse", "HEAD:src/a.ts");
    expect((await verdictOf(blob.slice(0, 8), ["src"])).verdict).toBe("unknown commit");
  });
  it("not on this history: a known commit on another branch", async () => {
    const result = await verdictOf(side, ["src"]);
    expect(result.verdict).toBe("not on this history");
    expect(result.changedPaths).toEqual([]);
    expect(result.resolvedCommit).toBe(side);
  });
  it("uncommitted work in a covered path makes the proof stale: modified, staged and untracked", async () => {
    put("src/a.ts", "a3");
    put("src/new.ts", "n");
    put("docs/other.md", "o");
    git("add", "docs/other.md");
    try {
      const covered = await verdictOf(c3, ["src"]);
      expect(covered.verdict).toBe("stale");
      expect(covered.changedPaths).toEqual(["src/a.ts", "src/new.ts"]);
      expect((await verdictOf(c3, ["docs"])).changedPaths).toEqual(["docs/other.md"]);
      expect((await verdictOf(c3, ["src-extra"])).verdict).toBe("current");
    } finally {
      git("reset", "-q", "--hard", c3);
      git("clean", "-fdq");
    }
  });
  it("refuses a covered path that is absolute or leaves the repository", async () => {
    for (const bad of ["/etc", "../x", "a/../../x", ""]) await expect(verdictOf(c1, [bad])).rejects.toThrow(/Invalid covered path/);
  });
  it("accepts «\\» and «./» spellings, and spaces in a file name", async () => {
    put("my dir/f g.ts", "1");
    const withSpace = commit("spaces");
    put("my dir/f g.ts", "2");
    commit("spaces 2");
    expect((await verdictOf(withSpace, ["./my dir\\"])).changedPaths).toEqual(["my dir/f g.ts"]);
  });
  it("throws when the checkout has no HEAD commit", async () => {
    const empty = join(sandbox, "empty");
    mkdirSync(empty);
    execFileSync("git", ["-C", empty, "init", "-q"]);
    await expect(checkProofs([{ id: "p", kind: "t", commit: c1 }], localGit(empty))).rejects.toThrow(/no HEAD commit/);
  });
  it("runs the same questions through a host: every argument is quoted into one command line", async () => {
    const lines: string[] = [];
    const viaHost = hostGit(async (command) => {
      lines.push(command);
      const parts = [...command.matchAll(/'((?:[^']|'\\'')*)'/g)].map((match) => match[1]!.replace(/'\\''/g, "'"));
      expect(parts[0]).toBe("git");
      const run = await localGit(repo)(parts.slice(5));
      return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
    });
    const [result] = await checkProofs([{ id: "p", kind: "t", commit: c1, paths: ["src"] }], viaHost);
    expect(result!.verdict).toBe("stale");
    expect(lines.every((line) => line.startsWith("'git' '-c'"))).toBe(true);
  });
});

describe("the text the goal audit reads", () => {
  it("names each proof, marks stale ones with their paths, and cuts long lists", async () => {
    const results = await checkProofs([
      { id: "store", kind: "accepted task, merge", commit: c1, paths: ["src", "docs"] },
      { id: "cli", kind: "accepted task, merge", commit: c2, paths: ["src"] },
      { id: "x", kind: "run goal check", commit: side, paths: ["src"] },
      { id: "y", kind: "run goal check", commit: "nothex", paths: ["src"] },
    ], localGit(repo));
    const text = renderProofCurrency(results);
    expect(text).toMatch(/not by a model/);
    expect(text).toContain(`accepted task, merge store @ ${c1.slice(0, 12)}: STALE, 2 covered path(s) changed since: docs/n.md, src/a.ts`);
    expect(text).toContain("cli @");
    expect(text).toMatch(/cli @ \w+: still about these paths/);
    expect(text).toMatch(/NOT ON THIS HISTORY/);
    expect(text).toMatch(/UNKNOWN COMMIT/);
    expect(renderProofCurrency(results, { maxPaths: 1 })).toContain("docs/n.md (+1 more)");
    expect(renderProofCurrency(results, { maxChars: 120 }).length).toBeLessThanOrEqual(120);
    expect(renderProofCurrency([])).toBe("");
  });
});

describe("the proofs of a phase's run", () => {
  const rows = [
    { task_id: "store", merge_commit: "aaaa1111", changed_json: JSON.stringify([{ path: "src/store.ts", status: "A" }, { path: "src/store.test.ts", status: "A" }]) },
    { task_id: "nofiles", merge_commit: "bbbb2222", changed_json: "[]" },
    { task_id: "broken", merge_commit: "cccc3333", changed_json: "not json" },
    { task_id: "cli", merge_commit: "dddd4444", changed_json: JSON.stringify([{ path: "src/cli.ts", status: "M" }]) },
  ];
  const db = { prepare: () => ({ all: () => rows }) };
  it("takes accepted merges with their changed files, and the verdicts at their main over those files", () => {
    const records = phaseProofRecords(db, { runId: "run1", record: { verification: { verdict: { mainSha: "eeee5555" } } } }, { headSha: "ffff6666" });
    expect(records.map((record) => [record.kind, record.id, record.commit])).toEqual([
      ["accepted task, merge", "store", "aaaa1111"], ["accepted task, merge", "cli", "dddd4444"], ["blind verification", "of the phase", "eeee5555"], ["run goal check", "of the run", "ffff6666"]]);
    expect(records[2]!.paths).toEqual(["src/store.ts", "src/store.test.ts", "src/cli.ts"]);
  });
  it("has nothing without a run, and no verdict records when the run changed no file", () => {
    expect(phaseProofRecords(db, { runId: null, record: {} }, null)).toEqual([]);
    expect(phaseProofRecords({ prepare: () => ({ all: () => [] }) }, { runId: "run1", record: { verification: { verdict: { mainSha: "eeee5555" } } } }, { headSha: "ffff6666" })).toEqual([]);
  });
});

describe("the goal audit gets the currency facts", () => {
  const phase = { id: "ph_1", projectId: "p", pmThreadId: "thr_pm", runId: "run1", title: "Notes", goal: "g", stage: "verification", state: "active", edition: 1, createdAt: 1, updatedAt: 1,
    record: { verification: { verdict: { state: "passed", detail: "ok", inputSha: "x", at: 1, mainSha: null } } } } as unknown as Phase;
  function start(proofCurrency?: (phase: Phase) => Promise<string | null>) {
    const started: Array<{ workflow: { id: string }; inputs: Record<string, unknown> }> = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: { start: (input: never) => { started.push(input); return { runId: "wf1", created: true, done: new Promise(() => undefined) }; }, get: () => null } as never }, {
      api: {} as never, get: () => phase, save: () => undefined, book: () => undefined, writeDocs: async () => ({ written: [] }), runtime: () => ({}), bookHead: () => "", pmIdle: async () => true, now: () => 1,
      ...(proofCurrency ? { proofCurrency } : {}),
    });
    return { auto, started };
  }
  it("passes proof_currency to lp.close, and only to lp.close", async () => {
    const w = start(async () => "- task store: STALE");
    expect(await w.auto.step(phase)).toBe(true);
    expect(w.started[0]!.workflow.id).toBe("lp.close");
    expect(w.started[0]!.inputs).toMatchObject({ goal: "g", proof_currency: "- task store: STALE" });
  });
  it("starts the audit without the facts when they are none or the lookup fails", async () => {
    for (const lookup of [undefined, async () => null, async () => { throw new Error("host gone"); }]) {
      const w = start(lookup);
      expect(await w.auto.step(phase)).toBe(true);
      expect(w.started[0]!.inputs).not.toHaveProperty("proof_currency");
    }
  });
});
