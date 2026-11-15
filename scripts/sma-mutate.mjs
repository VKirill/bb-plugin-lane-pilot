#!/usr/bin/env node
// The mutation runner of the SMA map (sma-parity-tz.md §4, proof 2): for each selected node it checks the node's
// contract tests ([sma:<card id>] in the title, src/rooms/sma-map/contracts.ts) are green, applies the node's mutation
// spec (evidence `mutation`: find → replace, exactly once), runs exactly those tests again and requires them to FAIL BY
// AN ASSERTION — a TypeError/ReferenceError/SyntaxError, an import or transform error or a timeout is a `crash`, not a
// kill. Each node's result is attested in src/rooms/sma-map/attest/rNN.json. Runs are sequential.
//
// Where it writes (owner, 2026-11-15: PRIMARY only): the canonical PRIMARY checkout of the repository the spec names —
// this plugin on main, the core (`core:<path>`) on vk/experimental, the Telegram plugin (`telegram:<path>`) on main — and
// nowhere else: a linked worktree, another clone (an SMA_SIBLING_* override is read, never written), `..` and a symbolic
// link out of the checkout are refused (siblings.ts refuseMutation). The coordinator owns the exclusive window (no edit,
// build or deploy in that checkout while it runs); this runner does not enforce it, it checks the checkout's identity:
//   - one lock and one journal per repository, in its git-common-dir (`sma-mutate/`), so they survive a reboot and do not
//     depend on how the path is spelled; a checkout's journal is recovered only when a run touches that checkout;
//   - the journal holds the original's and the mutant's hashes: a file is restored only while it still holds the mutant
//     (and is left alone when it is the original). Anything else is somebody's edit: it is never overwritten, the journal and
//     the backup are kept, and the checkout is refused until a person settles it;
//   - before the first mutation in a checkout its HEAD, tree and every changed or untracked file (with a hash of its bytes)
//     are recorded, and it must be clean then (in this plugin only contracts.ts as regenerated may differ); the file a node
//     mutates and its tests must be byte for byte HEAD's blobs. Before any attested outcome (a verdict, baseline-red,
//     no-tests, error) the checkout must be identical and those files still HEAD's bytes — except this runner's own outputs in this plugin: contracts.ts as
//     regenerated at the start, and in attest/rNN.json the entries of nodes attested by this run. Otherwise `refused`.
// The test runners: vitest from the package that holds the test for the core, `tsx --test` from the root for the Telegram
// plugin, filtered to the [sma:<id>] title.
//
//   npm run sma:mutate -- --node n161,n162 | --region 1 | --stale | --all   [--dry]
//   npm run sma:mutate -- --fixture <specs.json> [--json]   (fixture specs; prints, attests nothing)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };
const say = (line) => process.stdout.write(`${line}\n`);

// ---- one lock and one journal per repository, in its git-common-dir ----
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitOut = (cwd, ...args) => { const run = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }); return run.status === 0 ? run.stdout.trim() : null; };
/** The runner's state for a checkout: <git-common-dir>/sma-mutate/{lock,journal.json,backup}; null when git cannot say where. */
function stateOf(checkout) {
  const common = gitOut(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return null;
  const dir = join(realpathSync(common), "sma-mutate");
  mkdirSync(dir, { recursive: true });
  return { checkout: realpathSync(checkout), dir, lock: join(dir, "lock"), journal: join(dir, "journal.json"), backup: join(dir, "backup") };
}
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
const writeAtomic = (path, bytes) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, bytes); renameSync(tmp, path); };
/**
 * Settles the checkout's journal (the caller holds the lock): the file still holds the mutant → the original is written
 * back; it is the original → nothing to do. Anything else, or a journal or backup that does not add up, is returned as the
 * reason to refuse — nothing is overwritten and the journal and the backup stay. Null when the checkout is settled.
 */
function recover(state, sibling = null) {
  if (!existsSync(state.journal)) return null;
  let entry;
  try { entry = JSON.parse(readFileSync(state.journal, "utf8")); } catch { return `the journal ${state.journal} cannot be read: nothing restored, it is left in place`; }
  if (typeof entry?.file !== "string" || typeof entry.original !== "string" || typeof entry.mutant !== "string") return `the journal ${state.journal} names no file with its original and mutant hashes: nothing restored, it is left in place`;
  let backup;
  try { backup = readFileSync(state.backup); } catch { return `the backup of ${entry.file} (${state.backup}) is missing: nothing restored, the journal is kept`; }
  if (sha(backup) !== entry.original) return `the backup ${state.backup} is not the original the journal names: nothing restored, both are kept`;
  const outside = targetRefusal(sibling, state.checkout, relative(state.checkout, entry.file));
  if (outside) return `the journal names ${entry.file}, which may not be written (${outside}): nothing restored, the journal and the backup are kept in ${state.dir}`;
  const current = existsSync(entry.file) ? sha(readFileSync(entry.file)) : null;
  if (current === entry.mutant) {
    writeFileSync(entry.file, backup);
    if (sha(readFileSync(entry.file)) !== entry.original) return `could not write the original back to ${entry.file}: the journal and the backup are kept`;
    say(`restored ${entry.file} from the journal`);
  } else if (current !== entry.original) {
    return `${entry.file} is neither the original nor the mutant the journal names (${current ? "edited" : "deleted"} since): nothing overwritten; the journal and the original's backup are kept in ${state.dir}`;
  }
  rmSync(state.journal, { force: true });
  rmSync(state.backup, { force: true });
  return null;
}

