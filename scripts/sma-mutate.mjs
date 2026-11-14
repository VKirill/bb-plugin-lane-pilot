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
//   npm run sma:mutate -- --node n161,n162 | --region 1 | --stale | --all   [--dry]
//   npm run sma:mutate -- --fixture tests/fixtures/sma-mutate/specs.json   (fixture specs; prints, attests nothing)
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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

// ---- one checkout, one runner; a journal restores a file a killed run left mutated ----
const stateDir = join(tmpdir(), "sma-mutate", sha12(root));
mkdirSync(stateDir, { recursive: true });
const lockPath = join(stateDir, "lock"), journalPath = join(stateDir, "journal.json"), backupPath = join(stateDir, "backup");
function recover() {
  if (!existsSync(journalPath)) return;
  const { file } = JSON.parse(readFileSync(journalPath, "utf8"));
  const original = readFileSync(backupPath);
  if (!existsSync(file) || !readFileSync(file).equals(original)) { writeFileSync(file, original); say(`restored ${relative(root, file)} from the journal of an interrupted run`); }
  rmSync(journalPath, { force: true });
}
function lock() {
  try { closeSync(openSync(lockPath, "wx")); writeFileSync(lockPath, String(process.pid)); return; } catch { /* held */ }
  const pid = Number(readFileSync(lockPath, "utf8"));
  let alive = false;
  try { process.kill(pid, 0); alive = pid !== process.pid; } catch { /* gone */ }
  if (alive) { process.stderr.write(`another sma-mutate (pid ${pid}) runs in this checkout\n`); process.exit(2); }
  writeFileSync(lockPath, String(process.pid));
}
recover();
lock();

let pending = null; // { path, original }
function restore() {
  if (!pending) return;
  writeFileSync(pending.path, pending.original);
  if (!readFileSync(pending.path).equals(pending.original)) throw new Error(`could not restore ${pending.path}`);
  pending = null;
  rmSync(journalPath, { force: true });
}
function stopChild() { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } } }
function release() { stopChild(); try { restore(); } finally { rmSync(lockPath, { force: true }); } }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { release(); say(`\n${signal}: file restored, stopped`); process.exit(130); });
process.on("exit", () => { try { release(); } catch { /* best effort on exit */ } });
process.on("uncaughtException", (error) => { release(); process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });

// ---- running tests ----
const CRASH = /^(?:TypeError|ReferenceError|SyntaxError|RangeError: Maximum call stack)|Cannot find module|Failed to load|Transform failed|failed to resolve import|Test timed out|is not a function|is not defined/m;
// A matcher refusing the received value (`.toMatch() expects to receive a string, but got object`) is the assertion
// judging the result, not the code under test crashing.
const MATCHER_REFUSAL = /^TypeError: \.?(?:to|not\.to)\w*\(\) expects/;
const isCrash = (line) => !MATCHER_REFUSAL.test(line) && CRASH.test(line);

let child = null; // the running vitest: a signal stops it before the file is restored
/** Runs `files` filtered by `pattern` (vitest -t) and classifies: passed (n), failed by assertion, crashed. Async, so
 * a signal handler runs at once (a spawnSync would hold it until the tests end). */
async function runTests(files, pattern, config) {
  const out = join(stateDir, `vitest-${process.pid}.json`);
  rmSync(out, { force: true });
  const args = ["vitest", "run", ...files, "-t", pattern, "--reporter=json", "--outputFile", out, ...(config ? ["--config", config] : [])];
  let tail = "";
  const status = await new Promise((resolve) => {
    child = spawn("npx", args, { cwd: root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-2000); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => stopChild(), 15 * 60_000);
    child.on("close", (code) => { clearTimeout(timer); child = null; resolve(code); });
  });
  if (!existsSync(out)) return { ran: 0, passed: 0, assertion: [], crash: [`vitest wrote no report (exit ${status}): ${tail.slice(-600)}`] };
  const report = JSON.parse(readFileSync(out, "utf8"));
  rmSync(out, { force: true });
  const assertion = [], crash = [];
  let ran = 0, passed = 0;
  for (const file of report.testResults ?? []) {
    const tests = (file.assertionResults ?? []).filter((test) => test.status === "passed" || test.status === "failed");
    if (file.status === "failed" && !tests.some((test) => test.status === "failed") && file.message) crash.push(`${relative(root, file.name)}: ${file.message.split("\n")[0]}`);
    for (const test of tests) {
      ran++;
      if (test.status === "passed") { passed++; continue; }
      const message = (test.failureMessages ?? []).join("\n");
      (isCrash(message.split("\n")[0]) ? crash : assertion).push(`${test.fullName ?? test.title}: ${message.split("\n")[0].slice(0, 300)}`);
    }
  }
  return { ran, passed, assertion, crash };
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const occurrences = (text, find) => { let n = 0; for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + 1)) n++; return n; };

