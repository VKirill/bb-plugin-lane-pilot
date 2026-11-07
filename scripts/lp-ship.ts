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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { smaDonePercent, smaRows, brokenProof, defaultProofRoots } from "../src/rooms/sma-map";

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

function docAudit(): number {
  const findings: string[] = [];
  const commands = cliCommands();
  const map = smaRows();
  for (const file of docs()) {
    const text = read(file);
    for (const m of text.matchAll(/bb lane-pilot ([a-z][a-z0-9-]+)/g)) if (!commands.has(m[1]!) && !/^(activate|dispatch-bb|finish|cancel|defer|defer-close)$/.test(m[1]!)) findings.push(`${file}: names \`bb lane-pilot ${m[1]}\`, which the CLI does not have`);
    // A decision record keeps the paths of its day: only living documents are held to the code.
    if (!file.startsWith("docs/decisions/")) for (const m of text.matchAll(/`((?:src|scripts|packages|workflows|tests|docs)\/[A-Za-z0-9._/-]+\.[a-z]{1,5})`/g)) if (!existsSync(join(ROOT, m[1]!))) findings.push(`${file}: names ${m[1]}, which does not exist`);
    for (const m of text.matchAll(/(\d{3,5}) (?:nodes|узл)/g)) if (Number(m[1]) !== map.length && /SMA/.test(text)) findings.push(`${file}: says ${m[1]} nodes of the SMA map, the map has ${map.length}`);
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

function publishable(): number {
  const findings: string[] = [];
  const tag = lastTag();
  if (tag && !newer(pkg.version, tag)) findings.push(`version ${pkg.version} is not above the last tag ${tag}`);
  if (!read("CHANGELOG.md").includes(`## ${pkg.version}`)) findings.push(`CHANGELOG.md has no «## ${pkg.version}» entry`);
  if (git("status", "--porcelain", "--untracked-files=no")) findings.push("the tree has uncommitted changes");
  if (!existsSync(join(ROOT, "LICENSE"))) findings.push("no LICENSE");
  try { execFileSync("npx", ["tsx", "scripts/generate-atlas.ts", "--check"], { cwd: ROOT, stdio: "pipe" }); } catch { findings.push("the atlas is stale: npx tsx scripts/generate-atlas.ts"); }
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
  return out(findings, `explainers: every node they explain is proven (map ${smaDonePercent(smaRows())}%)`);
}

function lane(args: string[]): number {
  const base = args[0] ?? lastTag() ?? "HEAD~1";
  const files = git("diff", "--name-only", `${base}...HEAD`).split("\n").filter(Boolean);
  const full = files.filter((file) => /^(src\/rooms\/(contracts|storage|core)\/|packages\/contracts\/|host\.ts|server\.ts|.*migrations?\.ts)/.test(file));
  const code = files.filter((file) => !/^(docs\/|.*\.md$|\.agents\/)/.test(file));
  const chosen = !code.length ? "docs" : full.length ? "full" : "batch";
  console.log(JSON.stringify({ base, files: files.length, lane: chosen, why: chosen === "docs" ? "only documents changed: no drill" : chosen === "full" ? `core paths changed (${full.slice(0, 5).join(", ")}): full suite and full drill` : "code outside the core: the middle batch lane, quick drill" }, null, 1));
  return 0;
}

function freshness(): number {
  let served: string | null = null;
  try { served = (JSON.parse(execFileSync("bb", ["plugin", "list", "--json"], { encoding: "utf8", env: { ...process.env, BB_CLI: "" } })) as Array<{ id: string; version?: string }>).find((p) => p.id === "lane-pilot")?.version ?? null; } catch { served = null; }
  const bundle = join(ROOT, "dist", "app.js");
  const sha = existsSync(bundle) ? createHash("sha256").update(readFileSync(bundle)).digest("hex").slice(0, 16) : null;
  console.log(JSON.stringify({ checkout: pkg.version, served, windowBundle: sha ? `dist/app.js ${sha}` : "not built" }));
  if (served === null) return 2;
  return served === pkg.version ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
const table: Record<string, (args: string[]) => number> = { "doc-audit": docAudit, vendor, licenses, badge, publishable, "predict-lint": predictLint, explain, lane, freshness };
const run = table[command ?? ""];
if (!run) { console.error(`usage: npx tsx scripts/lp-ship.ts ${Object.keys(table).join("|")}`); process.exit(2); }
process.exit(run(rest));
