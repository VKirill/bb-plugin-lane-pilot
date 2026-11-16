import { createHash, randomUUID } from "node:crypto";
import { runOnHost } from "@lane-pilot/host-calls";
import type { ServerCore } from "../../contracts/server";
import { gitRepoSnapshot, type RepoSnapshot } from "../../verification/server";

// This adapter intentionally accepts only the Node version whose reporter stream was examined.
const RUNNER_VERSION = "24.15.0";
const MAX_REPORT = 8 * 1024 * 1024;
const reporter = `export default async function* (source) {
  for await (const e of source) if (["test:start", "test:pass", "test:fail", "test:summary"].includes(e.type)) {
    const d = e.data;
    if (d.details?.error) { const x = d.details.error; d.details.error = {name:x.name,message:x.message,code:x.code,failureType:x.failureType}; }
    yield JSON.stringify({type:e.type,data:d}) + "\\n";
  }
  yield JSON.stringify({type:"lp:end"}) + "\\n";
}`;

// Executes on the checkout host. globSync is deliberately bounded to plain relative paths/globs.
const runner = `const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const nonce = process.argv[2], reporter = Buffer.from(process.argv[3], 'base64').toString();
const emit = x => process.stdout.write(JSON.stringify(x) + '\\n');
try {
 const version = process.versions.node;
 const environment = require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(process.env).filter(([k]) => !['_','SHLVL'].includes(k)).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
 const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
 const command = pkg.scripts?.test;
 if (version !== '${RUNNER_VERSION}' || typeof command !== 'string' || !/^node --test(?: +[A-Za-z0-9_./*?-]+)+ *$/.test(command)) { emit({type:'lp:unsupported',version,command}); process.exit(0); }
 const args = command.trim().split(/ +/).slice(2), root = fs.realpathSync('.');
 if (args.some(x => x.startsWith('/') || x.split('/').includes('..'))) throw Error('unsafe test path');
 const files = [...new Set(args.flatMap(x => fs.globSync(x)))].sort().map(x => fs.realpathSync(x));
 if (!files.length || files.some(x => !x.startsWith(root + path.sep) || !fs.statSync(x).isFile())) throw Error('empty or unsafe file selection');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-inventory-'));
 try {
  const rp = path.join(dir, 'reporter.mjs'); fs.writeFileSync(rp, reporter);
  emit({type:'lp:begin',nonce,version,command,root,files,environment});
  const run = cp.spawnSync(process.execPath, ['--test','--test-concurrency=1','--test-reporter='+rp,...files], {encoding:'utf8',maxBuffer:${MAX_REPORT},timeout:120000});
  if (run.error || run.signal || run.status === null) throw Error('runner interrupted: ' + (run.error?.message || run.signal));
  process.stdout.write(run.stdout); emit({type:'lp:exit',nonce,exit:run.status});
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
} catch(e) { emit({type:'lp:error',message:String(e.message)}); }`;

