#!/usr/bin/env node
// The mutation runner of the SMA map (sma-parity-tz.md §4, proof 2): for each selected node it checks the node's
// contract tests ([sma:<card id>] in the title, src/rooms/sma-map/contracts.ts) are green, applies the node's mutation
// spec (evidence `mutation`: find → replace, exactly once), runs exactly those tests again and requires them to FAIL BY
// AN ASSERTION — a TypeError/ReferenceError/SyntaxError, an import or transform error or a timeout is a `crash`, not a
// kill. The file is restored byte for byte in every case (finally, SIGINT/SIGTERM/SIGHUP, exit, and a journal in the
// temp folder that the next run restores after a kill -9). Each node's result is attested in
// src/rooms/sma-map/attest/rNN.json. Runs are sequential (so are mutations of one file); each checkout has its own
// lock and journal, so several worktrees can run at once.
//
// A spec whose file is `core:<path>` or `telegram:<path>` mutates that file in the sibling's checkout (siblings.ts:
// SMA_SIBLING_CORE / SMA_SIBLING_TELEGRAM, else the proofs worktree) and runs the sibling's own runner from there (vitest
// from the package that holds the test for the core, `tsx --test` from the root for the Telegram plugin), filtered to the
// [sma:<id>] title. It refuses any checkout that is not a linked worktree under ~/.lane-pilot/worktrees/<repo>/ — the shared
// checkouts (the core is built and deployed from one) are never written. The sibling checkout has its own lock and journal.
//
//   npm run sma:mutate -- --node n161,n162 | --region 1 | --stale | --all   [--dry]
//   npm run sma:mutate -- --fixture <specs.json> [--json]   (fixture specs; prints, attests nothing)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const argv = process.argv.slice(2);

// The specs and the map are TypeScript: run under tsx (re-exec once when started by plain node).
if (!process.env.SMA_MUTATE_TSX) {
  const run = spawnSync("npx", ["tsx", fileURLToPath(import.meta.url), ...argv], { cwd: root, stdio: "inherit", env: { ...process.env, SMA_MUTATE_TSX: "1" } });
  process.exit(run.status ?? 1);
}

const sha12 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 12);
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const say = (line) => process.stdout.write(`${line}\n`);

// ---- one lock and one journal per checkout; a journal restores a file a killed run left mutated ----
const STATE_BASE = join(tmpdir(), "sma-mutate");
mkdirSync(STATE_BASE, { recursive: true });
const stateOf = (checkout) => {
  const dir = join(STATE_BASE, sha12(checkout));
  mkdirSync(dir, { recursive: true });
  return { checkout, dir, lock: join(dir, "lock"), journal: join(dir, "journal.json"), backup: join(dir, "backup") };
};
const held = new Map(); // dir -> state
function holderAlive(state) {
  let pid;
  try { pid = Number(readFileSync(state.lock, "utf8")); } catch { return false; }
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
/** Takes the checkout's lock; false when a live runner holds it. */
function tryLock(state) {
  if (held.has(state.dir)) return true;
  try { closeSync(openSync(state.lock, "wx")); } catch { if (holderAlive(state)) return false; }
  writeFileSync(state.lock, String(process.pid));
  held.set(state.dir, state);
  return true;
}
function unlock(state) { held.delete(state.dir); rmSync(state.lock, { force: true }); }
/** Restores the file an interrupted run of this checkout left mutated (the caller holds the lock). */
function recover(state) {
  if (!existsSync(state.journal)) return;
  const { file } = JSON.parse(readFileSync(state.journal, "utf8"));
  const original = readFileSync(state.backup);
  if (!existsSync(file) || !readFileSync(file).equals(original)) { writeFileSync(file, original); say(`restored ${file} from the journal of an interrupted run`); }
  rmSync(state.journal, { force: true });
}
/** Every checkout's journal whose runner is gone (a kill -9, a crash) is restored now, whichever checkout this run is for. */
function sweepOrphans() {
  for (const name of readdirSync(STATE_BASE)) {
    const dir = join(STATE_BASE, name);
    const state = { dir, lock: join(dir, "lock"), journal: join(dir, "journal.json"), backup: join(dir, "backup") };
    if (!existsSync(state.journal) || held.has(dir) || !tryLock(state)) continue;
    try { recover(state); } finally { unlock(state); }
  }
}
const mine = stateOf(root);
if (!tryLock(mine)) { process.stderr.write(`another sma-mutate (pid ${readFileSync(mine.lock, "utf8")}) runs in this checkout\n`); process.exit(2); }
recover(mine); // first: a journal belongs to whoever holds the lock, and a live run's journal is not an interrupted one
sweepOrphans();

let pending = null; // { path, original, state }
function restore() {
  if (!pending) return;
  writeFileSync(pending.path, pending.original);
  if (!readFileSync(pending.path).equals(pending.original)) throw new Error(`could not restore ${pending.path}`);
  rmSync(pending.state.journal, { force: true });
  pending = null;
}
let child = null; // the running test process: a signal stops it before the file is restored
function stopChild() { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } }
function release() { stopChild(); try { restore(); } finally { for (const state of [...held.values()]) unlock(state); } }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { release(); say(`\n${signal}: file restored, stopped`); process.exit(130); });
process.on("exit", () => { try { release(); } catch { /* best effort on exit */ } });
process.on("uncaughtException", (error) => { release(); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });

