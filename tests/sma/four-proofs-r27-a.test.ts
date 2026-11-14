// Region 27 «Shipping and honest numbers» (n1733–n1755): the behaviour proofs of the ship verbs, the publish gate and the live window run.
// Every ship check runs as the real script (`scripts/lp-ship.ts`, pointed at a fixture release tree by LP_SHIP_ROOT) and the result is read
// from what it prints and its exit code; nothing here calls a function and checks that it was called.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase, saveProjectSetting, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { shipWatchSweep } from "../../src/rooms/self-repair/server/ship-watch";
import { registerCli } from "../../src/rooms/tools/server/cli";
// @ts-expect-error the scene driver lib is a plain .mjs without declarations
import { parseSceneArgs } from "../../scripts/lib/ui-scene.mjs";
import { commit, git, releaseTree, repoRoot, ship, stampReceipt, taskRecord, todo, write } from "../../scripts/lp_drill/scenes/sma_r27_fixture";

const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
type Report = { stage?: boolean; tree?: string; url?: string; widths: Array<{ width: number; error: string | null; screenshot: string; asserts: Array<{ ok: boolean; detail: string }> }> } | null;
const FAKE_KEY = "sk" + "-" + "a".repeat(28);

describe("[sma:k_v_docaudit] doc-audit turns what the docs promise into lines a script prints", () => {
  it("a clean tree agrees; a missing verb, a missing path and a wrong node count are each named with their file", { timeout: 120_000 }, () => {
    const tree = releaseTree();
    const clean = ship(tree, ["doc-audit"]);
    expect(clean.status).toBe(0);
    expect(clean.out).toContain("doc honesty: 1 documents agree with the code");

    write(tree.root, "README.md", "# Fixture\n\nRun `bb lane-pilot ghost-verb` and `bb lane-pilot task`, and `bb lane-pilot finish`.\nSee `src/missing.ts` and `src/rooms/tools/server/cli-commands.ts`.\nThe SMA map has 12345 nodes.\n");
    // A decision record keeps the paths of its day: only living documents are held to the code.
    write(tree.root, "docs/decisions/old.md", "# Old\n\nIt lived in `src/gone.ts`.\n");
    const planted = ship(tree, ["doc-audit"]);
    expect(planted.status).toBe(1);
    const found = lines(planted.out);
    expect(found).toHaveLength(3);
    expect(found[0]).toBe("README.md: names `bb lane-pilot ghost-verb`, which the CLI does not have");
    expect(found[1]).toBe("README.md: names src/missing.ts, which does not exist");
    expect(found[2]).toMatch(/^README\.md: says 12345 nodes of the SMA map, the map has \d+$/);
  });
});

describe("[sma:k_lib_docaudit] the strict doc audit holds dates and the count of undocumented verbs", () => {
  it("a future or stale `updated:` date is named; a new undocumented verb past the baseline fails, within it passes; plain skips both", { timeout: 180_000 }, () => {
    const tree = releaseTree();
    const front = (date: string) => `---\ntitle: t\nupdated: ${date}\n---\n\n# Doc\n\nRun \`bb lane-pilot task\` and \`bb lane-pilot phase\`.\n`;
    write(tree.root, "docs/future.md", front("2099-01-01"));
    write(tree.root, "docs/stale.md", front("2020-01-01"));
    write(tree.root, "docs/fine.md", front(new Date().toISOString().slice(0, 10)));
    commit(tree.root, "docs");
    const strict = ship(tree, ["doc-audit", "--strict"]);
    expect(strict.status).toBe(1);
    expect(lines(strict.out)).toEqual([
      "docs/future.md: front matter updated: 2099-01-01 is in the future",
      "docs/stale.md: updated: 2020-01-01 is over 30 days behind its last commit",
    ]);
    expect(ship(tree, ["doc-audit"]).status).toBe(0);

    rmSync(join(tree.root, "docs/future.md")); rmSync(join(tree.root, "docs/stale.md"));
    commit(tree.root, "drop the dated docs");
    write(tree.root, "src/rooms/tools/server/cli-commands.ts", `export const commands = [\n  { name:"task", summary:"a", usage:"" },\n  { name:"phase", summary:"b", usage:"" },\n  { name:"ghostly", summary:"c", usage:"" },\n];\n`);
    write(tree.root, ".agents/ship/doc-coverage-baseline.json", JSON.stringify({ undocumented: 0, verbs: [] }));
    const grew = ship(tree, ["doc-audit", "--strict"]);
    expect(grew.status).toBe(1);
    expect(grew.out).toContain("undocumented CLI verbs grew 0 -> 1: ghostly");
    write(tree.root, ".agents/ship/doc-coverage-baseline.json", JSON.stringify({ undocumented: 1, verbs: ["ghostly"] }));
    const within = ship(tree, ["doc-audit", "--strict"]);
    expect(within.status).toBe(0);
    expect(within.out).toContain("doc honesty:");
  });
});