/**
 * Why `path` (relative to `checkout`) may not be written: the same rule as placing a mutation (siblings.ts refuseMutation:
 * canonical PRIMARY, main checkout, branch, inside after symbolic links), and it must be a regular file, not a link — or null.
 */
function targetRefusal(sibling, checkout, path) {
  const refused = refuseMutation(sibling, checkout, path, root);
  if (refused) return refused;
  const file = join(checkout, path);
  let folder;
  try { folder = realpathSync(dirname(file)); } catch { return `refused: the folder of ${path} is gone`; }
  if (folder !== join(checkout, dirname(path))) return `refused: a folder on the way to ${path} is a symbolic link`;
  try { if (!lstatSync(file).isFile()) return `refused: ${path} is not a regular file`; } catch { /* deleted: the caller sees it */ }
  return null;
}
let pending = null; // { state, sibling } whose journal names the file mutated right now
/** Restores the file mutated right now; the reason it could not, or null. */
function restore() { if (!pending) return null; const { state, sibling } = pending; pending = null; return recover(state, sibling); }
let child = null; // the running test process: a signal stops it before the file is restored
function stopChild() { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } }
function release() {
  stopChild();
  try { const why = restore(); if (why) process.stderr.write(`${why}\n`); } finally { for (const state of [...held.values()]) unlock(state); }
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { release(); say(`\n${signal}: stopped`); process.exit(130); });
process.on("exit", () => { try { release(); } catch { /* best effort on exit */ } });
process.on("uncaughtException", (error) => { release(); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });

const { readJunitReport, readVitestReport, mergeRuns, verdictOf, testCommands, emptyRun } = await import("../src/rooms/sma-map/mutation-run.ts");
const { refuseMutation, resolveSibling, siblingRoots, splitSiblingPath, SIBLINGS } = await import("../src/rooms/sma-map/siblings.ts");
const { headOf, isDirty, snapshotOf, frozenChanges, onlyKeysChanged, differFromCommit } = await import("../src/rooms/sma-map/sibling-git.ts");

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

/** Where a spec's file lives: this plugin's PRIMARY checkout or a sibling's (refused anywhere else, siblings.ts refuseMutation). */
function placeOf(spec, tests) {
  const { sibling, path } = splitSiblingPath(spec.file);
  const files = tests.map((file) => splitSiblingPath(file)).filter((at) => at.sibling === sibling).map((at) => at.path);
  let base = root;
  if (sibling) {
    const at = resolveSibling(sibling, root);
    if (at.root === null) return { error: "absent", detail: at.why };
    base = at.root;
  }
  // Checked before stateOf, which creates the runner's folder in the checkout's git directory.
  const refused = targetRefusal(sibling, realpathSync(base), path);
  if (refused) return { error: "refused", detail: refused };
  const state = stateOf(base);
  if (!state) return { error: "refused", detail: `refused: git cannot say where the git directory of ${base} is` };
  return { sibling, base: state.checkout, path, files, state };
}

// The identity each checkout is held to: recorded before its first mutation in this run (map mode records this plugin's after
// the contract index is regenerated). `allowOf(state)` names the outputs of this runner that may change in that checkout.
const ATTEST_FILE = /^src\/rooms\/sma-map\/attest\/r\d+\.json$/;
const starts = new Map(); // state dir -> snapshot
const startOf = (state) => { if (!starts.has(state.dir)) starts.set(state.dir, snapshotOf(state.checkout, (path) => ATTEST_FILE.test(path))); return starts.get(state.dir); };
let allowOf = () => undefined;

// What may already differ from HEAD when a checkout's identity is recorded: nothing in a sibling; in this plugin only the
// contract index the run has just regenerated (attestations of earlier runs are committed before a run).
const CONTRACTS_FILE = "src/rooms/sma-map/contracts.ts";
const dirtyAtStart = (place, start) => Object.keys(start.entries).filter((path) => place.sibling || path !== CONTRACTS_FILE);