// The TypeScript modules load after the lock: a second runner must say «another sma-mutate» before anything else.
const { readJunitReport, readVitestReport, mergeRuns, verdictOf, testCommands, emptyRun } = await import("../src/rooms/sma-map/mutation-run.ts");
const { refuseMutation, resolveSibling, siblingRoots, splitSiblingPath, SIBLINGS } = await import("../src/rooms/sma-map/siblings.ts");
const { headOf, isDirty } = await import("../src/rooms/sma-map/sibling-git.ts");

// ---- running tests ----
/** Runs one command and reads its report. Async, so a signal handler runs at once (a spawnSync would hold it until the tests end). */
async function runCommand(command, base) {
  if (command.missing) return { ...emptyRun(), crash: [command.missing] };
  rmSync(command.out, { force: true });
  let tail = "";
  const status = await new Promise((done) => {
    child = spawn(command.cmd, command.args, { cwd: command.cwd, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-2000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => stopChild(), 15 * 60_000);
    child.on("close", (code) => { clearTimeout(timer); child = null; done(code); });
  });
  if (!existsSync(command.out)) return { ...emptyRun(), crash: [`${command.cmd} ${command.args[0]} wrote no report (exit ${status}): ${tail.slice(-600)}`] };
  const text = readFileSync(command.out, "utf8");
  rmSync(command.out, { force: true });
  const rel = (file) => relative(command.cwd, file);
  return command.read === "junit" ? readJunitReport(text, rel) : readVitestReport(JSON.parse(text), (file) => relative(base, file));
}
async function runTests(job) {
  const runs = [];
  for (const command of testCommands(job.sibling, job.base, job.files, job.pattern, join(job.state.dir, `report-${process.pid}`), job.config)) runs.push(await runCommand(command, job.base));
  return mergeRuns(runs);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const occurrences = (text, find) => { let n = 0; for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) n++; return n; };

/** Where a spec's file lives: this checkout, or a sibling's (refused unless it is a worktree under the worktree root). */
function placeOf(spec, tests) {
  const { sibling, path } = splitSiblingPath(spec.file);
  const files = tests.map((file) => splitSiblingPath(file)).filter((at) => at.sibling === sibling).map((at) => at.path);
  if (!sibling) return { sibling: null, base: root, path, files, state: mine };
  const at = resolveSibling(sibling, root);
  if (at.root === null) return { error: "absent", detail: at.why };
  const refused = refuseMutation(sibling, at.root, path, root);
  if (refused) return { error: "refused", detail: refused };
  return { sibling, base: at.root, path, files, state: stateOf(at.root) };
}

/** One mutation, end to end. `job`: { id, spec, tests, pattern, config? }. */
async function mutateOne(job, baselines) {
  const place = placeOf(job.spec, job.tests);
  if (place.error) return { result: place.error, detail: place.detail };
  if (!place.files.length) return { result: "no-tests", detail: `no contract test in ${place.sibling ? SIBLINGS[place.sibling].repo : "this repository"} for ${job.pattern}`, place };
  if (!tryLock(place.state)) return { result: "locked", detail: `another sma-mutate runs in ${place.base}` };
  recover(place.state);
  const run = { ...place, pattern: job.pattern, config: job.config };
  const key = `${place.base}|${place.files.join(",")}|${job.pattern}|${job.config ?? ""}`;
  const base = baselines.get(key) ?? await runTests(run);
  baselines.set(key, base);
  if (base.ran === 0) return { result: "no-tests", detail: `no test matches ${job.pattern} in ${place.files.join(", ")}${base.crash.length ? ` — ${base.crash[0]}` : ""}`, place };
  if (base.passed !== base.ran || base.crash.length) return { result: "baseline-red", detail: [...base.assertion, ...base.crash].slice(0, 3).join(" | "), place };
  const path = join(place.base, place.path);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (occurrences(text, job.spec.find) !== 1) return { result: "error", detail: `find occurs ${occurrences(text, job.spec.find)} times in ${job.spec.file}`, place };
  writeFileSync(place.state.backup, original);
  writeFileSync(place.state.journal, JSON.stringify({ file: path, at: new Date().toISOString() }));
  pending = { path, original, state: place.state };
  let after;
  try {
    writeFileSync(path, text.replace(job.spec.find, () => job.spec.replace));
    after = await runTests(run);
  } finally {
    restore();
  }
  return { ...verdictOf(after), place };
}

// ---- fixture mode: specs from a JSON file, nothing attested ----
const fixture = flag("--fixture");
if (fixture) {
  const jobs = JSON.parse(readFileSync(resolve(root, fixture), "utf8"));
  const results = [];
  const baselines = new Map();
  for (const job of jobs) {
    const outcome = await mutateOne({ id: job.id, spec: job, tests: job.tests, pattern: job.pattern, config: job.config }, baselines);
    const { place, ...shown } = outcome;
    results.push({ id: job.id, ...shown });
    say(`${job.id.padEnd(16)} ${outcome.result.padEnd(12)} ${outcome.detail ?? ""}`);
  }
  if (argv.includes("--json")) say(JSON.stringify(results));
  process.exit(0);
}

// ---- map mode ----
const { SMA_EVIDENCE } = await import("../src/rooms/sma-map/evidence/index.ts");
const { SMA_NODES, SMA_CARDS } = await import("../src/rooms/sma-map/graph.ts");
// The contract index is read from contracts.ts: a test titled [sma:<id>] written since the last `node scripts/sma-contracts.mjs` is invisible to it
// (a «survived» that only means «the new test never ran»). Regenerate it first; a failure to do so stops the run.
const indexRun = spawnSync("node", [join(here, "sma-contracts.mjs")], { cwd: root, encoding: "utf8" });
if (indexRun.status !== 0) { process.stderr.write(`could not regenerate the contract index: ${(indexRun.stderr || indexRun.stdout).trim()}\n`); process.exit(2); }
say(`contract index regenerated: ${indexRun.stdout.trim()}${indexRun.stderr.trim() ? `\n${indexRun.stderr.trim()}` : ""}`);
const { SMA_CONTRACT_TESTS } = await import("../src/rooms/sma-map/contracts.ts");
const { SMA_ATTEST, lintMutation, mutationState, specHash, contentHash } = await import("../src/rooms/sma-map/mutation.ts");
const { testFiles } = await import("../src/rooms/sma-map/states.ts");

const siblings = siblingRoots(root);
const regionOf = new Map(SMA_NODES.map(([id, region]) => [id, region]));
const allTestsOf = (id) => [...new Set((SMA_CONTRACT_TESTS[SMA_CARDS[id]?.[0] ?? id] ?? []).map((line) => line.split(" › ")[0]))].sort();
const withSpec = Object.keys(SMA_EVIDENCE).filter((id) => SMA_EVIDENCE[id].mutation);
let selected;
if (flag("--node")) selected = flag("--node").split(",").map((id) => id.trim()).filter(Boolean);
else if (flag("--region") !== undefined) selected = withSpec.filter((id) => regionOf.get(id) === Number(flag("--region")));
else if (argv.includes("--stale")) selected = withSpec.filter((id) => { const spec = SMA_EVIDENCE[id].mutation; const state = mutationState(spec, SMA_ATTEST[id], root, testFiles(SMA_CARDS[id]?.[0] ?? id, spec.file), siblings); return !SMA_ATTEST[id] || state.stale === true; });
else if (argv.includes("--all")) selected = withSpec;
else { say("usage: npm run sma:mutate -- --node n12,n40 | --region N | --stale | --all [--dry]"); process.exit(2); }
selected.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim().slice(0, 12);
const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }).stdout.trim() ? "+dirty" : "";

