import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { SMA_EVIDENCE_BY_REGION } from "../src/rooms/sma-map/evidence";
import { distort, entry, flip, isSet, not, outside, rows, skipWrite, type RegionEvidence, via, wfRun } from "../src/rooms/sma-map/evidence/types";
import { evidenceProblems } from "../src/rooms/sma-map/evidence-check";
import { SMA_NODES, SMA_REGIONS } from "../src/rooms/sma-map/graph";
import { SMA_ATTEST, SMA_ATTEST_BY_REGION, lintMutation, mutationState, specHash } from "../src/rooms/sma-map/mutation";

const root = join(import.meta.dirname, "..");
const empty = (): RegionEvidence[] => SMA_REGIONS.map(() => ({}));
const check = (byRegion: RegionEvidence[], entries = SMA_ENTRIES) => evidenceProblems({ byRegion, nodes: SMA_NODES, entries, root });

describe("the per-node evidence registry (sma-parity-tz.md §4)", () => {
  it("has one file per region, and every line validates against the map, the settings registry and the source", () => {
    expect(SMA_EVIDENCE_BY_REGION).toHaveLength(SMA_REGIONS.length);
    expect(SMA_ATTEST_BY_REGION).toHaveLength(SMA_REGIONS.length);
    expect(evidenceProblems({ byRegion: [...SMA_EVIDENCE_BY_REGION], nodes: SMA_NODES, entries: SMA_ENTRIES, attest: SMA_ATTEST, root })).toEqual([]);
  });

  it("refuses an unknown node, a node filed in another region, an unknown setting key and an unknown field", () => {
    const files = empty();
    files[1] = { n99999: { reach: entry("x") }, n0: { reach: entry("x") }, n161: { reach: via({ "no.such.setting": "on" }) }, n162: { reachh: {} } as never };
    const problems = check(files);
    expect(problems).toContainEqual(expect.stringMatching(/n99999: unknown node/));
    expect(problems).toContainEqual(expect.stringMatching(/n0: the node belongs to region 0/));
    expect(problems).toContainEqual(expect.stringMatching(/n161: unknown setting key no\.such\.setting/));
    expect(problems).toContainEqual(expect.stringMatching(/n162: unknown field reachh/));
  });

  it("refuses a malformed mutation spec: a find that is not in the file, null or throw in the replacement, a deleted body, a test file", () => {
    const files = empty();
    files[1] = {
      n161: { mutation: flip("src/rooms/tasks/rails.ts", "this text is not in the file", "x") },
      n162: { mutation: distort("src/rooms/tasks/rails.ts", "return \"dependency\";", "return null;") },
      n163: { mutation: distort("src/rooms/tasks/rails.ts", "return \"conflict\";", "throw new Error(\"x\");") },
      n164: { mutation: skipWrite("src/rooms/tasks/rails.ts", "export function queueOrder<T extends { priority?: string; birth?: string; queuedAt: number }>(rows: readonly T[]): T[] {") },
      n166: { mutation: flip("tests/sma/task-graph-1.test.ts", "toBe(true)", "toBe(false)") },
    };
    const problems = check(files).join("\n");
    expect(problems).toMatch(/n161: mutation: find occurs 0 times/);
    expect(problems).toMatch(/n162: mutation: replace introduces null/);
    expect(problems).toMatch(/n163: mutation: replace introduces throw/);
    expect(problems).toMatch(/n164: mutation: skipped-write drops one write statement/);
    expect(problems).toMatch(/n166: mutation: file .* must be a source file/);
  });

  it("refuses a malformed trace, need or review", () => {
    const files = empty();
    files[1] = {
      n161: { trace: rows("sqlite_master", "x") },
      n162: { trace: wfRun("") },
      n163: { trace: { kind: "transition" } as never },
      n164: { reach: via({ "owner.words": not([]) }) },
      n166: { voidReview: { verdict: "void", reason: "" } },
    };
    const problems = check(files).join("\n");
    expect(problems).toMatch(/n161: trace: rows reads only lane_pilot_\* tables/);
    expect(problems).toMatch(/n162: trace: wfRun needs a workflow id/);
    expect(problems).toMatch(/n163: trace: a transition names from or to/);
    expect(problems).toMatch(/n164: needs owner\.words: not\(\) with no word/);
    expect(problems).toMatch(/n166: voidReview says no reason/);
    expect(problems).toMatch(/n166: voidReview on a node whose status is have/);
  });

  it("accepts a well-formed line of every constructor", () => {
    const files = empty();
    files[1] = { n169: { reach: via({ "run.max_tokens": isSet() }), trace: [outside("the BB thread"), rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL")] } };
    expect(check(files)).toEqual([]);
  });

  it("asks a deviation for its reason and keeps deviation-data at 2 % of the map at most", () => {
    const ids = SMA_NODES.slice(0, 40).map(([id]) => id);
    const entries = { ...SMA_ENTRIES, ...Object.fromEntries(ids.map((id) => [id, ["deviation-data", "measured worse on 30 tasks"] as const])), n161: ["deviation", ""] as const };
    const problems = check(empty(), entries as never).join("\n");
    expect(problems).toMatch(/deviation-data on 40 nodes: more than 2 %/);
    expect(problems).toMatch(/n161: deviation needs a one-line reason/);
    const real = Object.values(SMA_ENTRIES).filter(([status]) => status === "deviation-data").length;
    expect(real).toBeLessThanOrEqual(SMA_NODES.length * 0.02);
  });
});

describe("mutation attestations", () => {
  const spec = flip("src/rooms/tasks/rails.ts", "|| a.queuedAt - b.queuedAt);", "|| b.queuedAt - a.queuedAt);");
  const kill = { spec: specHash(spec), kind: spec.kind, file: "x", tests: {}, commit: "abc", result: "killed" as const, at: "" };

  it("counts a node as mutated only with a kill of its current spec whose find still applies", () => {
    expect(mutationState(spec, undefined, root).mutated).toBe(false);
    expect(mutationState(spec, { ...kill, result: "survived" }, root).mutated).toBe(false);
    expect(mutationState(spec, { ...kill, result: "crash" }, root).why).toMatch(/crash/);
    expect(mutationState({ ...spec, replace: "|| 0);" }, kill, root)).toMatchObject({ mutated: false, why: "the spec changed since the attestation" });
    const gone = flip("src/rooms/tasks/rails.ts", "no such text", "x");
    expect(mutationState(gone, { ...kill, spec: specHash(gone) }, root)).toMatchObject({ mutated: false, why: "find no longer applies exactly once" });
    // The file hash differs from "x": killed, but stale — a `--stale` run refreshes it.
    expect(mutationState(spec, kill, root)).toMatchObject({ mutated: true, stale: true });
    // On the hub (no sources) the spec hash is all there is.
    expect(mutationState(spec, kill, "")).toMatchObject({ mutated: true, stale: null });
  });

  it("the ten worked examples of the Task graph are attested killed by a real run", () => {
    const region1 = Object.entries(SMA_EVIDENCE_BY_REGION[1]!).filter(([, evidence]) => evidence.mutation);
    expect(region1.length).toBeGreaterThanOrEqual(10);
    for (const [id, evidence] of region1) expect(mutationState(evidence.mutation, SMA_ATTEST[id], root), id).toMatchObject({ mutated: true });
  });

  it("lints the shape: an empty replacement fits only a skipped write of one statement", () => {
    expect(lintMutation(distort("src/x.ts", "a = 1;", ""))).toContain("an empty replace only fits skipped-write");
    expect(lintMutation(skipWrite("src/x.ts", "store.write(row);"))).toEqual([]);
    expect(lintMutation(distort("src/x.ts", "return a;", "return;"))).toContainEqual(expect.stringMatching(/empty return/));
    expect(lintMutation(distort("src/x.ts", "return a;", "return void 0;"))).toContainEqual(expect.stringMatching(/void 0/));
  });
});
