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
import { anchorText, hash12, localProof, siblingAnchorSpan, type OwnChange, type ProvenanceFile, type SiblingChange } from "../src/rooms/sma-map/provenance";
import { blameAt, hasCommit, headOf, isAncestor, kindAt, lastCommitAt, showAt } from "../src/rooms/sma-map/sibling-git";
import { resolveSibling, SIBLING_NAMES, SIBLINGS, siblingOf, splitSiblingPath, type SiblingName } from "../src/rooms/sma-map/siblings";

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
  let blamed: string;
  try { blamed = git("blame", "--porcelain", "HEAD", "--", file); } catch (cause) {
    throw new Error(`${file} is not in HEAD (${cause instanceof Error ? cause.message.split("\n")[0] : cause}): this script reads COMMITTED history. Commit moved and new files first, then run npm run sma:facts.`);
  }
  for (const line of blamed.split("\n")) {
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

export function generate(deploysPath: string, check = false): string {
  const deploys = readDeploys(deploysPath);
  const shipped = firstDeploys(deploys);
  const head = git("rev-parse", "HEAD").trim();
  const uncommitted = git("status", "--porcelain", "--untracked-files=all", "--", "src", "tests", "scripts", "packages").split("\n").filter((line) => line && !/src\/rooms\/sma-map\/(provenance|hollow-facts|contracts)/.test(line));
  if (uncommitted.length) process.stderr.write(`warning: ${uncommitted.length} uncommitted path(s) (e.g. ${uncommitted[0]!.trim()}): change points are read from HEAD, so commit moved and new files BEFORE npm run sma:facts.\n`);
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
  const { at, records } = siblingChanges(check);
  const siblings = Object.entries(records).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)));
  return `{"generatedFrom":${JSON.stringify(head.slice(0, 12))},"version":${JSON.stringify(version)},"deploys":${deploys.length},"lastDeployed":${JSON.stringify(lastDeployed)},"nodes":{\n${nodes.map(([id, rec]) => `${JSON.stringify(id)}:${JSON.stringify(rec)}`).join(",\n")}\n},"siblingsAt":${JSON.stringify(at)},"siblings":{\n${siblings.map(([id, rec]) => `${JSON.stringify(id)}:${JSON.stringify(rec)}`).join(",\n")}\n}}\n`;
}

/**
 * Change points of nodes whose proof anchor is in a sibling repository (siblings.ts): the newest commit touching the anchor's
 * span, read from git at a pinned commit per sibling (`siblingsAt`). Generating moves the pin to the sibling's HEAD only when
 * HEAD contains it; --check re-reads at the pin; a sibling absent here (or without the pinned commit) keeps its recorded
 * records, so the file stays valid on the hub and is re-checked where the siblings are (the deploy gate on OVH).
 */
function siblingChanges(check: boolean): { at: Partial<Record<SiblingName, string>>; records: Record<string, SiblingChange> } {
  const recordedFile = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) as ProvenanceFile : null;
  const at: Partial<Record<SiblingName, string>> = {};
  const records: Record<string, SiblingChange> = {};
  for (const name of SIBLING_NAMES) {
    const ids = SMA_NODES.map(([id]) => id).filter((id) => siblingOf(SMA_ENTRIES[id]?.[2]) === name);
    const pinned = recordedFile?.siblingsAt?.[name];
    const keep = (why: string) => {
      process.stderr.write(`note: ${why}: kept the recorded change points of ${SIBLINGS[name].repo}${pinned ? ` at ${pinned}` : ""}\n`);
      if (pinned) at[name] = pinned;
      for (const id of ids) { const rec = recordedFile?.siblings?.[id]; if (rec) records[id] = rec; }
    };
    const where = resolveSibling(name, root);
    if (where.root === null) { keep(where.why); continue; }
    if (pinned && !hasCommit(where.root, pinned)) { keep(`${where.root} has no commit ${pinned}`); continue; }
    const head = headOf(where.root);
    const pin = check || !head || (pinned && !isAncestor(where.root, pinned, head)) ? pinned : head;
    if (!pin) continue;
    at[name] = pin;
    for (const id of ids) {
      const [anchorPath, symbol] = splitSiblingPath(SMA_ENTRIES[id]![2]!).path.split("#", 2) as [string, string | undefined];
      const path = anchorPath.replace(/:\d+$/, "").replace(/\/$/, "");
      const kind = kindAt(where.root, pin, path);
      if (!kind) continue;
      // A folder anchor (a component folder of the app): its last commit; no span to blame.
      const text = kind === "blob" ? showAt(where.root, pin, path)! : "";
      const span = kind === "blob" ? siblingAnchorSpan(text, symbol) : { level: "file" as const, start: 0, end: 0, text: `${path}/` };
      let change: { commit: string; time: number } | null = null;
      if (span.level !== "file") {
        const lines = blameAt(where.root, pin, path) ?? [];
        for (let line = span.start; line <= span.end; line++) { const hit = lines[line]; if (hit && (!change || hit.time > change.time)) change = hit; }
      }
      change ??= lastCommitAt(where.root, pin, path);
      if (change) records[id] = [name, change.commit.slice(0, 12), change.time, span.level, hash12(span.text)];
    }
  }
  return { at, records };
}

if (process.argv[1]?.endsWith("sma-provenance.ts")) {
  const out = generate(flag("--deploys") ?? join(homedir(), ".lane-pilot", "deploys.log"), process.argv.includes("--check"));
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