/** Writes one node's attestation into its region file: one node per line, sorted by node number (merge-friendly). */
function attest(id, entry) {
  const file = join(root, "src/rooms/sma-map/attest", `r${String(regionOf.get(id)).padStart(2, "0")}.json`);
  const current = JSON.parse(readFileSync(file, "utf8"));
  current[id] = entry;
  const ids = Object.keys(current).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  writeFileSync(file, `{\n${ids.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(current[key])}`).join(",\n")}\n}\n`);
}

const baselines = new Map();
const tally = {};
const NOT_ATTESTED = new Set(["refused", "absent", "locked"]);
// Mutations of one file run one after another — and so does everything else here: one runner per checkout.
for (const id of selected) {
  const spec = SMA_EVIDENCE[id]?.mutation;
  const smaId = SMA_CARDS[id]?.[0];
  if (!spec || !smaId) { say(`${id.padEnd(7)} skipped      no mutation spec`); continue; }
  const problems = lintMutation(spec, root, siblings);
  if (problems.length) { say(`${id.padEnd(7)} lint         ${problems.join("; ")}`); tally.lint = (tally.lint ?? 0) + 1; continue; }
  const tests = testFiles(smaId, spec.file);
  if (!tests.length) { say(`${id.padEnd(7)} no-tests     no contract test names [sma:${smaId}]${allTestsOf(id).length ? ` in the repository of ${spec.file}` : ""}`); tally["no-tests"] = (tally["no-tests"] ?? 0) + 1; continue; }
  if (argv.includes("--dry")) { const place = placeOf(spec, tests); say(`${id.padEnd(7)} would run    ${spec.kind} in ${spec.file} against ${tests.join(", ")}${place.error ? ` — ${place.error}: ${place.detail}` : place.sibling ? ` (in ${place.base})` : ""}`); continue; }
  const started = Date.now();
  const outcome = await mutateOne({ id, spec, tests, pattern: escapeRe(`[sma:${smaId}]`) }, baselines);
  tally[outcome.result] = (tally[outcome.result] ?? 0) + 1;
  say(`${id.padEnd(7)} ${outcome.result.padEnd(12)} ${spec.kind} ${spec.file}${outcome.detail ? ` — ${outcome.detail.slice(0, 240)}` : ""} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (outcome.result === "survived") say(`        tests that ran and still passed: ${outcome.ran.map((title) => `«${title}»`).join(" | ")}`);
  if (NOT_ATTESTED.has(outcome.result)) continue;
  const place = outcome.place;
  const read = (where) => { const at = splitSiblingPath(where); return readFileSync(join(at.sibling ? place.base : root, at.path), "utf8"); };
  attest(id, {
    spec: specHash(spec), kind: spec.kind, file: contentHash(read(spec.file)),
    tests: Object.fromEntries(tests.map((file) => [file, contentHash(read(file))])),
    commit: `${commit}${dirty}`, result: outcome.result, at: new Date().toISOString(), ...(outcome.detail ? { detail: outcome.detail.slice(0, 300) } : {}),
    ...(place.sibling ? { sibling: place.sibling, siblingCommit: `${headOf(place.base)}${isDirty(place.base) ? "+dirty" : ""}` } : {}),
  });
}
say(`\n${selected.length} node(s): ${Object.entries(tally).map(([result, n]) => `${result} ${n}`).join(", ") || "nothing run"}`);
process.exitCode = Object.keys(tally).some((result) => result !== "killed") ? 1 : 0;