export type InventoryCase = { file: string; identity: string; result: "passed" | "failed" | "skipped" | "todo" | "expected_failure" | "cancelled" };
export type InventoryReceipt = { nonce: string; hostId: string; root: string; command: string; version: string; environment: string; files: string[]; exit: number; before: RepoSnapshot; after: RepoSnapshot; sha256: string; raw: string; cases: InventoryCase[]; parentTests: number };
export type InventoryResult = { status: "measured"; receipt: InventoryReceipt } | { status: "unsupported" | "unavailable"; reason: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sameSnapshot = (a: RepoSnapshot | null, b: RepoSnapshot | null) => !!a && !!b && !!a.head && !!a.workDiffHash && !!a.indexDiffHash && a.hostId === b.hostId && a.root === b.root && a.head === b.head && a.workDiffHash === b.workDiffHash && a.indexDiffHash === b.indexDiffHash && a.files.length === 0 && b.files.length === 0;

type EventData = { file?: string; name?: string; line?: number; nesting?: number; skip?: unknown; todo?: unknown; expectFailure?: unknown; details?: { type?: string; error?: { failureType?: string } }; counts?: Record<string, number> };
type Event = { type: string; data: EventData };

export function parseInventory(raw: string, expectedNonce: string): { command: string; version: string; environment: string; root: string; files: string[]; exit: number; cases: InventoryCase[]; parentTests: number } {
  if (Buffer.byteLength(raw) > MAX_REPORT) throw Error("report too large");
  const rows = raw.trimEnd().split("\n").map(line => JSON.parse(line));
  const begin = rows.shift(), exit = rows.pop(), end = rows.pop();
  if (begin?.type !== "lp:begin" || begin.nonce !== expectedNonce || begin.version !== RUNNER_VERSION || !Array.isArray(begin.files) || !begin.files.length || typeof begin.root !== "string" || typeof begin.command !== "string" || !/^[a-f0-9]{64}$/.test(begin.environment) || exit?.type !== "lp:exit" || exit.nonce !== expectedNonce || !Number.isInteger(exit.exit) || end?.type !== "lp:end") throw Error("incomplete receipt");
  const files = begin.files as string[];
  if (new Set(files).size !== files.length || files.some(f => typeof f !== "string" || !f.startsWith(begin.root + "/"))) throw Error("invalid file selection");
  const stacks = new Map<string, { name: string; line: number; nesting: number; children: boolean; identity: string }[]>();
  const seen = new Set<string>(), summaries = new Set<string>(), cases: InventoryCase[] = [];
  const counts = new Map(files.map(f => [f, { tests: 0, suites: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 }]));
  let parentTests = 0, aggregate = 0;
  for (const event of rows as Event[]) {
    const d = event.data;
    if (!d || typeof d !== "object") throw Error("invalid event");
    if (event.type === "test:summary") {
      if (!d.file) { aggregate++; continue; }
      if (!counts.has(d.file) || summaries.has(d.file) || (stacks.get(d.file)?.length ?? 0)) throw Error("invalid file summary");
      const c = counts.get(d.file)!;
      if (!d.counts || Object.entries(c).some(([k,v]) => d.counts![k] !== v)) throw Error("summary mismatch");
      summaries.add(d.file); continue;
    }
    if (!d.file || !counts.has(d.file) || summaries.has(d.file) || typeof d.name !== "string" || !Number.isInteger(d.line) || !Number.isInteger(d.nesting)) throw Error("invalid case event");
    const stack = stacks.get(d.file) ?? []; stacks.set(d.file, stack);
    if (event.type === "test:start") {
      if (d.nesting !== stack.length) throw Error("out of order start");
      if (stack.length) stack[stack.length - 1]!.children = true;
      const identity = JSON.stringify([d.file, ...stack.map(x => x.name), d.name]);
      if (seen.has(identity)) throw Error("duplicate semantic identity");
      seen.add(identity); stack.push({ name: d.name, line: d.line!, nesting: d.nesting!, children: false, identity }); continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") throw Error("unexpected event");
    const item = stack.pop();
    if (!item || item.name !== d.name || item.line !== d.line || item.nesting !== d.nesting || !["test", "suite"].includes(d.details?.type ?? "")) throw Error("unpaired case event");
    if (item.nesting === 0 && (item.name === d.file || item.name === d.file.slice(begin.root.length + 1))) throw Error("synthetic file failure");
    const c = counts.get(d.file)!;
    if (d.details!.type === "suite") { c.suites++; continue; }
    c.tests++;
    const cancelled = d.details?.error?.failureType === "cancelledByParent";
    const result = d.skip !== undefined ? "skipped" : d.todo !== undefined ? "todo" : cancelled ? "cancelled" : d.expectFailure !== undefined ? "expected_failure" : event.type === "test:pass" ? "passed" : "failed";
    if (result === "expected_failure") c[event.type === "test:pass" ? "passed" : "failed"]++; else c[result]++;
    if (item.children) parentTests++; else cases.push({ file: d.file, identity: item.identity, result });
  }
  if (summaries.size !== files.length || aggregate !== 1 || [...stacks.values()].some(s => s.length)) throw Error("incomplete summaries");
  return { command: begin.command, version: begin.version, environment: begin.environment, root: begin.root, files, exit: exit.exit, cases, parentTests };
}

export async function measureTestInventory(host: ServerCore["host"], hostId: string, root: string): Promise<InventoryResult> {
  try {
    const before = await gitRepoSnapshot(host, hostId, root);
    const nonce = randomUUID();
    const command = `node -e '${"eval(Buffer.from(process.argv[1],\"base64\").toString())"}' '${Buffer.from(runner).toString("base64")}' '${nonce}' '${Buffer.from(reporter).toString("base64")}'`;
    const ran = await runOnHost(host, { hostId, cwd: root, command, timeoutSec: 135 });
    const after = await gitRepoSnapshot(host, hostId, root);
    if (ran.hostId !== hostId || ran.exitCode !== 0 || !sameSnapshot(before, after)) return { status: "unavailable", reason: "host, checkout state, or command changed" };
    if (ran.stdout.startsWith('{"type":"lp:unsupported"')) return { status: "unsupported", reason: ran.stdout.trim() };
    const parsed = parseInventory(ran.stdout, nonce);
    if (parsed.root !== root.replace(/\/$/, "")) return { status: "unavailable", reason: "checkout root mismatch" };
    return { status: "measured", receipt: { ...parsed, nonce, hostId, before: before!, after: after!, sha256: hash(ran.stdout), raw: ran.stdout } };
  } catch (e) { return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) }; }
}

