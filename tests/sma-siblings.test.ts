import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siblingBlock } from "../src/rooms/sma-map/contract-index";
import { flip } from "../src/rooms/sma-map/evidence/types";
import { contentHash, lintMutation, mutationState, specHash, type Attestation } from "../src/rooms/sma-map/mutation";
import { readJunitReport, testCommands } from "../src/rooms/sma-map/mutation-run";
import { changePoints, siblingAnchorSpan, traceAfter, type ProvenanceFile } from "../src/rooms/sma-map/provenance";
import { siblingAnchor } from "../src/rooms/sma-map/sibling-gaps";
import { frozenChanges, onlyKeysChanged, snapshotOf } from "../src/rooms/sma-map/sibling-git";
import { refuseMutation, resolveSibling } from "../src/rooms/sma-map/siblings";
import { tallyStates, type NodeState } from "../src/rooms/sma-map/states";

// Sibling repositories as a first-class notion of the SMA proof (src/rooms/sma-map/siblings.ts and its users): where a sibling
// resolves, where the runner may write (only the selected checkout), the identity it holds a checkout
// to, how a sibling attestation is judged, what the contract index does at a pin, how a sibling change point holds a trace
// back, how a JUnit report is read, and what --gaps says. The runner itself on fixture siblings: tests/sma-siblings-runner.test.ts.
let tmp = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=fx@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function withEnv<T>(key: string, value: string, fn: () => T): T {
  const before = process.env[key];
  process.env[key] = value;
  try { return fn(); } finally { if (before === undefined) delete process.env[key]; else process.env[key] = before; }
}
/** A repository with `files`, committed on `branch`. */
function repo(at: string, branch: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) write(join(at, path), text);
  git(at, "init", "-q", "-b", branch);
  git(at, "add", ".");
  git(at, "commit", "-q", "-m", "one");
  return at;
}
let shared = "", home = "", primary = "";
const SUBJECT = "export const limit = (n: number) => n >= 7;\n";
const TEST = "it(\"[sma:fx_one] seven is enough\", () => {});\n";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "sma-siblings-unit-"));
  home = join(tmp, "home");
  // Another clone of the core somewhere: read through an override, never written.
  shared = repo(join(tmp, "shared", "bb-core"), "main", { "src/subject.ts": SUBJECT, "src/subject.test.ts": TEST });
  // The core's default checkout: the fake home's ~/BB-service/bb-core/vk, on vk/experimental.
  primary = repo(join(home, "BB-service", "bb-core", "vk"), "vk/experimental", { "src/subject.ts": SUBJECT, "src/subject.test.ts": TEST });
});
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("where a sibling resolves", () => {
  it("an override wins, `off` and a missing path make it absent (never a fall-through), else its default checkout; an old proofs worktree is not looked for", () => {
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: shared }, home)).toEqual({ root: shared, from: "env" });
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: "off" }, home)).toMatchObject({ root: null, why: expect.stringContaining("sibling repository bb-core is not on this machine") });
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: join(tmp, "nowhere") }, home)).toMatchObject({ root: null, why: expect.stringContaining("does not exist") });
    expect(resolveSibling("telegram", tmp, {}, home)).toMatchObject({ root: null, why: "sibling repository bb-plugin-telegram-projects is not on this machine" });
    repo(join(tmp, "wt", "bb-core", "sma-proofs"), "sma/core-proofs", { "x.ts": "x\n" });
    expect(resolveSibling("core", tmp, { LANE_PILOT_WORKTREE_ROOT: join(tmp, "wt") }, home)).toEqual({ root: join(home, "BB-service", "bb-core", "vk"), from: "default" });
  });
});