/** One mutation, end to end. `job`: { id, spec, files, pattern, config? }. */
async function mutateOne(job, baselines) {
  const path = join(root, job.spec.file);
  const key = `${job.files.join(",")}|${job.pattern}|${job.config ?? ""}`;
  const base = baselines.get(key) ?? await runTests(job.files, job.pattern, job.config);
  baselines.set(key, base);
  if (base.ran === 0) return { result: "no-tests", detail: `no test matches ${job.pattern} in ${job.files.join(", ")}` };
  if (base.passed !== base.ran || base.crash.length) return { result: "baseline-red", detail: [...base.assertion, ...base.crash].slice(0, 3).join(" | ") };
  const original = readFileSync(path);
  const text = original.toString("utf8");
  if (occurrences(text, job.spec.find) !== 1) return { result: "error", detail: `find occurs ${occurrences(text, job.spec.find)} times in ${job.spec.file}` };
  writeFileSync(backupPath, original);
  writeFileSync(journalPath, JSON.stringify({ file: path, at: new Date().toISOString() }));
  pending = { path, original };
  let after;
  try {
    writeFileSync(path, text.replace(job.spec.find, () => job.spec.replace));
    after = await runTests(job.files, job.pattern, job.config);
  } finally {
    restore();
  }
  if (after.ran === 0 && after.crash.length) return { result: "crash", detail: after.crash.slice(0, 2).join(" | ") };
  if (after.assertion.length) return { result: "killed", detail: after.assertion[0] };
  if (after.crash.length) return { result: "crash", detail: after.crash.slice(0, 2).join(" | ") };
  return { result: "survived", detail: `${after.passed} of ${after.ran} test(s) still pass with the mutation` };
}

// ---- fixture mode: specs from a JSON file, nothing attested ----
const fixture = flag("--fixture");
if (fixture) {
  const jobs = JSON.parse(readFileSync(join(root, fixture), "utf8"));
  const results = [];
  const baselines = new Map();
  for (const job of jobs) {
    const outcome = await mutateOne({ id: job.id, spec: job, files: job.tests, pattern: job.pattern, config: job.config }, baselines);
    results.push({ id: job.id, ...outcome });
    say(`${job.id.padEnd(16)} ${outcome.result.padEnd(12)} ${outcome.detail ?? ""}`);
  }
  if (argv.includes("--json")) say(JSON.stringify(results));
  process.exit(0);
}

// ---- map mode ----
const { SMA_EVIDENCE } = await import("../src/rooms/sma-map/evidence/index.ts");
const { SMA_NODES, SMA_CARDS } = await import("../src/rooms/sma-map/graph.ts");
const { SMA_CONTRACT_TESTS } = await import("../src/rooms/sma-map/contracts.ts");
const { SMA_ATTEST, lintMutation, mutationState, specHash, contentHash } = await import("../src/rooms/sma-map/mutation.ts");

const regionOf = new Map(SMA_NODES.map(([id, region]) => [id, region]));
const testFilesOf = (id) => [...new Set((SMA_CONTRACT_TESTS[SMA_CARDS[id]?.[0] ?? id] ?? []).map((line) => line.split(" › ")[0]))].sort();
const withSpec = Object.keys(SMA_EVIDENCE).filter((id) => SMA_EVIDENCE[id].mutation);
let selected;
if (flag("--node")) selected = flag("--node").split(",").map((id) => id.trim()).filter(Boolean);
else if (flag("--region") !== undefined) selected = withSpec.filter((id) => regionOf.get(id) === Number(flag("--region")));
else if (argv.includes("--stale")) selected = withSpec.filter((id) => { const state = mutationState(SMA_EVIDENCE[id].mutation, SMA_ATTEST[id], root, testFilesOf(id)); return !SMA_ATTEST[id] || state.stale === true; });
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
// Mutations of one file run one after another — and so does everything else here: one checkout, one runner.
for (const id of selected) {
  const spec = SMA_EVIDENCE[id]?.mutation;
  const smaId = SMA_CARDS[id]?.[0];
  if (!spec || !smaId) { say(`${id.padEnd(7)} skipped      no mutation spec`); continue; }
  const problems = lintMutation(spec, root);
  if (problems.length) { say(`${id.padEnd(7)} lint         ${problems.join("; ")}`); tally.lint = (tally.lint ?? 0) + 1; continue; }
  const files = testFilesOf(id);
  if (!files.length) { say(`${id.padEnd(7)} no-tests     no contract test names [sma:${smaId}]`); tally["no-tests"] = (tally["no-tests"] ?? 0) + 1; continue; }
  if (argv.includes("--dry")) { say(`${id.padEnd(7)} would run    ${spec.kind} in ${spec.file} against ${files.join(", ")}`); continue; }
  const outcome = await mutateOne({ id, spec, files, pattern: escapeRe(`[sma:${smaId}]`) }, baselines);
  tally[outcome.result] = (tally[outcome.result] ?? 0) + 1;
  say(`${id.padEnd(7)} ${outcome.result.padEnd(12)} ${spec.kind} ${spec.file}${outcome.detail ? ` — ${outcome.detail.slice(0, 240)}` : ""}`);
  attest(id, {
    spec: specHash(spec), kind: spec.kind, file: contentHash(readFileSync(join(root, spec.file), "utf8")),
    tests: Object.fromEntries(files.map((file) => [file, contentHash(readFileSync(join(root, file), "utf8"))])),
    commit: `${commit}${dirty}`, result: outcome.result, at: new Date().toISOString(), ...(outcome.detail ? { detail: outcome.detail.slice(0, 300) } : {}),
  });
}
say(`\n${selected.length} node(s): ${Object.entries(tally).map(([result, n]) => `${result} ${n}`).join(", ") || "nothing run"}`);
process.exitCode = Object.keys(tally).some((result) => result !== "killed") ? 1 : 0;