export type InventoryDiff = { status: "measured"; testsAdded: number; expectedFailureAdded: number; newCases: InventoryCase[] } | { status: "unavailable"; reason: string };

/** Bind the original baseline and final receipt to the latest accepted merge and its test paths. */
export async function diffTestInventory(host: ServerCore["host"], baseline: InventoryReceipt, after: InventoryReceipt, merge: string, paths: string[]): Promise<InventoryDiff> {
  try {
    if (![merge, baseline.after.head, after.after.head].every(h => typeof h === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(h)) || !paths.length || paths.some(p => !/^[A-Za-z0-9_.\/-]+$/.test(p) || p.startsWith("/") || p.split("/").some(x => x === ".." || !x))) throw Error("invalid accepted merge or paths");
    if (baseline.hostId !== after.hostId || baseline.root !== after.root || baseline.command !== after.command || baseline.version !== after.version || baseline.environment !== after.environment || hash(baseline.raw) !== baseline.sha256 || hash(after.raw) !== after.sha256 || !sameSnapshot(baseline.before, baseline.after) || !sameSnapshot(after.before, after.after)) throw Error("receipt mismatch");
    // Reparse retained bytes; callers cannot supply case arrays as evidence.
    const first = parseInventory(baseline.raw, baseline.nonce), last = parseInventory(after.raw, after.nonce);
    if (first.root !== baseline.root || last.root !== after.root || first.command !== baseline.command || last.command !== after.command || first.environment !== baseline.environment || last.environment !== after.environment) throw Error("receipt binding mismatch");
    const now = await gitRepoSnapshot(host, after.hostId, after.root);
    if (!sameSnapshot(after.after, now)) throw Error("checkout moved since measurement");
    const probe = `const cp=require('node:child_process'); const [base,head,merge,...files]=process.argv.slice(2); const git=(...args)=>cp.execFileSync('git',args,{encoding:'utf8'}); try { git('merge-base','--is-ancestor',base,merge); git('merge-base','--is-ancestor',merge,head); const changed=git('diff','--name-only','-z',base,head).split('\\0').filter(Boolean); if (!changed.length || changed.some(x=>!files.includes(x))) throw Error('changes outside accepted test paths'); for (const f of files) { if (!changed.includes(f)) throw Error('accepted path unchanged'); if (git('rev-parse',merge+':'+f).trim() !== git('rev-parse',head+':'+f).trim()) throw Error('accepted path changed after merge'); } process.stdout.write('OK'); } catch(e) { process.stderr.write(String(e.message)); process.exitCode=1; }`;
    const args = [baseline.after.head!, after.after.head!, merge, ...paths];
    const command = `node -e 'eval(Buffer.from(process.argv[1],"base64").toString())' '${Buffer.from(probe).toString("base64")}' ${args.map(x => `'${x}'`).join(" ")}`;
    const checked = await runOnHost(host, { hostId: after.hostId, cwd: after.root, command, timeoutSec: 30 });
    if (checked.hostId !== after.hostId || checked.exitCode !== 0 || checked.stdout !== "OK") throw Error("merge or changed-path binding failed");
    if (!sameSnapshot(after.after, await gitRepoSnapshot(host, after.hostId, after.root))) throw Error("checkout moved during binding");
    const old = new Set(first.cases.map(c => c.identity));
    const eligible = new Set(paths.map(p => `${after.root}/${p}`));
    if ([...eligible].some(p => !last.files.includes(p))) throw Error("accepted path was not executed");
    const newCases = last.cases.filter(c => eligible.has(c.file) && !old.has(c.identity));
    return { status: "measured", testsAdded: newCases.filter(c => c.result === "passed" || c.result === "failed").length, expectedFailureAdded: newCases.filter(c => c.result === "expected_failure").length, newCases };
  } catch (e) { return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) }; }
}
