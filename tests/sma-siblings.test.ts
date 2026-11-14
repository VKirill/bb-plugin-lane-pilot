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
import { refuseMutation, resolveSibling } from "../src/rooms/sma-map/siblings";
import { tallyStates, type NodeState } from "../src/rooms/sma-map/states";

// Sibling repositories as a first-class notion of the SMA proof (src/rooms/sma-map/siblings.ts and its users): where a sibling
// resolves, where the runner may write, how a sibling attestation is judged, what the contract index does at a pin, how a
// sibling change point holds a trace back, how a JUnit report is read, and what --gaps says. The runner itself on fixture
// siblings: tests/sma-siblings-runner.test.ts.
let tmp = "";
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=fx@example.invalid", "-c", "user.name=fixture", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
let shared = "", worktree = "", home = "";
const env = () => ({ LANE_PILOT_WORKTREE_ROOT: join(tmp, "wt") });
const SUBJECT = "export const limit = (n: number) => n >= 7;\n";
const TEST = "it(\"[sma:fx_one] seven is enough\", () => {});\n";

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "sma-siblings-unit-"));
  home = join(tmp, "home");
  shared = join(tmp, "shared", "bb-core");
  write(join(shared, "src/subject.ts"), SUBJECT);
  write(join(shared, "src/subject.test.ts"), TEST);
  git(shared, "init", "-q", "-b", "main");
  git(shared, "add", ".");
  git(shared, "commit", "-q", "-m", "one");
  worktree = join(tmp, "wt", "bb-core", "fx");
  git(shared, "worktree", "add", "-q", "-b", "sma/core-proofs-fx", worktree);
});
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

describe("where a sibling resolves", () => {
  it("an override wins, `off` and a missing path make it absent (never a fall-through), else the proofs worktree", () => {
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: worktree }, home)).toEqual({ root: worktree, from: "env" });
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: "off" }, home)).toMatchObject({ root: null, why: expect.stringContaining("sibling repository bb-core is not on this machine") });
    expect(resolveSibling("core", tmp, { SMA_SIBLING_CORE: join(tmp, "nowhere") }, home)).toMatchObject({ root: null, why: expect.stringContaining("does not exist") });
    expect(resolveSibling("telegram", tmp, env(), home)).toMatchObject({ root: null, why: "sibling repository bb-plugin-telegram-projects is not on this machine" });
    const proofs = join(tmp, "wt", "bb-core", "sma-proofs");
    git(shared, "worktree", "add", "-q", "-b", "sma/core-proofs", proofs);
    try { expect(resolveSibling("core", tmp, env(), home)).toEqual({ root: proofs, from: "proofs-worktree" }); }
    finally { git(shared, "worktree", "remove", "--force", proofs); }
  });
});

describe("where the runner may write", () => {
  it("only a linked worktree under <worktree root>/<repo>/: the main checkout, an outside worktree and an escaping path are refused", () => {
    expect(refuseMutation("core", worktree, "src/subject.ts", tmp, env(), home)).toBeNull();
    expect(refuseMutation("core", shared, "src/subject.ts", tmp, env(), home)).toMatch(/shared checkout/);
    const outside = join(tmp, "elsewhere", "fx2");
    git(shared, "worktree", "add", "-q", "--detach", outside);
    expect(refuseMutation("core", outside, "src/subject.ts", tmp, env(), home)).toMatch(/not a worktree under/);
    expect(refuseMutation("core", worktree, "../../shared/bb-core/src/subject.ts", tmp, env(), home)).toMatch(/inside the sibling checkout/);
    symlinkSync(join(shared, "src/subject.ts"), join(worktree, "src/linked.ts"));
    expect(refuseMutation("core", worktree, "src/linked.ts", tmp, env(), home)).toMatch(/symbolic link/);
    // A default place of the core (here the fake home's ~/BB-service/bb-core/vk) is a shared checkout whatever its git layout.
    const homeCore = join(home, "BB-service", "bb-core", "vk");
    git(shared, "worktree", "add", "-q", "--detach", homeCore);
    expect(refuseMutation("core", homeCore, "src/subject.ts", tmp, env(), home)).toMatch(/shared checkout/);
  });
});

