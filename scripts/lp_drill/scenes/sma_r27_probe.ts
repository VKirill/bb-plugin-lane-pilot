// Probe of scenes/sma_r27.py: runs the real ship checks of THIS checkout (the commit under drill): `scripts/lp-ship.ts` against fixture release
// trees (sma_r27_fixture.ts) and against the checkout itself, the explain verb, the daily ship watch, and the live window run through a real
// browser. It prints one JSON line {nNNNN: {ok, detail}} and writes nothing to the hub database; the scene prove()s each node with it.
// No release, publish or deploy is ever run: the gate runs with a stand-in `bb` on a fixture tree, never on the checkout.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { Services } from "../../../server";
import { createCore } from "../../../src/rooms/core/server/core";
import { migrations, openDatabase } from "../../../src/rooms/plugin-db";
import { savePrototypeConfig } from "../../../src/rooms/storage/settings-store";
import { shipWatchSweep } from "../../../src/rooms/self-repair/server/ship-watch";
import { registerCli } from "../../../src/rooms/tools/server/cli";
// @ts-expect-error the scene driver lib is a plain .mjs without declarations
import { parseSceneArgs } from "../../lib/ui-scene.mjs";
import { commit, git, releaseTree, repoRoot, ship, stampReceipt, taskRecord, todo, write } from "./sma_r27_fixture";

type Seen = { ok: boolean; detail: string };
const seen: Record<string, Seen> = {};
const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const FAKE_KEY = ["sk", "a".repeat(28)].join("-");
const front = (date: string) => `---\ntitle: t\nupdated: ${date}\n---\n\n# Doc\n\nRun \`bb lane-pilot task\` and \`bb lane-pilot phase\`.\n`;

// ---- the live window run (a real browser) ----
type Report = { stage?: boolean; url?: string; widths?: Array<{ asserts: Array<{ ok: boolean; detail: string }>; screenshot?: string }> } | null;
const uiRuns = join(repoRoot, ".agents/runs/ui");
const drive = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; report: Report }> => new Promise((ok) => {
  const before = new Set(existsSync(uiRuns) ? readdirSync(uiRuns) : []);
  const child = spawn("node", [join(repoRoot, "scripts/lp-ui-drive.mjs"), ...args], { cwd: repoRoot, env: { ...process.env, ...env } });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  child.on("close", (code) => {
    const path = /UI_REPORT=(.+)/.exec(out)?.[1]?.trim();
    const report = path && existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Report) : null;
    for (const name of existsSync(uiRuns) ? readdirSync(uiRuns) : []) if (!before.has(name) && /^scene-/.test(name)) rmSync(join(uiRuns, name), { recursive: true, force: true });
    ok({ code: code ?? 2, out, report });
  });
});
const sceneFile = (body: Record<string, unknown>): string => { const path = join(mkdtempSync(join(tmpdir(), "lp-r27-scene-")), "scene.json"); writeFileSync(path, JSON.stringify(body)); return path; };
const PAGE = `<!doctype html><meta charset="utf-8"><title>t</title><h1>Lane Pilot</h1><button id="b" onclick="document.getElementById('o').textContent='opened'">Open</button><p id="o"></p><div data-task-card>a</div><div data-task-card>b</div>`;

