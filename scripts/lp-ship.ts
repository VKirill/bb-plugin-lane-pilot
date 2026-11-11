/**
 * Shipping and honest numbers (SMA map: Shipping and honest numbers). One command per check a release passes before it goes out:
 *
 *   npx tsx scripts/lp-ship.ts doc-audit        doc honesty audit: every `bb lane-pilot <cmd>` the docs name exists, every repo path they name
 *                                               exists, and the numbers they state about the SMA map match the map
 *   npx tsx scripts/lp-ship.ts vendor [triage <name> <note>]   vendor update ledger: dependency versions changed since the last release
 *                                               tag, each untriaged until it has a note (.agents/ship/vendor.json)
 *   npx tsx scripts/lp-ship.ts licenses         shipped license ledger: every production dependency's license, and THIRD_PARTY_NOTICES names it
 *   npx tsx scripts/lp-ship.ts badge [receipt]  test badge from a receipt: the numbers a vitest JSON report (or the latest drill receipt) proves
 *   npx tsx scripts/lp-ship.ts publishable      is the package publishable: version above the last tag, a CHANGELOG entry for it, a clean
 *                                               tree, the license, the atlas fresh
 *   npx tsx scripts/lp-ship.ts predict-lint     prediction lint before release: a CHANGELOG line of this version that promises an effect
 *                                               («faster», «fewer», «no longer», «быстрее», «меньше», «больше не») names how it is measured
 *   npx tsx scripts/lp-ship.ts explain          explainers with a coverage tripwire: a doc with `explains: [n…]` in its front matter fails when a
 *                                               node it explains is no longer proven on the SMA map
 *   npx tsx scripts/lp-ship.ts lane [base]      ship lanes: docs (docs only — no drill), batch (small changes, the quick drill), full (core,
 *                                               contracts, migrations — the full suite and the full drill)
 *   npx tsx scripts/lp-ship.ts freshness        freshness of the served window: the version the hub serves against this checkout's; the window
 *                                               bundle's own hash (window distribution as its own thing)
 * Exit: 0 clean, 1 findings, 2 could not check.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { smaDonePercent, smaRows, brokenProof, defaultProofRoots } from "../src/rooms/sma-map";
import { leakFindings } from "../tests/helpers/guard-tools";
import { batchItemIsFullLane, batchReceiptGaps, pickBatch, parseTodoMeta, FULL_LANE_PATHS, type TodoMeta } from "../src/rooms/backlog/logic";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const pkg = JSON.parse(read("package.json")) as { version: string; dependencies?: Record<string, string>; license?: string };
const out = (findings: string[], ok: string) => { console.log(findings.length ? findings.join("\n") : ok); return findings.length ? 1 : 0; };

function docs(): string[] {
  const files = ["README.md", "PROJECT.md", ...(existsSync(join(ROOT, "docs")) ? readdirSync(join(ROOT, "docs"), { recursive: true }).map(String).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`) : [])];
  return files.filter((file) => existsSync(join(ROOT, file)));
}

function cliCommands(): Set<string> {
  const text = read("src/rooms/tools/server/cli.ts");
  return new Set([...text.matchAll(/\{ name:"([a-z0-9-]+)"/g)].map((m) => m[1]!));
}

// `--strict` (the gate) adds the date rules and the verb-coverage baseline, which writes .agents/ship/doc-coverage-baseline.json; the plain verb is main's.
function docAudit(args: string[] = []): number {
  const strict = args.includes("--strict");
  const findings: string[] = [];
  const commands = cliCommands();
  const map = smaRows();
  const today = Math.floor(Date.now() / 1000);
  for (const file of docs()) {
    const text = read(file);
    const updated = !strict ? undefined : /^updated:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "")?.[1];
    if (updated) {
      const stamp = Date.parse(`${updated}T00:00:00Z`) / 1000;
      if (stamp > today) findings.push(`${file}: front matter updated: ${updated} is in the future`);
      else {
        // A doc that claims a date far behind its last commit is silently stale (SMA k_lib_docaudit).
        const committed = Number(execFileSync("git", ["log", "-1", "--format=%ct", "--", file], { cwd: ROOT, encoding: "utf8" }).trim() || "0");
        if (committed && committed - stamp > 30 * 86400) findings.push(`${file}: updated: ${updated} is over 30 days behind its last commit`);
      }
    }
    for (const m of text.matchAll(/bb lane-pilot ([a-z][a-z0-9-]+)/g)) if (!commands.has(m[1]!) && !/^(activate|dispatch-bb|finish|cancel|defer|defer-close)$/.test(m[1]!)) findings.push(`${file}: names \`bb lane-pilot ${m[1]}\`, which the CLI does not have`);
    // A decision record keeps the paths of its day: only living documents are held to the code.
    if (!file.startsWith("docs/decisions/")) for (const m of text.matchAll(/`((?:src|scripts|packages|workflows|tests|docs)\/[A-Za-z0-9._/-]+\.[a-z]{1,5})`/g)) if (!existsSync(join(ROOT, m[1]!))) findings.push(`${file}: names ${m[1]}, which does not exist`);
    for (const m of text.matchAll(/(\d{3,5}) (?:nodes|узл)/g)) if (Number(m[1]) !== map.length && /SMA/.test(text)) findings.push(`${file}: says ${m[1]} nodes of the SMA map, the map has ${map.length}`);
  }
  // Coverage of the verbs: every CLI command must appear in some document. The count is kept against a stored baseline,
  // so a newly added undocumented verb fails but the ones already missing today do not (SMA k_lib_docaudit).
  if (strict) {
  const documented = new Set<string>();
  for (const file of docs()) for (const m of read(file).matchAll(/lane-pilot ([a-z][a-z0-9-]+)/g)) documented.add(m[1]!);
  const undocumented = [...commands].filter((name) => !documented.has(name)).sort();
  const baselinePath = join(ROOT, ".agents/ship/doc-coverage-baseline.json");
  const baseline = existsSync(baselinePath) ? (JSON.parse(readFileSync(baselinePath, "utf8")) as { undocumented?: number }).undocumented ?? 0 : null;
  if (baseline === null) {
    mkdirSync(join(ROOT, ".agents/ship"), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify({ undocumented: undocumented.length, verbs: undocumented }, null, 2) + "\n");
  } else if (undocumented.length < baseline) {
    writeFileSync(baselinePath, JSON.stringify({ undocumented: undocumented.length, verbs: undocumented }, null, 2) + "\n");
  } else if (undocumented.length > baseline) {
    findings.push(`undocumented CLI verbs grew ${baseline} -> ${undocumented.length}: ${undocumented.slice(0, 20).join(", ")}`);
  }
  }
  return out(findings, `doc honesty: ${docs().length} documents agree with the code`);
}

function lastTag(): string | null { try { return git("describe", "--tags", "--abbrev=0"); } catch { return null; } }

function vendor(args: string[]): number {
  const ledgerPath = join(ROOT, ".agents/ship/vendor.json");
  const ledger = (existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {}) as Record<string, { from: string | null; to: string; note?: string }>;
  if (args[0] === "triage" && args[1] && args[2]) {
    if (!ledger[args[1]]) { console.log(`no vendor update ${args[1]} in the ledger`); return 2; }
    ledger[args[1]]!.note = args.slice(2).join(" ");
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
    return out([], `triaged ${args[1]}`);
  }
  const tag = lastTag();
  const before = tag ? (JSON.parse(execFileSync("git", ["show", `${tag}:package-lock.json`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64e6 })) as { packages?: Record<string, { version?: string }> }).packages ?? {} : {};
  const now = (JSON.parse(read("package-lock.json")) as { packages?: Record<string, { version?: string }> }).packages ?? {};
  for (const [path, info] of Object.entries(now)) {
    if (!path.startsWith("node_modules/") || path.split("node_modules/").length > 2 || !info.version) continue;
    const name = path.slice("node_modules/".length);
    const from = before[path]?.version ?? null;
    if (from !== info.version && ledger[name]?.to !== info.version) ledger[name] = { from, to: info.version };
  }
  mkdirSync(join(ROOT, ".agents/ship"), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  const untriaged = Object.entries(ledger).filter(([, row]) => !row.note);
  return out(untriaged.slice(0, 50).map(([name, row]) => `untriaged vendor update ${name} ${row.from ?? "new"} → ${row.to} (npx tsx scripts/lp-ship.ts vendor triage ${name} "<why it is fine>")`), `vendor ledger: every update since ${tag ?? "the start"} is triaged`);
}

function licenses(): number {
  const notices = existsSync(join(ROOT, "THIRD_PARTY_NOTICES.md")) ? read("THIRD_PARTY_NOTICES.md") : "";
  const findings: string[] = [];
  const rows: string[] = [];
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const file = join(ROOT, "node_modules", name, "package.json");
    if (!existsSync(file)) continue;
    const license = (JSON.parse(readFileSync(file, "utf8")) as { license?: string }).license ?? "UNKNOWN";
    rows.push(`${name}\t${license}`);
    if (!name.startsWith("@lane-pilot/") && !name.startsWith("@get-bb/") && !notices.includes(name)) findings.push(`${name} (${license}) ships but THIRD_PARTY_NOTICES.md does not name it`);
    // A dual license is shipped under its permissive option; a copyleft-only or unknown one needs a decision first.
    const permissiveOption = license.split(/\s+OR\s+/).some((option) => /^\(?(MIT|ISC|Apache-2\.0|BSD-[23]-Clause|EPL-2\.0|MPL-2\.0|0BSD)\)?$/.test(option.trim()));
    if (/GPL|AGPL|SSPL|UNKNOWN/.test(license) && !/LGPL/.test(license) && !permissiveOption) findings.push(`${name}: license ${license} needs a decision before it ships`);
  }
  mkdirSync(join(ROOT, ".agents/ship"), { recursive: true });
  writeFileSync(join(ROOT, ".agents/ship/licenses.tsv"), rows.join("\n") + "\n");
  return out(findings, `license ledger: ${rows.length} production dependencies, all named`);
}

function badge(args: string[]): number {
  const path = args[0] ?? (() => { const dir = join(ROOT, ".agents/runs/drills"); const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []; return files.length ? join(dir, files.at(-1)!) : null; })();
  if (!path || !existsSync(path)) { console.log("no receipt to make a badge from"); return 2; }
  const data = JSON.parse(readFileSync(path, "utf8")) as { numPassedTests?: number; numFailedTests?: number; numTotalTests?: number; result?: string; scenarios?: Array<{ result: string }> };
  const text = data.numTotalTests !== undefined ? `tests ${data.numPassedTests}/${data.numTotalTests}${data.numFailedTests ? ` · ${data.numFailedTests} failed` : ""}`
    : `drill ${data.scenarios?.filter((s) => s.result === "pass").length ?? 0}/${data.scenarios?.length ?? 0} ${data.result ?? ""}`.trim();
  const color = /failed|fail/.test(text) ? "red" : "brightgreen";
  console.log(`![${text}](https://img.shields.io/badge/${encodeURIComponent(text.split(" ")[0]!)}-${encodeURIComponent(text.split(" ").slice(1).join(" "))}-${color}) <!-- from ${relative(ROOT, path)} sha256 ${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12)} -->`);
  return 0;
}

const vkey = (v: string) => v.replace(/^v/, "").split(".").map(Number);
const newer = (a: string, b: string) => { const x = vkey(a), y = vkey(b); for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };

// `--strict` (the gate) adds the entry-build check and the test-full receipt; the plain verb is main's.
function publishable(args: string[] = []): number {
  const strict = args.includes("--strict");
  const findings: string[] = [];
  const tag = lastTag();
  if (tag && !newer(pkg.version, tag)) findings.push(`version ${pkg.version} is not above the last tag ${tag}`);
  if (!read("CHANGELOG.md").includes(`## ${pkg.version}`)) findings.push(`CHANGELOG.md has no «## ${pkg.version}» entry`);
  if (git("status", "--porcelain", "--untracked-files=no")) findings.push("the tree has uncommitted changes");
  if (!existsSync(join(ROOT, "LICENSE"))) findings.push("no LICENSE");
  // The same scan the test run is red on (SMA m_tl_rebrand_wired): the gate's strict form fails on a leak too; plain stays main's.
  // LP_SHIP_LEAK_ROOT points the scan at another tree (the test plants its probe outside the repository).
  if (strict) for (const hit of leakFindings(process.env.LP_SHIP_LEAK_ROOT || ROOT)) findings.push(`leak scan: ${hit}`);
  try { execFileSync("npx", ["tsx", "scripts/generate-atlas.ts", "--check"], { cwd: ROOT, stdio: "pipe" }); } catch { findings.push("the atlas is stale: npx tsx scripts/generate-atlas.ts"); }
  // Entry files and their builds: the package is publishable only when bb.server/bb.host/bb.app exist, dist/ holds their
  // builds and every dist/*.meta.json agrees with package.json (SMA k_lib_pkgcheck).
  const bbEntries = (pkg as { bb?: Record<string, string> }).bb ?? {};
  for (const slot of strict ? ["server", "host", "app"] : []) {
    const entry = bbEntries[slot];
    if (!entry) { findings.push(`package.json bb.${slot} is not set`); continue; }
    const rel = entry.replace(/^\.\//, "");
    if (!existsSync(join(ROOT, rel))) findings.push(`bb.${slot} entry ${rel} does not exist`);
    const name = rel.replace(/\.[^.]+$/, "");
    if (!existsSync(join(ROOT, "dist", `${name}.js`))) findings.push(`dist/${name}.js is not built`);
    const metaPath = join(ROOT, "dist", `${name}.meta.json`);
    if (!existsSync(metaPath)) findings.push(`dist/${name}.meta.json is missing`);
    else if ((JSON.parse(readFileSync(metaPath, "utf8")) as { pluginVersion?: string }).pluginVersion !== pkg.version) findings.push(`dist/${name}.meta.json pluginVersion is not ${pkg.version}`);
  }
  // The badge is printed from a test-full receipt keyed by tree and node version: without the receipt the badge is a lie.
  if (strict) {
    const receiptsDir = process.env.LP_TEST_RECEIPTS ?? join(process.env.HOME ?? "", ".lane-pilot/test-receipts");
    const key = `${git("rev-parse", "HEAD^{tree}")}-${process.version}`;
    if (!existsSync(join(receiptsDir, key))) findings.push(`no test-full receipt for this tree and ${process.version} (run scripts/test-full.sh)`);
  }
  return out(findings, `publishable: ${pkg.version}`);
}

function predictLint(): number {
  const text = read("CHANGELOG.md");
  const section = text.split(`## ${pkg.version}`)[1]?.split(/\n## /)[0] ?? "";
  const promise = /\b(faster|fewer|less|no longer|never again|быстрее|меньше|больше не|реже)\b/i;
  const measured = /(\d+\s?(ms|s|%|x|раз|мин)|measured|замер|метрик|drill|учени|bench|test)/i;
  const findings = section.split("\n").filter((line) => promise.test(line) && !measured.test(line)).map((line) => `CHANGELOG ${pkg.version}: «${line.trim().slice(0, 140)}» promises an effect without saying how it is measured`);
  return out(findings, `prediction lint: the ${pkg.version} notes measure what they promise`);
}

function explain(): number {
  const rows = new Map(smaRows().map((row) => [row.id, row]));
  const roots = defaultProofRoots(ROOT);
  const findings: string[] = [];
  for (const file of docs()) {
    const head = read(file).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const ids = head.match(/explains:\s*\[([^\]]*)\]/)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    for (const id of ids) {
      const row = rows.get(id);
      if (!row) findings.push(`${file} explains ${id}, which the SMA map does not have`);
      else if (!row.proof || brokenProof(row.proof, roots)) findings.push(`${file} explains ${id} «${row.label}», which is no longer proven — the explainer is out of date`);
    }
  }
  // Coverage line (SMA k_lib_explain): CLI verbs no explainer names. Reported, never a finding.
  const cli = readFileSync(join(ROOT, "src/rooms/tools/server/cli.ts"), "utf8");
  const verbs = [...cli.matchAll(/name:\s*"([a-z][a-z0-9-]*)"\s*,\s*summary:/g)].map((m) => m[1]!);
  const uncovered = verbs.filter((verb) => !docs().some((file) => { const text = read(file); return text.includes(`lane-pilot ${verb}`) || text.includes(`\`${verb}\``); }));
  console.log(`explain coverage: ${verbs.length - uncovered.length}/${verbs.length} CLI verbs have an explainer${uncovered.length ? ` (missing: ${uncovered.slice(0, 20).join(", ")}${uncovered.length > 20 ? "…" : ""})` : ""}`);
  return out(findings, `explainers: every node they explain is proven (map ${smaDonePercent(smaRows())}%)`);
}

// Called the old way (`lane [base]`) it prints main's four fields and writes nothing; `--record` (with an optional `--cwd <repo>`)
// also drafts the changelog entry and keeps one record per (base, head) in .agents/ship/lanes.jsonl (SMA k_v_shiplane).
function lane(args: string[]): number {
  const record = args.includes("--record");
  const cwd = args.includes("--cwd") ? args[args.indexOf("--cwd") + 1]! : ROOT;
  const gitIn = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
  const positional = args.filter((a, i) => a !== "--cwd" && a !== "--record" && args[i - 1] !== "--cwd");
  const base = positional[0] ?? lastTag() ?? "HEAD~1";
  const files = gitIn("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const full = files.filter((file) => FULL_LANE_PATHS.test(file));
  const code = files.filter((file) => !/^(docs\/|.*\.md$|\.agents\/)/.test(file));
  const chosen = !code.length ? "docs" : full.length ? "full" : "batch";
  const why = chosen === "docs" ? "only documents changed: no drill" : chosen === "full" ? `core paths changed (${full.slice(0, 5).join(", ")}): full suite and full drill` : "code outside the core: the middle batch lane, quick drill";
  if (!record) { console.log(JSON.stringify({ base, files: files.length, lane: chosen, why }, null, 1)); return 0; }
  const head = gitIn("rev-parse", "HEAD");
  const subjects = gitIn("log", `${base}..HEAD`, "--format=%s").split("\n").filter(Boolean);
  const draft = `## ${pkg.version}\n\n${subjects.map((line) => `- ${line}`).join("\n")}`;
  const ledgerPath = join(cwd, ".agents/ship/lanes.jsonl");
  const seen = existsSync(ledgerPath) && readFileSync(ledgerPath, "utf8").split("\n").some((line) => { try { const row = JSON.parse(line) as { base?: string; head?: string }; return row.base === base && row.head === head; } catch { return false; } });
  if (!seen) {
    mkdirSync(join(cwd, ".agents/ship"), { recursive: true });
    writeFileSync(ledgerPath, (existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "") + JSON.stringify({ at: new Date().toISOString(), base, head, lane: chosen, files: files.length, why }) + "\n");
  }
  console.log(JSON.stringify({ base, files: files.length, lane: chosen, why, changelogDraft: draft, record: seen ? "already recorded" : "recorded" }, null, 1));
  return 0;
}

function backlogItems(): TodoMeta[] {
  const dir = join(ROOT, ".agents/todos/items");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((slug) => { const meta = join(dir, slug, "meta.yaml"); return existsSync(meta) ? parseTodoMeta(readFileSync(meta, "utf8")) : null; }).filter((item): item is TodoMeta => item !== null);
}

function batch(args: string[]): number {
  const max = args.includes("--max") ? Number(args[args.indexOf("--max") + 1]) || 4 : 4;
  const chosen = pickBatch(backlogItems(), max);
  if (chosen.length < 2) { console.log("not enough for a batch"); return 0; }
  // The middle lane: a core-path item goes to the full lane, and every item that ships has a plan-critique receipt and an
  // accepted attempt on record — the light challenge and the mandatory receipts of the batch lane (SMA k_v_batch/k_lib_batch).
  const findings: string[] = [];
  for (const item of chosen) {
    if (batchItemIsFullLane(item)) { findings.push(`${item.id}: owns_paths touch the core, it ships the full lane, not a batch`); continue; }
    let record: { state?: string; stages?: Array<{ id?: string; state?: string }> } | null = null;
    try { record = JSON.parse(execFileSync("bb", ["lane-pilot", "task", item.id, "--json"], { cwd: ROOT, encoding: "utf8" })) as typeof record; } catch { record = null; }
    for (const gap of batchReceiptGaps(record)) findings.push(`${item.id}: missing ${gap}`);
  }
  return out(findings, `batch lane: ${chosen.map((item) => item.id).join(", ")}`);
}

function gate(): number {
  // The publish gate (SMA k_v_prepublish): window build first, then the strict package check, the license scanner and the
  // prediction lint, in this order, stopping at the first failure.
  try { execFileSync(process.env.BB_CLI || "bb", ["plugin", "build"], { cwd: ROOT, stdio: "inherit" }); }
  catch { console.log("bb plugin build failed"); return 1; }
  for (const [name, step, flags] of [["publishable", publishable, ["--strict"]], ["licenses", licenses, []], ["doc-audit", docAudit, ["--strict"]], ["predict-lint", predictLint, []]] as const) {
    const rc = step([...flags]);
    if (rc !== 0) { console.log(`gate: ${name} failed`); return rc; }
  }
  console.log("gate: build, publishable, licenses, doc-audit and predict-lint all clean");
  return 0;
}

function watch(args: string[]): number {
  // Cadence against hundred-commit batches (SMA k_lib_shiplane): commits and days since the last tag over
  // ship.max_batch_commits (25) / ship.max_batch_days (3) is a finding.
  const cwd = args[0] ?? ROOT;
  const gitIn = (...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
  const maxCommits = Number(process.env.LP_SHIP_MAX_BATCH_COMMITS ?? 25);
  const maxDays = Number(process.env.LP_SHIP_MAX_BATCH_DAYS ?? 3);
  let tag: string | null = null;
  try { tag = gitIn("describe", "--tags", "--abbrev=0"); } catch { tag = null; }
  const commits = Number(gitIn("rev-list", "--count", tag ? `${tag}..HEAD` : "HEAD"));
  const tagTime = tag ? Number(gitIn("log", "-1", "--format=%ct", tag)) : Number(gitIn("log", "--format=%ct", "--reverse").split("\n")[0] || "0");
  const days = Math.floor((Date.now() / 1000 - tagTime) / 86400);
  const findings: string[] = [];
  if (commits > maxCommits) findings.push(`${commits} commits since ${tag ?? "the start"} — over ship.max_batch_commits ${maxCommits}: ship a batch`);
  if (days > maxDays) findings.push(`${days} days since ${tag ?? "the start"} — over ship.max_batch_days ${maxDays}: ship a batch`);
  return out(findings, `ship watch: ${commits} commits, ${days} days since ${tag ?? "the start"}`);
}

function windowSources(): string[] {
  const roots = [join(ROOT, "src/rooms"), join(ROOT, "packages/ui-kit")];
  const files: string[] = ["app.tsx", "app.css"].map((f) => join(ROOT, f)).filter(existsSync);
  for (const base of roots) {
    if (!existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name === "ui" || path.startsWith(join(ROOT, "packages/ui-kit"))) stack.push(path); }
        else if (/\.(tsx?|css)$/.test(entry.name)) files.push(path);
      }
    }
  }
  return files;
}

// `--strict` (the gate) adds the stale-bundle check; plain, the exit is main's: 2 hub unreachable, 1 version differs, 0 same.
function freshness(args: string[] = []): number {
  const strict = args.includes("--strict");
  const findings: string[] = [];
  let served: string | null = null;
  try { served = (JSON.parse(execFileSync("bb", ["plugin", "list", "--json"], { encoding: "utf8", env: { ...process.env, BB_CLI: "" } })) as Array<{ id: string; version?: string }>).find((p) => p.id === "lane-pilot")?.version ?? null; } catch { served = null; }
  const bundle = join(ROOT, "dist", "app.js");
  const sha = existsSync(bundle) ? createHash("sha256").update(readFileSync(bundle)).digest("hex").slice(0, 16) : null;
  console.log(JSON.stringify({ checkout: pkg.version, served, windowBundle: sha ? `dist/app.js ${sha}` : "not built" }));
  if (!strict) return served === null ? 2 : served === pkg.version ? 0 : 1;
  if (served !== null && served !== pkg.version) findings.push(`the hub serves ${served}, the checkout is ${pkg.version}`);
  // The one ruler (SMA k_lib_spafresh): is the bundle behind its sources, by mtime or by git's last commit.
  if (existsSync(bundle)) {
    const bundleTime = statSync(bundle).mtimeMs / 1000;
    const stale = windowSources().filter((file) => statSync(file).mtimeMs / 1000 > bundleTime);
    try {
      const committed = Number(execFileSync("git", ["log", "-1", "--format=%ct", "--", "app.tsx", "app.css", "src/rooms", "packages/ui-kit"], { cwd: ROOT, encoding: "utf8" }).trim() || "0");
      if (committed > bundleTime) stale.push(`git:last-commit ${new Date(committed * 1000).toISOString().slice(0, 10)}`);
    } catch { /* no commits yet */ }
    if (stale.length) findings.push(`bundle older than sources: ${stale.slice(0, 5).map((f) => relative(ROOT, f)).join(", ")}`);
  }
  const metaPath = join(ROOT, "dist", "app.meta.json");
  if (existsSync(metaPath) && (JSON.parse(readFileSync(metaPath, "utf8")) as { pluginVersion?: string }).pluginVersion !== pkg.version)
    findings.push(`dist/app.meta.json pluginVersion is not ${pkg.version}`);
  if (findings.length) { console.log(findings.join("\n")); return 1; }
  return served === null ? 2 : 0;
}

const [command, ...rest] = process.argv.slice(2);
const table: Record<string, (args: string[]) => number> = { "doc-audit": docAudit, vendor, licenses, badge, publishable, "predict-lint": predictLint, explain, lane, freshness, batch, gate, watch };
const run = table[command ?? ""];
if (!run) { console.error(`usage: npx tsx scripts/lp-ship.ts ${Object.keys(table).join("|")}`); process.exit(2); }
process.exit(run(rest));