describe("a sibling mutation spec and its attestation", () => {
  const spec = flip("core:src/subject.ts", "n >= 7", "n > 7");
  const attestation = (file: string, test: string): Attestation => ({ spec: specHash(spec), kind: spec.kind, file, tests: { "core:src/subject.test.ts": test }, commit: "abc", result: "killed", at: "", sibling: "core", siblingCommit: "def" });

  it("lints statically without the sibling, finds once with it, and refuses a sibling test file", () => {
    expect(lintMutation(spec, "/plugin")).toEqual([]);
    expect(lintMutation(spec, "/plugin", { core: worktree })).toEqual([]);
    expect(lintMutation(flip("core:src/subject.ts", "nothing here", "x"), "/plugin", { core: worktree })[0]).toMatch(/occurs 0 times/);
    expect(lintMutation(flip("core:src/subject.test.ts", "a", "b"), "/plugin")[0]).toMatch(/not a test/);
    expect(lintMutation(flip("telegram:test/x.ts", "a", "b"), "/plugin")[0]).toMatch(/not a test/);
  });

  it("is never a pass where the sibling is absent in a source checkout; the hub trusts the committed attestation; present, it is re-judged and goes stale", () => {
    const good = attestation(contentHash(SUBJECT), contentHash(TEST));
    const absent = mutationState(spec, good, "/plugin", ["core:src/subject.test.ts"], {});
    expect(absent.mutated).toBe(false);
    expect(absent.why).toContain("sibling repository bb-core is not on this machine");
    expect(mutationState(spec, good, "", ["core:src/subject.test.ts"]).mutated).toBe(true);
    expect(mutationState(spec, good, "/plugin", ["core:src/subject.test.ts"], { core: worktree })).toMatchObject({ mutated: true, stale: false });
    expect(mutationState(spec, attestation(contentHash(SUBJECT), "old"), "/plugin", ["core:src/subject.test.ts"], { core: worktree })).toMatchObject({ mutated: true, stale: true });
  });
});

describe("the contract index reads a sibling at a pin", () => {
  const options = (check: boolean, at: Record<string, string>, tests: Record<string, string[]> = {}, override = worktree) => ({ root: tmp, check, current: { tests, at }, env: { ...env(), SMA_SIBLING_CORE: override } });

  it("absent: keeps the recorded lines and says why; check: re-reads at the pin; generate: the pin moves only forward", () => {
    const recorded = { fx_one: ["core:src/subject.test.ts › seven is enough"] };
    const first = git(worktree, "rev-parse", "HEAD").slice(0, 12);
    const absent = siblingBlock("core", options(true, { core: first }, recorded, "off"));
    expect([...absent.tests]).toEqual([["fx_one", recorded.fx_one]]);
    expect(absent.note).toContain("is not on this machine");
    expect([...siblingBlock("core", options(true, { core: first })).tests]).toEqual([["fx_one", recorded.fx_one]]);
    write(join(worktree, "src/second.test.ts"), "it(\"[sma:fx_two] a second card\", () => {});\n");
    git(worktree, "add", "src/second.test.ts");
    git(worktree, "commit", "-q", "-m", "two");
    const forward = siblingBlock("core", options(false, { core: first }));
    expect(forward.pin).toBe(git(worktree, "rev-parse", "HEAD").slice(0, 12));
    expect([...forward.tests.keys()].sort()).toEqual(["fx_one", "fx_two"]);
    // The shared checkout's HEAD (main) does not contain the pin on the proofs branch: the pin and its tests stay.
    const kept = siblingBlock("core", options(false, { core: forward.pin! }, {}, shared));
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

  it("never lets npx fetch a runner for a sibling: a checkout without its dependencies is told to run setup", () => {
    const [command] = testCommands("telegram", join(tmp, "nowhere"), ["test/a.test.ts"], "x", join(tmp, "out"));
    expect(command!.missing).toMatch(/npm run sma:sibling -- setup telegram/);
  });
});

describe("--gaps for a sibling node", () => {
  it("says where its code and tests are, the next step, and that the sibling is absent when it is", () => {
    const absent = siblingAnchor("telegram:chat.ts#splitText(o.text)", "m_tg_split", {});
    expect(absent).toMatchObject({ repo: "bb-plugin-telegram-projects", file: "telegram:chat.ts", root: null, absent: "sibling repository bb-plugin-telegram-projects is not on this machine", hubPlugin: "telegram-projects" });
    expect(absent!.next).toContain("npm run sma:sibling -- setup telegram");
    expect(siblingAnchor("core:src/subject.ts#limit", "fx_one", { core: worktree })).toMatchObject({ root: worktree, lines: 1 });
    expect(siblingAnchor("src/rooms/x.ts#y", "a", {})).toBeNull();
  });
});