/** One mutation, end to end. `job`: { id, spec, tests, pattern, config? }. */
async function mutateOne(job, baselines) {
  const place = placeOf(job.spec, job.tests);
  if (place.error) return { result: place.error, detail: place.detail };
  if (!tryLock(place.state)) return { result: "locked", detail: `another sma-mutate runs in ${place.base}` };
  const unsettled = recover(place.state, place.sibling);
  if (unsettled) return { result: "refused", detail: unsettled, place };
  const start = startOf(place.state);
  if (!start) return { result: "refused", detail: `git cannot read the state of ${place.base}: nothing is mutated there`, place };
  // The whole checkout is the commit the verdict names: a dirty dependency the subject imports would be judged as HEAD.
  const dirty = dirtyAtStart(place, start);
  if (dirty.length) return { result: "refused", detail: `not committed in ${place.base}: ${dirty.slice(0, 6).join(", ")} (a mutation is judged against HEAD; commit or remove them first)`, place };
  // The subject and its tests byte for byte at HEAD (git status does not show an assume-unchanged or skip-worktree file).
  const inputs = [place.path, ...place.files];
  const off = differFromCommit(place.base, start.head, inputs);
  if (off === null || off.length) return { result: "refused", detail: off === null ? `git cannot hash ${inputs.join(", ")} in ${place.base}` : `not the bytes HEAD has in ${place.base}: ${off.join(", ")}`, place };
  // Every outcome from here on is attested: it holds only when the checkout is still the recorded one at the end.
  const held = (outcome) => {
    const end = snapshotOf(place.state.checkout, (file) => ATTEST_FILE.test(file));
    const changed = end ? frozenChanges(start, end, allowOf(place.state)) : ["git cannot read the checkout"];
    const moved = end ? differFromCommit(place.base, start.head, inputs) : null;
    if (moved === null) changed.push(`git cannot hash ${inputs.join(", ")}`);
    else changed.push(...moved.filter((path) => !changed.includes(path)));
    if (changed.length) return { result: "refused", detail: `${place.base} changed while this node ran, so the verdict is not about the recorded commit: ${changed.slice(0, 6).join(", ")}`, place };
    return { ...outcome, place };
  };
  if (!place.files.length) return held({ result: "no-tests", detail: `no contract test in ${place.sibling ? SIBLINGS[place.sibling].repo : "this repository"} for ${job.pattern}` });
  const run = { ...place, pattern: job.pattern, config: job.config };
  const key = `${place.base}|${place.files.join(",")}|${job.pattern}|${job.config ?? ""}`;
  const base = baselines.get(key) ?? await runTests(run);
  baselines.set(key, base);
  if (base.ran === 0) return held({ result: "no-tests", detail: `no test matches ${job.pattern} in ${place.files.join(", ")}${base.crash.length ? ` — ${base.crash[0]}` : ""}` });
  if (base.passed !== base.ran || base.crash.length) return held({ result: "baseline-red", detail: [...base.assertion, ...base.crash].slice(0, 3).join(" | ") });
  const path = join(place.base, place.path);
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (occurrences(text, job.spec.find) !== 1) return held({ result: "error", detail: `find occurs ${occurrences(text, job.spec.find)} times in ${job.spec.file}` });
  const mutant = Buffer.from(text.replace(job.spec.find, () => job.spec.replace), "utf8");
  writeAtomic(place.state.backup, original);
  writeAtomic(place.state.journal, JSON.stringify({ file: path, original: sha(original), mutant: sha(mutant), pid: process.pid, at: new Date().toISOString() }));
  pending = { state: place.state, sibling: place.sibling };
  let after;
  let unrestored;
  try {
    writeFileSync(path, mutant);
    after = await runTests(run);
  } finally {
    unrestored = restore();
  }
  if (unrestored) return { result: "refused", detail: unrestored, place };
  return held(verdictOf(after));
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
// This plugin's checkout: the attestations and the contract index are written here, and local nodes are mutated here.
const mine = stateOf(root);
if (!mine) { process.stderr.write(`git cannot say where the git directory of ${root} is\n`); process.exit(2); }
if (!tryLock(mine)) { process.stderr.write(`another sma-mutate (pid ${readFileSync(mine.lock, "utf8")}) runs in this checkout\n`); process.exit(2); }
const unsettledHere = recover(mine);
if (unsettledHere) { process.stderr.write(`${unsettledHere}\n`); process.exit(2); }
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
// The identity of this checkout from here on: contracts.ts as just regenerated, and only the entries this run attests may
// change in attest/rNN.json.
startOf(mine);
const attested = new Set();
allowOf = (state) => (state.dir === mine.dir ? (path, before, after) => ATTEST_FILE.test(path) && onlyKeysChanged(before, after, attested) : undefined);

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
  attested.add(id);
}
say(`\n${selected.length} node(s): ${Object.entries(tally).map(([result, n]) => `${result} ${n}`).join(", ") || "nothing run"}`);
process.exitCode = Object.keys(tally).some((result) => result !== "killed") ? 1 : 0;