describe("where the runner may write: only the selected checkout", () => {
  it("the selected core checkout may be on any branch or detached; another root, `..`, an absolute path and a symbolic link out are refused", () => {
    expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toBeNull();
    expect(refuseMutation("core", shared, "src/subject.ts", tmp, home)).toMatch(/not the selected checkout of bb-core/);
    expect(refuseMutation("core", primary, "../../shared/bb-core/src/subject.ts", tmp, home)).toMatch(/inside the checkout/);
    expect(refuseMutation("core", primary, join(shared, "src/subject.ts"), tmp, home)).toMatch(/inside the checkout/);
    symlinkSync(join(shared, "src/subject.ts"), join(primary, "src/linked.ts"));
    try { expect(refuseMutation("core", primary, "src/linked.ts", tmp, home)).toMatch(/symbolic link/); }
    finally { rmSync(join(primary, "src/linked.ts")); }
    git(primary, "checkout", "-q", "-b", "elsewhere");
    try { expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toBeNull(); }
    finally { git(primary, "checkout", "-q", "vk/experimental"); }
    git(primary, "checkout", "-q", "--detach");
    try { expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toBeNull(); }
    finally { git(primary, "checkout", "-q", "vk/experimental"); }
    const clone = join(tmp, "clone");
    execFileSync("git", ["clone", "-q", primary, clone], { stdio: "pipe" });
    withEnv("SMA_SIBLING_CORE", clone, () => {
      expect(refuseMutation("core", clone, "src/subject.ts", tmp, home)).toBeNull();
      expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toMatch(/not the selected checkout of bb-core/);
    });
    // Through a symbolic link to the selected checkout it is the same checkout.
    symlinkSync(primary, join(tmp, "primary-link"));
    expect(refuseMutation("core", join(tmp, "primary-link"), "src/subject.ts", tmp, home)).toBeNull();
    expect(refuseMutation("core", primary, "src/subject.ts", tmp, join(tmp, "no-home"))).toMatch(/not the selected checkout/);
  });

  it("accepts a real linked worktree when explicitly selected and refuses an invalid git directory", () => {
    const linked = join(tmp, "linked");
    git(primary, "worktree", "add", "-q", "-b", "linked", linked, "HEAD");
    try {
      expect(refuseMutation("core", linked, "src/subject.ts", tmp, home)).toMatch(/not the selected checkout/);
      withEnv("SMA_SIBLING_CORE", linked, () => expect(refuseMutation("core", linked, "src/subject.ts", tmp, home)).toBeNull());
    } finally { git(primary, "worktree", "remove", "-f", linked); }
    const other = join(tmp, "home2");
    write(join(other, "BB-service", "bb-core", "vk", ".git"), `gitdir: ${join(shared, ".git", "worktrees", "vk")}\n`);
    write(join(other, "BB-service", "bb-core", "vk", "src", "subject.ts"), SUBJECT);
    expect(refuseMutation("core", join(other, "BB-service", "bb-core", "vk"), "src/subject.ts", tmp, other)).toMatch(/valid git worktree/);
    const plugin = repo(join(tmp, "plugin"), "main", { "src/a.ts": "a\n" });
    expect(refuseMutation(null, plugin, "src/a.ts", plugin, home)).toBeNull();
    git(plugin, "checkout", "-q", "-b", "feature");
    expect(refuseMutation(null, plugin, "src/a.ts", plugin, home)).toBeNull();
    expect(refuseMutation(null, plugin, "src/a.ts", tmp, home)).toMatch(/not the selected checkout of this plugin/);
    git(plugin, "checkout", "-q", "main");
    const pluginLinked = join(tmp, "plugin-linked");
    write(join(pluginLinked, ".git"), `gitdir: ${join(plugin, ".git", "worktrees", "plugin-linked")}\n`);
    write(join(pluginLinked, "src", "a.ts"), "a\n");
    expect(refuseMutation(null, pluginLinked, "src/a.ts", pluginLinked, home)).toMatch(/valid git worktree/);
  });

  it("requires the selected root to be a real non-bare worktree and ignores ambient Git directory overrides", () => {
    const nested = join(primary, "src");
    expect(refuseMutation("core", nested, "subject.ts", tmp, home)).toMatch(/not the selected checkout/);
    withEnv("SMA_SIBLING_CORE", nested, () => expect(refuseMutation("core", nested, "subject.ts", tmp, home)).toMatch(/valid git worktree/));
    const bare = join(tmp, "bare.git");
    execFileSync("git", ["init", "-q", "--bare", bare], { stdio: "pipe" });
    withEnv("SMA_SIBLING_CORE", bare, () => expect(refuseMutation("core", bare, "subject.ts", tmp, home)).toMatch(/valid git worktree/));
    withEnv("GIT_DIR", join(primary, ".git"), () => expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toBeNull());
    withEnv("GIT_CONFIG_COUNT", "1", () => expect(refuseMutation("core", primary, "src/subject.ts", tmp, home)).toBeNull());
  });
});