describe("[sma:k_v_vendor] the vendor verb: an update without a note stops the release, a triaged one does not", () => {
  it("foo moved and baz is new since the tag: both listed untriaged (exit 1); after triage the ledger is clean (exit 0)", { timeout: 120_000 }, () => {
    const tree = releaseTree();
    const first = ship(tree, ["vendor"]);
    expect(first.status).toBe(1);
    expect(lines(first.out)).toEqual([
      'untriaged vendor update foo 1.0.0 → 1.1.0 (npx tsx scripts/lp-ship.ts vendor triage foo "<why it is fine>")',
      'untriaged vendor update baz new → 0.1.0 (npx tsx scripts/lp-ship.ts vendor triage baz "<why it is fine>")',
    ]);
    expect(ship(tree, ["vendor", "triage", "ghost", "no such update"]).status).toBe(2);
    expect(ship(tree, ["vendor", "triage", "foo", "patch release, changelog read"]).out).toContain("triaged foo");
    expect(ship(tree, ["vendor"]).out).toContain('baz new → 0.1.0');
    ship(tree, ["vendor", "triage", "baz", "new tiny helper"]);
    const done = ship(tree, ["vendor"]);
    expect(done.status).toBe(0);
    expect(done.out).toContain("vendor ledger: every update since v0.1.0 is triaged");
  });
});

describe("[sma:k_lib_vendorledger] every update is a row with its old and new version and a verdict", () => {
  it("the ledger file holds one row per moved dependency (from → to, null for new) and the triage note lands on its own row", { timeout: 120_000 }, () => {
    const tree = releaseTree();
    ship(tree, ["vendor"]);
    ship(tree, ["vendor", "triage", "foo", "patch release"]);
    const ledger = JSON.parse(readFileSync(join(tree.root, ".agents/ship/vendor.json"), "utf8")) as Record<string, { from: string | null; to: string; note?: string }>;
    expect(ledger).toEqual({ foo: { from: "1.0.0", to: "1.1.0", note: "patch release" }, baz: { from: null, to: "0.1.0" } });
    // An update that did not move (bar) is not a row; a second run keeps the rows and their notes.
    ship(tree, ["vendor"]);
    expect(JSON.parse(readFileSync(join(tree.root, ".agents/ship/vendor.json"), "utf8"))).toEqual(ledger);
  });
});