async function windowRun(): Promise<void> {
  const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  try {
    const passing = await drive([sceneFile({ url, widths: [375], steps: [{ click: "#b" }, { wait: 50 }], asserts: [{ selector: "h1", text: "Lane Pilot" }, { selector: "#o", text: "opened" }, { noOverflow: true }, { selector: "[data-task-card]", minCount: 2 }] })]);
    const row = passing.report?.widths?.[0];
    seen.n1740 = { ok: passing.code === 0 && !!row && row.asserts.length === 4 && row.asserts.every((a: { ok: boolean }) => a.ok) && row.asserts[1].detail === "«opened»" && /w375\.png$/.test(row.screenshot ?? ""), detail: `exit ${passing.code}, asserts ${JSON.stringify(row?.asserts?.map((a: { detail: string }) => a.detail))}, screenshot ${row?.screenshot ? "written" : "none"}` };
    const failing = await drive([sceneFile({ url, widths: [375], asserts: [{ selector: "h1", text: "Nope" }, { selector: "[data-task-card]", minCount: 3 }] })]);
    const fails = failing.report?.widths?.[0]?.asserts ?? [];
    const closedServer = await new Promise<number>((ok) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as AddressInfo).port; probe.close(() => ok(port)); }); });
    const notRun = await drive([sceneFile({ url: `http://127.0.0.1:${closedServer}/`, widths: [375], asserts: [{ selector: "h1" }] })]);
    const unreadable = await drive([join(tmpdir(), "lp-r27-no-such-scene.json")]);
    seen.n1754 = { ok: failing.code === 1 && same(fails.map((a: { ok: boolean }) => a.ok), [false, false]) && notRun.code === 2 && unreadable.code === 2, detail: `failed assert exit ${failing.code}, page that never loaded exit ${notRun.code}, unreadable scene exit ${unreadable.code}` };
  } finally { await new Promise<void>((ok) => server.close(() => ok())); }

  const tree = mkdtempSync(join(tmpdir(), "lp-r27-stage-"));
  mkdirSync(join(tree, "src"), { recursive: true });
  mkdirSync(join(tree, "dist"), { recursive: true });
  writeFileSync(join(tree, "src", "app.ts"), "export {};\n");
  writeFileSync(join(tree, "dist", "app.js"), "document.getElementById('root').textContent='staged window';\n");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(tree, "src", "app.ts"), old, old);
  const bare = mkdtempSync(join(tmpdir(), "lp-r27-bare-"));
  try {
    const scene = sceneFile({ url: "http://127.0.0.1:1/", widths: [375], steps: [], asserts: [{ selector: "#root", text: "NOT THE TEXT" }] });
    const staged = await drive(["--stage", "--tree", tree, scene]);
    const refused = await drive(["--stage", "--tree", bare, scene]);
    const stagedUrl = /STAGE_URL=(\S+)/.exec(staged.out)?.[1] ?? "";
    seen.n1741 = { ok: staged.code === 0 && staged.report?.stage === true && staged.report?.url === stagedUrl && /^http:\/\/127\.0\.0\.1:4[2-8]\d\d\/$/.test(stagedUrl) && same(staged.report?.widths?.[0]?.asserts, []) && refused.code === 2 && /no dist\/app\.js/.test(refused.out), detail: `staged ${stagedUrl} exit ${staged.code} with the asserts skipped; a tree with no build exit ${refused.code}` };
  } finally { rmSync(tree, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true }); }
}

function argumentGrammar(): void {
  const throws = (argv: string[]) => { try { parseSceneArgs(argv); return ""; } catch (cause) { return String((cause as Error).message).split("\n")[0]; } };
  const port0 = throws(["--port", "0", "s.json"]), noValue = throws(["--tree"]), two = throws(["a.json", "b.json"]);
  const parsed = parseSceneArgs(["--trees", "a, b ,,kit", "--port", "65535", "s.json"]);
  seen.n1755 = { ok: /port number 1\.\.65535/.test(port0) && /needs a value/.test(noValue) && /one scene file only/.test(two) && same(parsed.trees, ["a", "b", "kit"]) && parsed.port === 65535, detail: `--port 0: «${port0}»; --tree alone: «${noValue}»; two scenes: «${two}»; --trees a, b ,,kit -> ${JSON.stringify(parsed.trees)}` };
}