describe("the identity a checkout is held to during a mutation", () => {
  it("HEAD, the tree and every changed or untracked file count; only the permitted outputs may change, and an unreadable checkout is no snapshot", () => {
    const at = repo(join(tmp, "frozen"), "main", { "src/a.ts": "a\n", "attest/r01.json": "{\"n1\": 1, \"n2\": 2}\n", ".agents/PROGRESS.md": "p\n" });
    const keep = (path: string) => path.startsWith("attest/");
    const start = snapshotOf(at, keep)!;
    expect(frozenChanges(start, snapshotOf(at, keep)!)).toEqual([]);
    const attestOnly = (keys: string[]) => (path: string, before: string | null, after: string | null) => path.startsWith("attest/") && onlyKeysChanged(before, after, new Set(keys));
    writeFileSync(join(at, "attest/r01.json"), "{\"n1\": 9, \"n2\": 2}\n");
    expect(frozenChanges(start, snapshotOf(at, keep)!, attestOnly(["n1"]))).toEqual([]);
    expect(frozenChanges(start, snapshotOf(at, keep)!, attestOnly(["n2"]))).toEqual(["attest/r01.json"]);
    expect(frozenChanges(start, snapshotOf(at, keep)!)).toEqual(["attest/r01.json"]);
    writeFileSync(join(at, "attest/r01.json"), "not json\n");
    expect(frozenChanges(start, snapshotOf(at, keep)!, attestOnly(["n1", "n2"]))).toEqual(["attest/r01.json"]);
    writeFileSync(join(at, "attest/r01.json"), "{\"n1\": 1, \"n2\": 2}\n");
    writeFileSync(join(at, ".agents/PROGRESS.md"), "edited\n");
    write(join(at, "src/new.ts"), "new\n");
    expect(frozenChanges(start, snapshotOf(at, keep)!, attestOnly(["n1", "n2"])).sort()).toEqual([".agents/PROGRESS.md", "src/new.ts"]);
    git(at, "add", ".");
    git(at, "commit", "-q", "-m", "two");
    expect(frozenChanges(start, snapshotOf(at, keep)!)[0]).toMatch(/^HEAD /);
    // A file already dirty at the start that changes again counts too.
    writeFileSync(join(at, "src/a.ts"), "dirty\n");
    const dirty = snapshotOf(at)!;
    writeFileSync(join(at, "src/a.ts"), "dirtier\n");
    expect(frozenChanges(dirty, snapshotOf(at)!)).toEqual(["src/a.ts"]);
    expect(snapshotOf(join(tmp, "nowhere"))).toBeNull();
  });
});