describe("[sma:k_lib_licenses] the license ledger lists every shipped dependency and names what is not in the notices", () => {
  it("an unnamed one, a copyleft-only one and an unknown one are findings; a dual license with a permissive option and an internal scope are not", { timeout: 120_000 }, () => {
    const tree = releaseTree({ deps: { named: "MIT", unnamed: "ISC", copyleft: "GPL-3.0", dual: "MIT OR GPL-3.0", mystery: "UNKNOWN" }, notices: "# Notices\n\nnamed, copyleft, dual and mystery are listed here.\n" });
    const result = ship(tree, ["licenses"]);
    expect(result.status).toBe(1);
    expect(lines(result.out)).toEqual([
      "unnamed (ISC) ships but THIRD_PARTY_NOTICES.md does not name it",
      "copyleft: license GPL-3.0 needs a decision before it ships",
      "mystery: license UNKNOWN needs a decision before it ships",
    ]);
    expect(readFileSync(join(tree.root, ".agents/ship/licenses.tsv"), "utf8").trim().split("\n")).toEqual(["named\tMIT", "unnamed\tISC", "copyleft\tGPL-3.0", "dual\tMIT OR GPL-3.0", "mystery\tUNKNOWN"]);
    const fine = releaseTree({ deps: { named: "MIT" }, notices: "named\n" });
    const ok = ship(fine, ["licenses"]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain("license ledger: 1 production dependencies, all named");
  });
});

describe("[sma:k_lib_badge] the badge number comes from a receipt, never from a hand", () => {
  it("a vitest report prints its pass/total (red when anything failed); the newest drill receipt is the default; no receipt is exit 2", { timeout: 120_000 }, () => {
    const tree = releaseTree();
    expect(ship(tree, ["badge"]).status).toBe(2);
    const green = join(tree.root, "green.json");
    writeFileSync(green, JSON.stringify({ numPassedTests: 10, numFailedTests: 0, numTotalTests: 10 }));
    const ok = ship(tree, ["badge", green]);
    expect(ok.status).toBe(0);
    expect(ok.out).toMatch(/^!\[tests 10\/10\]\(https:\/\/img\.shields\.io\/badge\/tests-10%2F10-brightgreen\) <!-- from green\.json sha256 [0-9a-f]{12} -->$/m);
    const red = join(tree.root, "red.json");
    writeFileSync(red, JSON.stringify({ numPassedTests: 9, numFailedTests: 1, numTotalTests: 10 }));
    expect(ship(tree, ["badge", red]).out).toMatch(/^!\[tests 9\/10 · 1 failed\]\(https:\/\/img\.shields\.io\/badge\/tests-9%2F10%20%C2%B7%201%20failed-red\)/m);
    write(tree.root, ".agents/runs/drills/2026-11-01.json", JSON.stringify({ result: "fail", scenarios: [{ result: "pass" }, { result: "fail" }] }));
    write(tree.root, ".agents/runs/drills/2026-11-02.json", JSON.stringify({ result: "pass", scenarios: [{ result: "pass" }, { result: "pass" }, { result: "pass" }] }));
    const newest = ship(tree, ["badge"]);
    expect(newest.out).toContain("![drill 3/3 pass](https://img.shields.io/badge/drill-3%2F3%20pass-brightgreen)");
    expect(newest.out).toContain("from .agents/runs/drills/2026-11-02.json");
  });
});

describe("[sma:k_v_prepublish] the publish gate runs the build, then freshness, then the strict checks, and stops at the first failure", () => {
  it("a clean tree passes all six steps; a failing build stops first; an unreachable hub is a warning; a stale bundle or the first failing check stops the rest", { timeout: 300_000 }, () => {
    const tree = releaseTree();
    const clean = ship(tree, ["gate"], { SERVED: "0.1.0" });
    expect(clean.status).toBe(0);
    expect(clean.out).toContain("gate: build, freshness, publishable, licenses, doc-audit and predict-lint all clean");

    const noBuild = ship(tree, ["gate"], { BUILD_RC: "1" });
    expect(noBuild.status).toBe(1);
    expect(lines(noBuild.out)).toEqual(["bb plugin build failed"]);

    // A hub that cannot be asked: freshness cannot check, the gate says so and goes on to the strict checks.
    const unreachable = ship(tree, ["gate"]);
    expect(unreachable.status).toBe(0);
    expect(unreachable.out).toContain("gate: freshness could not check (the hub is unreachable) — warning, not a stop");

    // A bundle older than its sources: freshness fails and nothing after it runs.
    write(tree.root, "src/rooms/x/ui/panel.tsx", "export {};\n");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(tree.root, "src/rooms/x/ui/panel.tsx"), future, future);
    commit(tree.root, "a window source");
    stampReceipt(tree);
    utimesSync(join(tree.root, "src/rooms/x/ui/panel.tsx"), future, future);
    const stale = ship(tree, ["gate"], { SERVED: "0.1.0" });
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("gate: freshness failed");
    expect(stale.out).not.toContain("publishable:");

    // First failure wins: a promise in the changelog AND a leaked key — publishable (earlier) names itself, predict-lint never runs.
    const both = releaseTree();
    write(both.root, "src/leak.ts", `export const key = "${FAKE_KEY}";\n`);
    write(both.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- everything is faster now\n\n## 0.1.0\n\n- First cut.\n");
    commit(both.root, "leak and promise");
    stampReceipt(both);
    const first = ship(both, ["gate"], { SERVED: "0.1.0" });
    expect(first.status).toBe(1);
    expect(first.out).toContain("leak scan: src/leak.ts:1");
    expect(first.out).toContain("gate: publishable failed");
    expect(first.out).not.toContain("predict-lint");
    expect(first.out).not.toContain("license ledger");
  });
});

describe("[sma:k_lib_pkgcheck] the package is publishable only when version, changelog, tree, license, builds and receipt agree", () => {
  it("a clean tree passes plain and strict; each broken thing is its own finding, and the strict-only ones appear only with --strict", { timeout: 300_000 }, () => {
    const tree = releaseTree();
    expect(ship(tree, ["publishable"]).out.trim()).toBe("publishable: 0.1.1");
    expect(ship(tree, ["publishable", "--strict"]).status).toBe(0);

    // version equal to the last tag, no CHANGELOG entry for it, an uncommitted change, no LICENSE
    const broken = releaseTree();
    write(broken.root, "package.json", JSON.stringify({ name: "fixture", version: "0.1.0", dependencies: {}, bb: { server: "./server.ts", host: "./host.ts", app: "./app.tsx" } }));
    commit(broken.root, "version back");
    write(broken.root, "CHANGELOG.md", "# Changelog\n\n## 0.0.9\n\n- Older.\n");
    git(broken.root, "rm", "-q", "LICENSE");
    const plain = ship(broken, ["publishable"]);
    expect(plain.status).toBe(1);
    expect(lines(plain.out)).toEqual([
      "version 0.1.0 is not above the last tag v0.1.0",
      "CHANGELOG.md has no «## 0.1.0» entry",
      "the tree has uncommitted changes",
      "no LICENSE",
    ]);

    // strict only: no build, a build of another version, no test-full receipt, a leak, a stale atlas
    const strict = releaseTree();
    rmSync(join(strict.root, "dist/host.js"));
    write(strict.root, "dist/app.meta.json", JSON.stringify({ pluginVersion: "0.0.1" }));
    rmSync(join(strict.root, "dist/server.meta.json"));
    rmSync(strict.receipts, { recursive: true, force: true });
    write(strict.root, ".atlas-stale", "");
    write(strict.root, "src/leak.ts", `export const key = "${FAKE_KEY}";\n`);
    commit(strict.root, "leak");
    // Plain publishable (main's) asks for neither the leak scan nor the builds nor the receipt.
    expect(lines(ship(strict, ["publishable"]).out)).toEqual(["the atlas is stale: npx tsx scripts/generate-atlas.ts"]);
    const hard = ship(strict, ["publishable", "--strict"]);
    expect(hard.status).toBe(1);
    expect(lines(hard.out)).toEqual([
      "leak scan: src/leak.ts:1",
      "the atlas is stale: npx tsx scripts/generate-atlas.ts",
      "dist/server.meta.json is missing",
      "dist/host.js is not built",
      "dist/app.meta.json pluginVersion is not 0.1.1",
      expect.stringMatching(/^no test-full receipt for this tree and v\d+/),
    ]);
  });
});

describe("[sma:k_lib_releaselint] a promise in the release notes must say how it is measured", () => {
  it("the newest entry's unmeasured promise fails; a measured one passes; the same promise in an older entry is only a warning", { timeout: 180_000 }, () => {
    const tree = releaseTree();
    write(tree.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Startup is faster now.\n- Search no longer times out; measured at 40 ms by the drill.\n- Больше не падает при пустом ответе.\n\n## 0.1.0\n\n- Fewer retries.\n");
    const planted = ship(tree, ["predict-lint"]);
    expect(planted.status).toBe(1);
    expect(lines(planted.out)).toEqual([
      "warning: CHANGELOG 0.1.0: «- Fewer retries.» promises an effect without saying how it is measured",
      "CHANGELOG 0.1.1: «- Startup is faster now.» promises an effect without saying how it is measured",
      "CHANGELOG 0.1.1: «- Больше не падает при пустом ответе.» promises an effect without saying how it is measured",
    ]);
    write(tree.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Search no longer times out; measured at 40 ms by the drill.\n\n## 0.1.0\n\n- Fewer retries.\n");
    const older = ship(tree, ["predict-lint"]);
    expect(older.status).toBe(0);
    expect(older.out).toContain("warning: CHANGELOG 0.1.0:");
    expect(older.out).toContain("prediction lint: the 0.1.1 notes measure what they promise");
  });
});

describe("[sma:k_lib_spafresh] the served window is judged against its sources and against the hub", () => {
  it("a source newer than the bundle is named under --strict; a fresh bundle passes; a hub on another version fails, except for an unpublished version", { timeout: 300_000 }, () => {
    const tree = releaseTree();
    const fresh = ship(tree, ["freshness", "--strict"], { SERVED: "0.1.1" });
    expect(fresh.status).toBe(0);
    expect(fresh.out).toContain('"checkout":"0.1.1","served":"0.1.1"');

    const other = ship(tree, ["freshness", "--strict"], { SERVED: "0.1.0" });
    expect(other.status).toBe(1);
    expect(other.out).toContain("the hub serves 0.1.0, the checkout is 0.1.1");
    expect(ship(tree, ["freshness", "--strict", "--unpublished"], { SERVED: "0.1.0" }).status).toBe(0);
    expect(ship(tree, ["freshness"], { SERVED: "0.1.0" }).status).toBe(1);
    expect(ship(tree, ["freshness"]).status).toBe(2);

    write(tree.root, "src/rooms/x/ui/panel.tsx", "export {};\n");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(tree.root, "src/rooms/x/ui/panel.tsx"), future, future);
    const stale = ship(tree, ["freshness", "--strict", "--unpublished"], { SERVED: "0.1.1" });
    expect(stale.status).toBe(1);
    expect(stale.out).toContain("bundle older than sources: src/rooms/x/ui/panel.tsx");
    expect(ship(tree, ["freshness"], { SERVED: "0.1.1" }).out).not.toContain("bundle older than sources");

    write(tree.root, "dist/app.meta.json", JSON.stringify({ pluginVersion: "0.0.9" }));
    expect(ship(releaseTree(), ["freshness", "--strict"], { SERVED: "0.1.1" }).status).toBe(0);
    const wrong = releaseTree();
    write(wrong.root, "dist/app.meta.json", JSON.stringify({ pluginVersion: "0.0.9" }));
    expect(ship(wrong, ["freshness", "--strict"], { SERVED: "0.1.1" }).out).toContain("dist/app.meta.json pluginVersion is not 0.1.1");
  });
});

describe("[sma:k_v_shiplane] the lane verb picks docs, batch or full from what changed, drafts the changelog and keeps one record per base and head", () => {
  it("a change to documents only is the docs lane, ordinary code is batch, a core path is full; the record is written once", { timeout: 180_000 }, () => {
    const tree = releaseTree();
    const lane = (base: string, ...more: string[]) => JSON.parse(ship(tree, ["lane", base, "--no-record", ...more]).out) as { base: string; files: number; lane: string; why: string };
    expect(lane("v0.1.0")).toMatchObject({ lane: "batch", files: 3, why: "code outside the core: the middle batch lane, quick drill" });
    write(tree.root, "docs/guide.md", "# Guide\n");
    commit(tree.root, "docs only");
    expect(lane("HEAD~1")).toEqual({ base: "HEAD~1", files: 1, lane: "docs", why: "only documents changed: no drill" });
    write(tree.root, "host.ts", "export const changed = 1;\n");
    commit(tree.root, "core");
    const full = lane("HEAD~1");
    expect(full.lane).toBe("full");
    expect(full.why).toBe("core paths changed (host.ts): full suite and full drill");

    const recorded = JSON.parse(ship(tree, ["lane", "HEAD~1"]).out) as { changelogDraft: string; record: string };
    expect(recorded.record).toBe("recorded");
    expect(recorded.changelogDraft).toBe("## 0.1.1\n\n- core");
    const again = JSON.parse(ship(tree, ["lane", "HEAD~1"]).out) as { record: string };
    expect(again.record).toBe("already recorded");
    const rows = readFileSync(join(tree.root, ".agents/ship/lanes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { base: string; lane: string; files: number });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ base: "HEAD~1", lane: "full", files: 1 });
  });
});

describe("[sma:k_v_batch] [sma:k_lib_batch] the middle lane takes small ready items, sends core paths to the full lane and demands receipts", () => {
  it("every chosen item with both receipts is a batch; a core item and an item without receipts are named; a lone item is no batch", { timeout: 180_000 }, () => {
    const tree = releaseTree();
    const accepted = { state: "accepted", stages: [{ id: "plan-critique", state: "passed" }] };
    todo(tree, "a", { estimate: "1" }); todo(tree, "b", { estimate: "2" });
    taskRecord(tree, "a", accepted); taskRecord(tree, "b", accepted);
    const clean = ship(tree, ["batch"]);
    expect(clean.status).toBe(0);
    expect(clean.out.trim()).toBe("batch lane: a, b");

    todo(tree, "c", { estimate: "3", owns_paths: "[src/rooms/storage/db.ts]" });
    todo(tree, "d", { estimate: "3" });
    taskRecord(tree, "c", accepted);
    taskRecord(tree, "d", { state: "blocked", stages: [] });
    const mixed = ship(tree, ["batch"]);
    expect(mixed.status).toBe(1);
    expect(lines(mixed.out)).toEqual([
      "c: owns_paths touch the core, it ships the full lane, not a batch",
      "d: missing plan-critique receipt",
      "d: missing accepted attempt receipt",
    ]);
    // An item the task record does not know has neither receipt.
    todo(tree, "e", { estimate: "3", priority: "high" });
    expect(lines(ship(tree, ["batch"]).out)).toContain("e: missing plan-critique receipt");
    // --max 2 takes the high-priority item first, then the smallest: e (no record) and a.
    expect(lines(ship(tree, ["batch", "--max", "2"]).out)).toEqual(["e: missing plan-critique receipt", "e: missing accepted attempt receipt"]);

    const alone = releaseTree();
    todo(alone, "only", { estimate: "1" });
    expect(ship(alone, ["batch"]).out.trim()).toBe("not enough for a batch");
  });
});

const cliHost = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  registerCli(createCore(bb, db), {} as Services, migrations);
  return { harness };
};

describe("[sma:k_v_explain] bb lane-pilot explain answers a verb with its summary and the doc that names it, and a topic with its guide", () => {
  it("a verb, the same verb without its hyphen, a topic; a missing word is a usage error with the catalog", { timeout: 60_000 }, async () => {
    const { harness } = cliHost();
    // `waiting` is named by a guide doc, `plans-health` by none: the first shows its doc, the second says only what it is.
    const named = await harness.behavior.runCli(["explain", "waiting"]);
    expect(String(named.stdout)).toMatch(/^waiting — verb\n\nEverything only the owner can decide[\s\S]*\nbb lane-pilot waiting \[--json\]/);
    expect(String(named.stdout)).toMatch(/\n\ndoc: docs\/guide\/failures\.md$/);
    const verb = await harness.behavior.runCli(["explain", "plans-health"]);
    expect(verb.exitCode).toBe(0);
    expect(String(verb.stdout)).toMatch(/^plans-health — verb\n\n.+\nbb lane-pilot plans-health /);
    expect(String(verb.stdout)).not.toContain("doc:");
    const unhyphenated = await harness.behavior.runCli(["explain", "planshealth"]);
    expect(String(unhyphenated.stdout).split("\n")[0]).toBe("plans-health — verb");
    const topic = await harness.behavior.runCli(["explain", "graphs"]);
    expect(topic.exitCode).toBe(0);
    expect(String(topic.stdout)).toMatch(/^graphs — topic\n\n/);
    expect(String(topic.stdout)).toContain("doc: docs/guide/graphs.md");
    const bare = await harness.behavior.runCli(["explain"]);
    expect(bare.exitCode).toBe(1);
    expect(String(bare.stderr)).toMatch(/^usage: bb lane-pilot explain <verb or topic>\n/);
  });
});

describe("[sma:k_lib_explain] an unknown topic lists the catalog and never punishes; the explainers' tripwire fails when a node they explain is no longer proven", () => {
  it("the catalog is every verb and every topic, sorted, with exit 0; the tripwire names an unknown id and an unproven one", { timeout: 180_000 }, async () => {
    const { harness } = cliHost();
    const unknown = await harness.behavior.runCli(["explain", "no-such-thing"]);
    expect(unknown.exitCode).toBe(0);
    const [head, ...catalog] = String(unknown.stdout).split("\n");
    expect(head).toBe("no explainer for «no-such-thing». Try:");
    expect(catalog).toEqual([...catalog].sort());
    expect(catalog).toEqual(expect.arrayContaining(["plans-health", "graphs", "handoff", "memory"]));
    // The tripwire, through the ship verb on a tree whose docs explain nodes of the map.
    const tree = releaseTree();
    write(tree.root, "docs/explainer.md", "---\ntitle: t\nexplains: [n9999999, n1036]\n---\n\n# Explainer\n\nRun `bb lane-pilot task`.\n");
    const found = ship(tree, ["explain"]);
    expect(found.status).toBe(1);
    expect(lines(found.out)).toEqual([
      "explain coverage: 2/2 CLI verbs have an explainer",
      "docs/explainer.md explains n9999999, which the SMA map does not have",
      expect.stringMatching(/^docs\/explainer\.md explains n1036 «.+», which is no longer proven — the explainer is out of date$/),
    ]);
    write(tree.root, "docs/explainer.md", "---\ntitle: t\n---\n\n# Explainer\n");
    write(tree.root, "README.md", "# Fixture\n\nRun `bb lane-pilot task`.\n");
    const uncovered = ship(tree, ["explain"]);
    expect(uncovered.status).toBe(0);
    expect(uncovered.out).toContain("explain coverage: 1/2 CLI verbs have an explainer (missing: phase)");
  });
});

describe("[sma:k_lib_shiplane] the daily watch flags a checkout whose pile passed the caps and closes the item when it falls", () => {
  const commits = (repo: string, n: number) => { for (let i = 0; i < n; i++) git(repo, "commit", "--allow-empty", "-qm", `c${i}`); };
  const checkout = (): string => { const repo = mkdtempSync(join(tmpdir(), "lp-r27-pile-")); git(repo, "init", "-q", "-b", "main"); commits(repo, 1); git(repo, "tag", "v0.1.0"); commits(repo, 30); return repo; };
  const config = (projectId: string, path: string) => ({ projectId, hostId: "host-test", pmWorkspacePath: path, writerWorkspacePath: path, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
  const run = async (at: { hostId: string; cwd: string }, command: string) => {
    const done = await new Promise<{ code: number; out: string }>((ok) => { const child = spawn("/bin/bash", ["-c", command], { cwd: at.cwd }); let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", (code) => ok({ code: code ?? 1, out })); });
    return { exitCode: done.code, stdout: done.out };
  };
  const open = (db: ReturnType<typeof openDatabase>) => (db.prepare("SELECT key, kind, what FROM lane_pilot_owner_item WHERE state='open' ORDER BY key").all() as Array<{ key: string; kind: string; what: string }>);

  it("30 commits over the cap of 25 post one owner item that names the pile; a raised cap, ship.watch off or a later tag leave none", { timeout: 60_000 }, async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const repo = checkout();
    savePrototypeConfig(db, config("proj_r27", repo));
    const swept = await shipWatchSweep(db as never, run);
    expect(swept).toEqual({ checked: 1, flagged: ["proj_r27"] });
    const items = open(db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: "ship-watch:proj_r27:", kind: "ship_batch" });
    expect(items[0]!.what).toContain("30 commits over 25 с v0.1.0");

    // Re-run: still one item. A tag closes it.
    await shipWatchSweep(db as never, run);
    expect(open(db)).toHaveLength(1);
    git(repo, "tag", "v0.2.0");
    expect(await shipWatchSweep(db as never, run)).toEqual({ checked: 1, flagged: [] });
    expect(open(db)).toEqual([]);

    // The cap is the project's own setting; a pile under it is not flagged.
    commits(repo, 30);
    saveProjectSetting(db as never, "proj_r27", "ship.max_batch_commits", 40);
    expect((await shipWatchSweep(db as never, run)).flagged).toEqual([]);
    saveProjectSetting(db as never, "proj_r27", "ship.max_batch_commits", 20);
    expect((await shipWatchSweep(db as never, run)).flagged).toEqual(["proj_r27"]);
    saveProjectSetting(db as never, "proj_r27", "ship.watch", "off");
    git(repo, "tag", "v0.3.0");
    commits(repo, 30);
    await shipWatchSweep(db as never, run);
    expect(open(db).map((item) => item.key)).toEqual(["ship-watch:proj_r27:"]);
    expect(await shipWatchSweep(db as never, run)).toEqual({ checked: 0, flagged: [] });
  });
});

describe("a live window run through a real browser", () => {
  const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><h1>Lane Pilot</h1>
<button id="b" onclick="document.getElementById('o').textContent='opened'">Open</button><p id="o"></p>
<div data-task-card>a</div><div data-task-card>b</div>`;

  const serve = async (): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createServer((req, res) => { if (req.url === "/missing") { res.writeHead(404).end("no"); return; } res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  };
  const uiRuns = join(repoRoot, ".agents/runs/ui");
  const drive = (args: string[]): Promise<{ code: number; out: string; report: Report }> => new Promise((ok) => {
    const before = new Set(existsSync(uiRuns) ? readdirSync(uiRuns) : []);
    const child = spawn("node", [join(repoRoot, "scripts/lp-ui-drive.mjs"), ...args], { cwd: repoRoot });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => {
      const path = /UI_REPORT=(.+)/.exec(out)?.[1]?.trim();
      const report = path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Report : null;
      if (path) rmSync(dirname(path), { recursive: true, force: true });
      // A run that failed to start writes its report folder without printing it: the folders this run made are removed too.
      for (const name of existsSync(uiRuns) ? readdirSync(uiRuns) : []) if (!before.has(name) && /^scene-/.test(name)) rmSync(join(uiRuns, name), { recursive: true, force: true });
      ok({ code: code ?? 2, out, report });
    });
  });
  const scene = (body: Record<string, unknown>): string => { const dir = mkdtempSync(join(tmpdir(), "lp-r27-scene-")); const path = join(dir, "scene.json"); writeFileSync(path, JSON.stringify(body)); return path; };
  /** The report folder is removed with the report, so the screenshot is read before: the driver prints the folder through UI_REPORT. */

  it("[sma:k_v_uidrive] a scene opens the page, clicks, and writes a receipt of what was seen at each width", { timeout: 90_000 }, async () => {
    const page = await serve();
    try {
      const file = scene({ url: page.url, widths: [375, 1280], steps: [{ click: "#b" }, { wait: 50 }], asserts: [{ selector: "h1", text: "Lane Pilot" }, { selector: "#o", text: "opened" }, { noOverflow: true }, { selector: "[data-task-card]", minCount: 2 }, { selector: "h1" }] });
      const ran = await drive([file]);
      expect(ran.code).toBe(0);
      expect(ran.report).not.toBeNull();
      expect(ran.report!.widths.map((row: { width: number }) => row.width)).toEqual([375, 1280]);
      for (const row of ran.report!.widths as Array<{ asserts: Array<{ ok: boolean; detail: string }>; screenshot: string; error: string | null }>) {
        expect(row.error).toBeNull();
        expect(row.asserts.map((check) => check.ok)).toEqual([true, true, true, true, true]);
        expect(row.asserts[0]!.detail).toBe("«Lane Pilot»");
        expect(row.asserts[1]!.detail).toBe("«opened»");
        expect(row.asserts[3]!.detail).toBe("2 of at least 2");
      }
    } finally { await page.close(); }
  });

  it("[sma:k_lib_uidrive] the exit law: 0 every assert held, 1 an assert failed, 2 the run did not happen — a run that did not happen never counts as a pass", { timeout: 120_000 }, async () => {
    const page = await serve();
    try {
      const failing = await drive([scene({ url: page.url, widths: [375], asserts: [{ selector: "h1", text: "Lane Pilot" }, { selector: "h1", text: "Something else" }, { selector: "[data-task-card]", minCount: 3 }] })]);
      expect(failing.code).toBe(1);
      const row = failing.report!.widths[0] as { asserts: Array<{ ok: boolean; detail: string }> };
      expect(row.asserts.map((check) => check.ok)).toEqual([true, false, false]);
      expect(row.asserts[1]!.detail).toBe("«Lane Pilot»");
      expect(row.asserts[2]!.detail).toBe("2 of at least 3");

      const notLoaded = await drive([scene({ url: `${page.url}missing`, widths: [375], asserts: [{ selector: "h1" }] })]);
      expect(notLoaded.code).toBe(2);
      expect(notLoaded.out).toContain("the page answered 404");
    } finally { await page.close(); }
    const closed = await drive([scene({ url: page.url, widths: [375], asserts: [{ selector: "h1" }] })]);
    expect(closed.code).toBe(2);
    const unreadable = await drive([join(tmpdir(), "lp-r27-no-such-scene.json")]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.out).toContain("scene unreadable");
    const noBrowser = await new Promise<number>((ok) => { const child = spawn("node", [join(repoRoot, "scripts/lp-ui-drive.mjs"), scene({ url: page.url, asserts: [] })], { cwd: repoRoot, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), "lp-r27-no-browser-here") } }); child.on("close", (code) => ok(code ?? 2)); });
    expect(noBrowser).toBe(2);
  });

  it("[sma:k_v_uistage] --stage raises the tree's built window, walks the scene, takes the screenshots, skips the asserts and takes the window down", { timeout: 90_000 }, async () => {
    const tree = mkdtempSync(join(tmpdir(), "lp-r27-stage-"));
    mkdirSync(join(tree, "src"), { recursive: true });
    mkdirSync(join(tree, "dist"), { recursive: true });
    writeFileSync(join(tree, "src", "app.ts"), "export {};\n");
    writeFileSync(join(tree, "dist", "app.js"), "document.getElementById('root').textContent='staged window';\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(tree, "src", "app.ts"), old, old);
    try {
      const ran = await drive(["--stage", "--tree", tree, scene({ url: "http://127.0.0.1:1/", widths: [375], steps: [], asserts: [{ selector: "#root", text: "NOT THE TEXT" }] })]);
      expect(ran.code).toBe(0);
      expect(ran.report!.stage).toBe(true);
      expect(ran.report!.tree).toBe(tree);
      expect(ran.out).toMatch(new RegExp(`STAGE_URL=http://127\\.0\\.0\\.1:4[2-8]\\d\\d/`));
      expect(ran.report!.url).toBe(/STAGE_URL=(\S+)/.exec(ran.out)![1]);
      expect(ran.report!.widths[0].asserts).toEqual([]);
      expect(ran.report!.widths[0].screenshot).toMatch(/w375\.png$/);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it("[sma:k_lib_uistage] the argument grammar: a port outside 1..65535, a flag without its value, two scenes and a missing scene are usage errors; --trees splits on commas", () => {
    expect(() => parseSceneArgs(["--port", "0", "s.json"])).toThrow(/--port wants a port number 1\.\.65535/);
    expect(() => parseSceneArgs(["--width", "65536", "s.json"])).toThrow(/--width wants a port number/);
    expect(() => parseSceneArgs(["--tree"])).toThrow(/--tree needs a value/);
    expect(() => parseSceneArgs(["a.json", "b.json"])).toThrow(/one scene file only/);
    expect(() => parseSceneArgs(["--stage"])).toThrow(/^usage: node scripts\/lp-ui-drive\.mjs/);
    const args = parseSceneArgs(["--trees", "a, b ,,kit", "--port", "65535", "s.json"]);
    expect({ trees: args.trees, port: args.port, scene: args.scene, stage: args.stage }).toEqual({ trees: ["a", "b", "kit"], port: 65535, scene: "s.json", stage: false });
    expect(parseSceneArgs(["s.json"]).trees).toEqual([]);
  });
});