// ---- the ship verbs on fixture trees ----
function shipVerbs(): void {
  // n1733 doc-audit and n1745 its strict half
  const docs = releaseTree();
  const clean = ship(docs, ["doc-audit"]);
  write(docs.root, "README.md", "# Fixture\n\nRun `bb lane-pilot ghost-verb` and `bb lane-pilot task`.\nSee `src/missing.ts`.\nThe SMA map has 12345 nodes.\n");
  const planted = ship(docs, ["doc-audit"]);
  const found = lines(planted.out);
  seen.n1733 = { ok: clean.status === 0 && planted.status === 1 && found.length === 3 && /ghost-verb/.test(found[0]!) && /src\/missing\.ts/.test(found[1]!) && /12345 nodes/.test(found[2]!), detail: `clean tree exit ${clean.status}; planted tree exit ${planted.status}: ${found.join(" | ")}`.slice(0, 280) };
  const strict = releaseTree();
  write(strict.root, "docs/future.md", front("2099-01-01"));
  write(strict.root, "docs/stale.md", front("2020-01-01"));
  commit(strict.root, "docs");
  const dated = ship(strict, ["doc-audit", "--strict"]);
  rmSync(join(strict.root, "docs/future.md")); rmSync(join(strict.root, "docs/stale.md")); commit(strict.root, "drop");
  write(strict.root, "src/rooms/tools/server/cli-commands.ts", `export const commands = [\n  { name:"task", summary:"a", usage:"" },\n  { name:"phase", summary:"b", usage:"" },\n  { name:"ghostly", summary:"c", usage:"" },\n];\n`);
  write(strict.root, ".agents/ship/doc-coverage-baseline.json", JSON.stringify({ undocumented: 0, verbs: [] }));
  const grew = ship(strict, ["doc-audit", "--strict"]);
  write(strict.root, ".agents/ship/doc-coverage-baseline.json", JSON.stringify({ undocumented: 1, verbs: ["ghostly"] }));
  const within = ship(strict, ["doc-audit", "--strict"]);
  seen.n1745 = { ok: dated.status === 1 && /in the future/.test(dated.out) && /over 30 days behind/.test(dated.out) && grew.status === 1 && /grew 0 -> 1: ghostly/.test(grew.out) && within.status === 0, detail: `dated docs exit ${dated.status} (future and stale named); a new undocumented verb over baseline 0: «${lines(grew.out)[0]}»; within baseline 1: exit ${within.status}` };

  // n1734 vendor, n1746 its rows
  const vendor = releaseTree();
  const first = ship(vendor, ["vendor"]);
  ship(vendor, ["vendor", "triage", "foo", "patch release"]);
  const ledger = JSON.parse(readFileSync(join(vendor.root, ".agents/ship/vendor.json"), "utf8"));
  ship(vendor, ["vendor", "triage", "baz", "new helper"]);
  const done = ship(vendor, ["vendor"]);
  seen.n1734 = { ok: first.status === 1 && lines(first.out).length === 2 && done.status === 0 && /every update since v0\.1\.0 is triaged/.test(done.out), detail: `untriaged: exit ${first.status}, ${lines(first.out).length} lines; after triage exit ${done.status}: «${done.out.trim()}»` };
  seen.n1746 = { ok: same(ledger, { foo: { from: "1.0.0", to: "1.1.0", note: "patch release" }, baz: { from: null, to: "0.1.0" } }), detail: `ledger ${JSON.stringify(ledger)}` };

  // n1747 licenses
  const lic = releaseTree({ deps: { named: "MIT", unnamed: "ISC", copyleft: "GPL-3.0", dual: "MIT OR GPL-3.0" }, notices: "named, copyleft and dual are listed here\n" });
  const licensed = ship(lic, ["licenses"]);
  seen.n1747 = { ok: licensed.status === 1 && same(lines(licensed.out), ["unnamed (ISC) ships but THIRD_PARTY_NOTICES.md does not name it", "copyleft: license GPL-3.0 needs a decision before it ships"]) && existsSync(join(lic.root, ".agents/ship/licenses.tsv")), detail: `exit ${licensed.status}: ${lines(licensed.out).join(" | ")}` };

  // n1742 badge
  const badge = releaseTree();
  const green = join(badge.root, "green.json"), red = join(badge.root, "red.json");
  writeFileSync(green, JSON.stringify({ numPassedTests: 10, numFailedTests: 0, numTotalTests: 10 }));
  writeFileSync(red, JSON.stringify({ numPassedTests: 9, numFailedTests: 1, numTotalTests: 10 }));
  const g = ship(badge, ["badge", green]).out, r = ship(badge, ["badge", red]).out, none = ship(badge, ["badge"]);
  seen.n1742 = { ok: /!\[tests 10\/10\].*tests-10%2F10-brightgreen/.test(g) && /!\[tests 9\/10 · 1 failed\].*-red\)/.test(r) && none.status === 2, detail: `green report -> «${g.slice(0, 70)}…»; one failed -> «${r.slice(0, 80)}…»; no receipt exit ${none.status}` };

  // n1739 the gate (never the checkout's: a fixture tree and a stand-in bb)
  const gate = releaseTree();
  const gateClean = ship(gate, ["gate"], { SERVED: "0.1.0" });
  const noBuild = ship(gate, ["gate"], { BUILD_RC: "1" });
  const unreachable = ship(gate, ["gate"]);
  const both = releaseTree();
  write(both.root, "src/leak.ts", `export const key = "${FAKE_KEY}";\n`);
  write(both.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- everything is faster now\n\n## 0.1.0\n\n- First cut.\n");
  commit(both.root, "leak and promise"); stampReceipt(both);
  const first2 = ship(both, ["gate"], { SERVED: "0.1.0" });
  seen.n1739 = { ok: gateClean.status === 0 && /gate: build, freshness, publishable, licenses, doc-audit and predict-lint all clean/.test(gateClean.out) && noBuild.status === 1 && same(lines(noBuild.out), ["bb plugin build failed"]) && /freshness could not check/.test(unreachable.out) && unreachable.status === 0 && first2.status === 1 && /gate: publishable failed/.test(first2.out) && !/predict-lint/.test(first2.out), detail: `clean tree exit ${gateClean.status}; build failing exit ${noBuild.status}; unreachable hub exit ${unreachable.status} with a warning; leak plus promise stops at «${lines(first2.out).filter((l) => l.startsWith("gate:")).join(" ")}»` };

  // n1743 publishable, n1744 predict-lint, n1749 freshness
  const pub = releaseTree();
  const pubClean = ship(pub, ["publishable", "--strict"]);
  const broken = releaseTree();
  write(broken.root, "package.json", JSON.stringify({ name: "fixture", version: "0.1.0", dependencies: {}, bb: { server: "./server.ts", host: "./host.ts", app: "./app.tsx" } }));
  commit(broken.root, "version back");
  write(broken.root, "CHANGELOG.md", "# Changelog\n\n## 0.0.9\n\n- Older.\n");
  rmSync(join(broken.root, "dist/host.js"));
  const brokenOut = ship(broken, ["publishable", "--strict"]);
  seen.n1743 = { ok: pubClean.status === 0 && brokenOut.status === 1 && /version 0\.1\.0 is not above the last tag v0\.1\.0/.test(brokenOut.out) && /no «## 0\.1\.0» entry/.test(brokenOut.out) && /the tree has uncommitted changes/.test(brokenOut.out) && /dist\/host\.js is not built/.test(brokenOut.out), detail: `clean tree strict exit ${pubClean.status}; broken: ${lines(brokenOut.out).slice(0, 4).join(" | ")}`.slice(0, 290) };

  const lint = releaseTree();
  write(lint.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Startup is faster now.\n- Search no longer times out; measured at 40 ms by the drill.\n- Больше не падает при пустом ответе.\n\n## 0.1.0\n\n- Fewer retries.\n");
  const linted = ship(lint, ["predict-lint"]);
  const lintLines = lines(linted.out);
  write(lint.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Search no longer times out; measured at 40 ms by the drill.\n\n## 0.1.0\n\n- Fewer retries.\n");
  const older = ship(lint, ["predict-lint"]);
  seen.n1744 = { ok: linted.status === 1 && lintLines.filter((l) => l.startsWith("CHANGELOG 0.1.1")).length === 2 && lintLines.some((l) => l.startsWith("warning: CHANGELOG 0.1.0")) && older.status === 0, detail: `newest entry: ${lintLines.filter((l) => l.startsWith("CHANGELOG 0.1.1")).length} unmeasured promises (English and Russian) fail, older entry only warns; exit ${linted.status} then ${older.status}` };

  const fresh = releaseTree();
  const ok1 = ship(fresh, ["freshness", "--strict"], { SERVED: "0.1.1" });
  const other = ship(fresh, ["freshness", "--strict"], { SERVED: "0.1.0" });
  const unpublished = ship(fresh, ["freshness", "--strict", "--unpublished"], { SERVED: "0.1.0" });
  write(fresh.root, "src/rooms/x/ui/panel.tsx", "export {};\n");
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(join(fresh.root, "src/rooms/x/ui/panel.tsx"), future, future);
  const stale = ship(fresh, ["freshness", "--strict", "--unpublished"], { SERVED: "0.1.1" });
  seen.n1749 = { ok: ok1.status === 0 && other.status === 1 && /the hub serves 0\.1\.0, the checkout is 0\.1\.1/.test(other.out) && unpublished.status === 0 && stale.status === 1 && /bundle older than sources: src\/rooms\/x\/ui\/panel\.tsx/.test(stale.out), detail: `fresh bundle exit ${ok1.status}; hub on 0.1.0 exit ${other.status}; unpublished exit ${unpublished.status}; a window source newer than the bundle: «${lines(stale.out).at(-1)}»` };

  // n1735 lane
  const lanes = releaseTree();
  const lane = (base: string) => JSON.parse(ship(lanes, ["lane", base, "--no-record"]).out) as { lane: string };
  const code = lane("v0.1.0").lane;
  write(lanes.root, "docs/guide.md", "# Guide\n"); commit(lanes.root, "docs only");
  const docsLane = lane("HEAD~1").lane;
  write(lanes.root, "host.ts", "export const changed = 1;\n"); commit(lanes.root, "core");
  const fullLane = lane("HEAD~1").lane;
  const rec1 = JSON.parse(ship(lanes, ["lane", "HEAD~1"]).out) as { record: string }, rec2 = JSON.parse(ship(lanes, ["lane", "HEAD~1"]).out) as { record: string };
  seen.n1735 = { ok: code === "batch" && docsLane === "docs" && fullLane === "full" && rec1.record === "recorded" && rec2.record === "already recorded", detail: `ordinary code ${code}, documents only ${docsLane}, a core path ${fullLane}; the record ${rec1.record} then ${rec2.record}` };

  // n1736 batch, n1752 its receipts (n1752 shares the run: the risk filter and the mandatory receipts are one verb)
  const batch = releaseTree();
  const accepted = { state: "accepted", stages: [{ id: "plan-critique", state: "passed" }] };
  todo(batch, "a", { estimate: "1" }); todo(batch, "b", { estimate: "2" });
  taskRecord(batch, "a", accepted); taskRecord(batch, "b", accepted);
  const batchClean = ship(batch, ["batch"]);
  todo(batch, "c", { estimate: "3", owns_paths: "[src/rooms/storage/db.ts]" }); todo(batch, "d", { estimate: "3" });
  taskRecord(batch, "c", accepted); taskRecord(batch, "d", { state: "blocked", stages: [] });
  const mixed = ship(batch, ["batch"]);
  const alone = releaseTree(); todo(alone, "only", { estimate: "1" });
  const lone = ship(alone, ["batch"]);
  seen.n1736 = { ok: batchClean.status === 0 && batchClean.out.trim() === "batch lane: a, b" && lone.out.trim() === "not enough for a batch" && /^c: owns_paths touch the core/.test(lines(mixed.out)[0]!), detail: `two items with receipts «${batchClean.out.trim()}»; a lone item «${lone.out.trim()}»; with a core item: «${lines(mixed.out)[0]}»` };
  seen.n1752 = { ok: mixed.status === 1 && same(lines(mixed.out).slice(1), ["d: missing plan-critique receipt", "d: missing accepted attempt receipt"]), detail: `an item with no plan-critique and no accepted attempt: ${lines(mixed.out).slice(1).join(" | ")} (exit ${mixed.status})` };
}

// ---- explain: the CLI verb and the tripwire ----
async function explain(): Promise<void> {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  registerCli(createCore(bb, openDatabase(bb)), {} as Services, migrations);
  const verb = await harness.behavior.runCli(["explain", "waiting"]);
  const topic = await harness.behavior.runCli(["explain", "graphs"]);
  const unknown = await harness.behavior.runCli(["explain", "no-such-thing"]);
  const [head, ...catalog] = String(unknown.stdout).split("\n");
  seen.n1737 = { ok: String(verb.stdout).startsWith("waiting — verb\n\n") && /\n\ndoc: docs\/guide\/failures\.md$/.test(String(verb.stdout)) && String(topic.stdout).startsWith("graphs — topic\n\n") && String(topic.stdout).includes("doc: docs/guide/graphs.md"), detail: `waiting -> «${String(verb.stdout).split("\n")[0]}» with its doc; graphs -> «${String(topic.stdout).split("\n")[0]}»` };
  const tree = releaseTree();
  write(tree.root, "docs/explainer.md", "---\ntitle: t\nexplains: [n9999999, n1036]\n---\n\n# Explainer\n\nRun `bb lane-pilot task`.\n");
  const tripped = ship(tree, ["explain"]);
  // The checkout's own explainers: every node they explain is proven on this commit.
  const real = ship({ ...tree, root: repoRoot }, ["explain"], { LP_SHIP_ROOT: repoRoot });
  seen.n1753 = { ok: unknown.exitCode === 0 && head === "no explainer for «no-such-thing». Try:" && same(catalog, [...catalog].sort()) && catalog.includes("waiting") && catalog.includes("graphs") && tripped.status === 1 && /explains n9999999, which the SMA map does not have/.test(tripped.out) && /explains n1036 .* no longer proven/.test(tripped.out) && real.status === 0, detail: `unknown word exit ${unknown.exitCode} lists ${catalog.length} names sorted; a planted explainer fails: «${lines(tripped.out).slice(1).join(" | ").slice(0, 150)}»; this commit's explainers: exit ${real.status} «${lines(real.out).at(-1)}»` };
}

// ---- the daily ship watch ----
async function watch(): Promise<void> {
  const repo = mkdtempSync(join(tmpdir(), "lp-r27-pile-"));
  git(repo, "init", "-q", "-b", "main");
  for (let i = 0; i < 31; i++) { git(repo, "commit", "--allow-empty", "-qm", `c${i}`); if (i === 0) git(repo, "tag", "v0.1.0"); }
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  savePrototypeConfig(db, { projectId: "proj_r27", hostId: "host-test", pmWorkspacePath: repo, writerWorkspacePath: repo, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
  const run = (at: { hostId: string; cwd: string }, command: string) => new Promise<{ exitCode: number; stdout: string }>((ok) => { const child = spawn("/bin/bash", ["-c", command], { cwd: at.cwd }); let out = ""; child.stdout.on("data", (chunk) => { out += chunk; }); child.on("close", (code) => ok({ exitCode: code ?? 1, stdout: out })); });
  const swept = await shipWatchSweep(db as never, run);
  const item = db.prepare("SELECT key, kind, what FROM lane_pilot_owner_item WHERE state='open'").all() as Array<{ key: string; kind: string; what: string }>;
  git(repo, "tag", "v0.2.0");
  const after = await shipWatchSweep(db as never, run);
  const left = db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item WHERE state='open'").get() as { n: number };
  // The verb the same watch is behind (lp-ship watch) on a checkout of its own: 30 commits since the tag exit 1.
  const verbTree = mkdtempSync(join(tmpdir(), "lp-r27-watch-"));
  git(verbTree, "init", "-q", "-b", "main");
  for (let i = 0; i < 31; i++) { git(verbTree, "commit", "--allow-empty", "-qm", `c${i}`); if (i === 0) git(verbTree, "tag", "v0.1.0"); }
  writeFileSync(join(verbTree, "package.json"), JSON.stringify({ name: "pile", version: "0.1.0" }));
  const verb = ship({ root: verbTree, bin: join(verbTree, "x"), receipts: join(verbTree, "y") }, ["watch", verbTree]);
  seen.n1751 = { ok: same(swept, { checked: 1, flagged: ["proj_r27"] }) && item.length === 1 && item[0]!.key === "ship-watch:proj_r27:" && item[0]!.kind === "ship_batch" && item[0]!.what.includes("30 commits over 25") && same(after, { checked: 1, flagged: [] }) && left.n === 0 && verb.status === 1 && /30 commits/.test(verb.out), detail: `30 commits since the tag: sweep ${JSON.stringify(swept)} posted ${item.map((row) => row.key).join(",")}; after a tag ${JSON.stringify(after)}, ${left.n} items open; lp-ship watch exit ${verb.status}` };
}

// ---- the checkout itself (the deployed commit): the read-only checks the gate runs ----
function checkout(): Record<string, string> {
  const lint = ship({ root: repoRoot, bin: "", receipts: "" }, ["predict-lint"], { LP_SHIP_ROOT: repoRoot });
  const audit = ship({ root: repoRoot, bin: "", receipts: "" }, ["doc-audit"], { LP_SHIP_ROOT: repoRoot });
  let deployed = "no deploys.log";
  try { const last = readFileSync(join(homedir(), ".lane-pilot/deploys.log"), "utf8").trim().split("\n").at(-1)!.split("\t"); deployed = `deployed ${last[2]} ${last[3]} ${last[4]}, HEAD ${git(repoRoot, "rev-parse", "--short=12", "HEAD")}`; } catch { /* a machine without the log */ }
  return { predictLint: `exit ${lint.status} «${lines(lint.out).at(-1)}»`, docAudit: `exit ${audit.status}, ${lines(audit.out).length} line(s)`, deployed };
}

await windowRun();
argumentGrammar();
shipVerbs();
await explain();
await watch();
process.stdout.write(`${JSON.stringify({ nodes: seen, checkout: checkout() })}\n`);
process.exit(0);