describe("a sibling mutation spec and its attestation", () => {
  const spec = flip("core:src/subject.ts", "n >= 7", "n > 7");
  const attestation = (file: string, test: string): Attestation => ({ spec: specHash(spec), kind: spec.kind, file, tests: { "core:src/subject.test.ts": test }, commit: "abc", result: "killed", at: "", sibling: "core", siblingCommit: "def" });

  it("lints statically without the sibling, finds once with it, and refuses a sibling test file", () => {
    expect(lintMutation(spec, "/plugin")).toEqual([]);
    expect(lintMutation(spec, "/plugin", { core: shared })).toEqual([]);
    expect(lintMutation(flip("core:src/subject.ts", "nothing here", "x"), "/plugin", { core: shared })[0]).toMatch(/occurs 0 times/);
    expect(lintMutation(flip("core:src/subject.test.ts", "a", "b"), "/plugin")[0]).toMatch(/not a test/);
    expect(lintMutation(flip("telegram:test/x.ts", "a", "b"), "/plugin")[0]).toMatch(/not a test/);
  });

  it("is never a pass where the sibling is absent in a source checkout; the hub trusts the committed attestation; present, it is re-judged and goes stale", () => {
    const good = attestation(contentHash(SUBJECT), contentHash(TEST));
    const absent = mutationState(spec, good, "/plugin", ["core:src/subject.test.ts"], {});
    expect(absent.mutated).toBe(false);
    expect(absent.why).toContain("sibling repository bb-core is not on this machine");
    expect(mutationState(spec, good, "", ["core:src/subject.test.ts"]).mutated).toBe(true);
    expect(mutationState(spec, good, "/plugin", ["core:src/subject.test.ts"], { core: shared })).toMatchObject({ mutated: true, stale: false });
    expect(mutationState(spec, attestation(contentHash(SUBJECT), "old"), "/plugin", ["core:src/subject.test.ts"], { core: shared })).toMatchObject({ mutated: true, stale: true });
  });
});

describe("the contract index reads a sibling at a pin", () => {
  const options = (check: boolean, at: Record<string, string>, tests: Record<string, string[]> = {}, override = shared) => ({ root: tmp, check, current: { tests, at }, env: { SMA_SIBLING_CORE: override } });

  it("absent: keeps the recorded lines and says why; check: re-reads at the pin; generate: the pin moves only forward", () => {
    const recorded = { fx_one: ["core:src/subject.test.ts › seven is enough"] };
    const first = git(shared, "rev-parse", "HEAD").slice(0, 12);
    const absent = siblingBlock("core", options(true, { core: first }, recorded, "off"));
    expect([...absent.tests]).toEqual([["fx_one", recorded.fx_one]]);
    expect(absent.note).toContain("is not on this machine");
    expect([...siblingBlock("core", options(true, { core: first })).tests]).toEqual([["fx_one", recorded.fx_one]]);
    // A historical proof branch in the same repository: generating there moves the pin forward to its HEAD.
    git(shared, "checkout", "-q", "-b", "sma/core-proofs-fx");
    write(join(shared, "src/second.test.ts"), "it(\"[sma:fx_two] a second card\", () => {});\n");
    git(shared, "add", "src/second.test.ts");
    git(shared, "commit", "-q", "-m", "two");
    const forward = siblingBlock("core", options(false, { core: first }));
    expect(forward.pin).toBe(git(shared, "rev-parse", "HEAD").slice(0, 12));
    expect([...forward.tests.keys()].sort()).toEqual(["fx_one", "fx_two"]);
    // Back on main, HEAD does not contain the pin on the proof branch: the pin and its tests stay.
    git(shared, "checkout", "-q", "main");
    const kept = siblingBlock("core", options(false, { core: forward.pin! }));
    expect(kept.pin).toBe(forward.pin);
    expect(kept.note).toMatch(/does not contain the pinned/);
    expect([...kept.tests.keys()].sort()).toEqual(["fx_one", "fx_two"]);
  });
});

