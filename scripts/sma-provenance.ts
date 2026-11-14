/**
 * Writes src/rooms/sma-map/provenance.json: per map node with a proof in this repository, the commit that last changed
 * its proof anchor (git blame over the anchor's span — symbol level — or the file's last commit), the first plugin
 * version that shipped that commit and that version's deploy time, read from the deploy log.
 *   npx tsx scripts/sma-provenance.ts [--check] [--deploys <path>]   (default ~/.lane-pilot/deploys.log)
 * The deploy log is tab-separated: ISO time, day, version, sha (12), kind, …; a commit ships in the first deploy (in
 * time order) whose sha contains it (`git rev-list <deploy> ^<previous deploy>`). Run it on the machine that deploys
 * (OVH), before a deploy and after authoring evidence; --check exits 1 when the file is stale.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { SMA_NODES } from "../src/rooms/sma-map/graph";
import { anchorText, hash12, localProof, type OwnChange } from "../src/rooms/sma-map/provenance";

const root = join(import.meta.dirname, "..");
const target = join(root, "src/rooms/sma-map/provenance.json");
const flag = (name: string) => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });

type Deploy = { at: number; version: string; sha: string };
function readDeploys(path: string): Deploy[] {
  if (!existsSync(path)) throw new Error(`no deploy log at ${path} (pass --deploys <path>)`);
  const out: Deploy[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [iso, , version, sha] = line.split("\t");
    if (!iso || !version || !sha || !/^[0-9a-f]{7,40}$/.test(sha)) continue;
    const at = Date.parse(iso.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
    if (Number.isFinite(at)) out.push({ at, version, sha });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** commit (full sha) → the first deploy that contains it. */
function firstDeploys(deploys: readonly Deploy[]): Map<string, Deploy> {
  const first = new Map<string, Deploy>();
  let prev: string | null = null;
  for (const deploy of deploys) {
    let full: string;
    try { full = git("rev-parse", "--verify", "--quiet", `${deploy.sha}^{commit}`).trim(); } catch { continue; }
    const listed = git("rev-list", full, ...(prev ? [`^${prev}`] : [])).split("\n").filter(Boolean);
    for (const commit of listed) if (!first.has(commit)) first.set(commit, deploy);
    prev = full;
  }
  return first;
}

const blameCache = new Map<string, Array<{ commit: string; time: number }>>();
/** Per line (1-based) of `file` at HEAD: the commit that last changed it and its committer time. */
function blame(file: string): Array<{ commit: string; time: number }> {
  const cached = blameCache.get(file);
  if (cached) return cached;
  const lines: Array<{ commit: string; time: number }> = [];
  const times = new Map<string, number>();
  let current = "";
  for (const line of git("blame", "--porcelain", "HEAD", "--", file).split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (head) { current = head[1]!; lines[Number(head[2])] = { commit: current, time: times.get(current) ?? 0 }; continue; }
    const time = /^committer-time (\d+)/.exec(line);
    if (time) times.set(current, Number(time[1]) * 1000);
  }
  for (const entry of lines) if (entry) entry.time = times.get(entry.commit) ?? entry.time;
  blameCache.set(file, lines);
  return lines;
}

const fileCache = new Map<string, { commit: string; time: number } | null>();
function lastFileCommit(file: string): { commit: string; time: number } | null {
  if (!fileCache.has(file)) {
    const out = git("log", "-1", "--format=%H %ct", "HEAD", "--", file).trim();
    fileCache.set(file, out ? { commit: out.split(" ")[0]!, time: Number(out.split(" ")[1]) * 1000 } : null);
  }
  return fileCache.get(file)!;
}

export function generate(deploysPath: string): string {
  const deploys = readDeploys(deploysPath);
  const shipped = firstDeploys(deploys);
  const head = git("rev-parse", "HEAD").trim();
  const nodes: Array<[string, OwnChange]> = [];
  for (const [id] of SMA_NODES) {
    const proof = SMA_ENTRIES[id]?.[2];
    if (!localProof(proof)) continue;
    const anchor = anchorText(root, proof);
    if (!anchor) continue;
    let change: { commit: string; time: number } | null = null;
    if (anchor.level === "symbol" && anchor.start && anchor.end) {
      const lines = blame(anchor.file);
      for (let line = anchor.start; line <= anchor.end; line++) {
        const hit = lines[line];
        if (hit && (!change || hit.time > change.time)) change = hit;
      }
    }
    change ??= lastFileCommit(anchor.file);
    if (!change) continue;
    const deploy = shipped.get(change.commit) ?? null;
    nodes.push([id, [change.commit.slice(0, 12), change.time, deploy?.version ?? null, deploy?.at ?? null, anchor.level, hash12(anchor.text)]]);
  }
  nodes.sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const lastDeployed = deploys.at(-1)?.version ?? "";
  return `{"generatedFrom":${JSON.stringify(head.slice(0, 12))},"version":${JSON.stringify(version)},"deploys":${deploys.length},"lastDeployed":${JSON.stringify(lastDeployed)},"nodes":{\n${nodes.map(([id, rec]) => `${JSON.stringify(id)}:${JSON.stringify(rec)}`).join(",\n")}\n}}\n`;
}

if (process.argv[1]?.endsWith("sma-provenance.ts")) {
  const out = generate(flag("--deploys") ?? join(homedir(), ".lane-pilot", "deploys.log"));
  // The header names the commit it was generated on; staleness is about the nodes, so --check compares those.
  const body = (text: string) => text.slice(text.indexOf("\"nodes\""));
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf8") : "";
    if (body(current) !== body(out)) { process.stderr.write("src/rooms/sma-map/provenance.json is stale: run npx tsx scripts/sma-provenance.ts\n"); process.exit(1); }
  } else {
    writeFileSync(target, out);
    process.stdout.write(`${(out.match(/\n"n\d+"/g) ?? []).length} node change points -> src/rooms/sma-map/provenance.json\n`);
  }
}
