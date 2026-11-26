#!/usr/bin/env node
// Summarizes Vitest's per-file duration cache (node_modules/.vite/vitest/*/results.json or a given file).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let asJson = false, topN = 30, rawPath = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") asJson = true;
  else if (arg === "--top") topN = Number(args[++i]);
  else if (arg.startsWith("--top=")) topN = Number(arg.slice(6));
  else if (arg === "-h" || arg === "--help") {
    console.log("Usage: node scripts/test-timing.mjs [results.json] [--top N] [--json]");
    process.exit(0);
  } else if (!arg.startsWith("-") && !rawPath) rawPath = arg;
  else fail(`Unknown argument: ${arg}`);
}

function fail(msg) { console.error(msg); process.exit(1); }
if (!Number.isInteger(topN) || topN < 1) fail(`Invalid --top value: ${topN}`);

function findDefaultCache() {
  const dir = join(root, "node_modules/.vite/vitest");
  const hits = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(dir, d.name, "results.json"))
        .filter((p) => existsSync(p))
    : [];
  if (hits.length !== 1) fail(hits.length === 0 ? "No Vitest results.json found; run vitest or pass a path." : `Expected 1 results.json, found ${hits.length}; pass a path.`);
  return hits[0];
}

const cachePath = rawPath ? resolve(process.cwd(), rawPath) : findDefaultCache();
if (!existsSync(cachePath)) fail(`Results file not found: ${cachePath}`);

const data = JSON.parse(readFileSync(cachePath, "utf8"));
const cachedEntries = Array.isArray(data.results) ? data.results.length : 0;
const entries = (data.results ?? [])
  .map(([key, meta]) => {
    const sep = key.indexOf(":");
    return {
      project: sep === -1 ? "" : key.slice(0, sep),
      file: (sep === -1 ? key : key.slice(sep + 1)).replace(/\\/g, "/"),
      ms: Number(meta?.duration) || 0,
      failed: Boolean(meta?.failed),
    };
  })
  .filter((e) => existsSync(join(root, e.file)))
  .sort((a, b) => b.ms - a.ms);

const totalMs = entries.reduce((sum, e) => sum + e.ms, 0);
const round = (n) => Number(n.toFixed(1));
const sharePct = (k) => (totalMs > 0 ? round((entries.slice(0, k).reduce((s, e) => s + e.ms, 0) / totalMs) * 100) : 0);
const shares = { top10: sharePct(10), top30: sharePct(30), top100: sharePct(100), top300: sharePct(300) };

const byFolder = new Map();
for (const e of entries) {
  const folder = e.file.split("/").slice(0, 2).join("/");
  const prev = byFolder.get(folder) ?? { folder, ms: 0, files: 0 };
  prev.ms += e.ms;
  prev.files += 1;
  byFolder.set(folder, prev);
}
const folders = [...byFolder.values()].sort((a, b) => b.ms - a.ms).slice(0, 12)
  .map(({ folder, ms, files }) => ({ folder, seconds: round(ms / 1000), files }));
const top = entries.slice(0, topN).map(({ file, project, ms, failed }) => ({ file, project, seconds: round(ms / 1000), failed }));
const report = { files: entries.length, cachedEntries, totalSeconds: round(totalMs / 1000), shares, folders, top };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.files} files (of ${report.cachedEntries} cached), ${report.totalSeconds} s total`);
  console.log(`shares: top 10 = ${Math.round(shares.top10)}%, top 30 = ${Math.round(shares.top30)}%, top 100 = ${Math.round(shares.top100)}%, top 300 = ${Math.round(shares.top300)}%`);
  console.log("top 12 folders:");
  for (const f of folders) console.log(`  ${f.seconds.toFixed(1).padStart(6)} s  ${f.folder} (${f.files})`);
  console.log(`top ${topN} files:`);
  for (const t of top) console.log(`  ${t.seconds.toFixed(1).padStart(6)} s  ${t.project}:${t.file}${t.failed ? " [FAILED]" : ""}`);
}