describe("a sibling change point", () => {
  it("holds back a trace older than the sibling commit, lets a newer one count, and the tally lists such a closed node separately", () => {
    const file: ProvenanceFile = { generatedFrom: "", version: "", deploys: 0, nodes: {}, siblings: { n1: ["core", "abc", 1_000, "symbol", "h"] } };
    const point = changePoints(["n1"], [], () => "core:x.ts#f", "", file).get("n1")!;
    expect(point).toMatchObject({ state: "sibling", sibling: "core", committedAt: 1_000 });
    expect(traceAfter(point, 999)).toBe(false);
    expect(traceAfter(point, 1_000)).toBe(true);
    const closed = { exception: null, missing: [], changePoint: point, sibling: "core", status: "have", checked: true, mutated: true, reachable: true, undeclared: [], blockedIn: [] } as unknown as NodeState;
    const open = { ...closed, missing: ["trace"] } as unknown as NodeState;
    expect(tallyStates([closed, open], true)).toMatchObject({ sibling: 2, closedSiblingUnknown: 1, closed: 1 });
  });

  it("names the anchor's span: a declared unit, the block a text anchor opens, the whole file", () => {
    const text = "const a = 1;\nexport const settings = {\n  pairing: async () => {\n    return 1;\n  },\n};\n";
    expect(siblingAnchorSpan(text, "pairing: async () => {")).toMatchObject({ level: "text", start: 3, end: 5 });
    expect(siblingAnchorSpan(text, "settings")).toMatchObject({ level: "symbol", start: 2 });
    expect(siblingAnchorSpan(text, "absent words")).toMatchObject({ level: "file", start: 1 });
  });
});

describe("the sibling runners", () => {
  it("reads node:test's JUnit report: an assertion kills, a TypeError and a file that failed to load crash, a skipped test is not counted", () => {
    const xml = `<testsuites>
<testcase name="[sma:x] asserts" file="/r/test/a.test.ts"><failure type="testCodeFailure" message="m">cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal</failure></testcase>
<testcase name="[sma:x] crashes" file="/r/test/a.test.ts"><failure type="testCodeFailure" message="m">cause: TypeError: Cannot read properties of undefined (reading 'f')</failure></testcase>
<testcase name="[sma:x] passes" file="/r/test/a.test.ts"/>
<testcase name="left out" file="/r/test/a.test.ts"><skipped type="skipped"/></testcase>
<testcase name="test/b.test.ts" file="/r/test/b.test.ts"><failure type="testCodeFailure" message="test failed">[Error: test failed]</failure></testcase>
</testsuites>`;
    const run = readJunitReport(xml, (file) => file.replace("/r/", ""));
    expect(run).toMatchObject({ ran: 3, passed: 1 });
    expect(run.assertion).toEqual(["[sma:x] asserts: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal"]);
    expect(run.crash).toEqual(["[sma:x] crashes: TypeError: Cannot read properties of undefined (reading 'f')", "test/b.test.ts: the file failed to load or run"]);
  });

  it("never lets npx fetch a runner for a sibling: a checkout without its dependencies is told to install them", () => {
    const [command] = testCommands("telegram", join(tmp, "nowhere"), ["test/a.test.ts"], "x", join(tmp, "out"));
    expect(command!.missing).toMatch(/npm install/);
  });
});

describe("--gaps for a sibling node", () => {
  it("says where its code and tests are, the next step, and that the sibling is absent when it is", () => {
    const absent = siblingAnchor("telegram:chat.ts#splitText(o.text)", "m_tg_split", {});
    expect(absent).toMatchObject({ repo: "bb-plugin-telegram-projects", file: "telegram:chat.ts", root: null, absent: "sibling repository bb-plugin-telegram-projects is not on this machine", hubPlugin: "telegram-projects" });
    expect(absent!.next).toContain("commit it on main in the selected checkout");
    expect(absent!.next).not.toMatch(/worktree|setup/);
    expect(siblingAnchor("core:src/subject.ts#limit", "fx_one", { core: shared })).toMatchObject({ root: shared, lines: 1 });
    expect(siblingAnchor("src/rooms/x.ts#y", "a", {})).toBeNull();
  });
});
