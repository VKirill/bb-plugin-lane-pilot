// Region 16 (slash commands and workflows), batch e, second half: the audit-fix / add-tests / QA commands, the live check on the host, the review pipeline (n1283 … n1297).
// Shares the scratch-world pattern of r16-world-e.ts (not edited here): each `observeE2.<smaId>()` runs the REAL code of the node — the real workflow engine with fake executors on the
// real graph files, the host handlers of the live check against a local server and a stand-in runner script, the checkout action `git.diff_files` on a scratch git repository, the
// review step of the phase auto stage — and returns plain data. No vitest import: the probe loads this file under vite-node. No model, no hub, nothing outside the machine.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { QA_DEFAULT_PORTS } from "../../src/rooms/contracts";
import { qaRoute, qaStopAfter } from "../../src/rooms/contracts/quality-mode";
import { createCore } from "../../src/rooms/core/server/core";
import { runCodeCritique } from "../../src/rooms/critique/server/critique-runs";
import { buildCandidateEvidence } from "../../src/rooms/critique/code-critique";
import { findBrowserQaTarget, probeBrowserQaTarget, runBrowserQa, scanBrowserQaPorts } from "../../src/rooms/host-worker/handlers/desktop";
import { runCommand } from "../../src/rooms/host-worker/handlers/exec";
import { browserQaVerdict } from "../../src/rooms/qa/browser-qa";
import { registerBrowserExecutors, runBrowserQaGraph } from "../../src/rooms/qa/server/browser-graphs";
import { registerCheckoutActions } from "../../src/rooms/workflow/server/workflow-checkout-actions";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { HARNESS_VERSION, createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { QA_HOST_KEY } from "@lane-pilot/settings-catalog";
import { createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { runSim } from "../workflow/chain-harness";
import { PH, phase } from "./r16-world";

type Row = Record<string, unknown>;
const pathOf = (r: Awaited<ReturnType<typeof runSim>>) => r.path.join(" ");
const ranOf = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id)).join(" ");
const outOf = (r: Awaited<ReturnType<typeof runSim>>) => (r.summary.output ?? {}) as Row;
const FINDING = { severity: "high", file: "src/a.ts", line: 12, evidence: "return value of save() ignored" };

const serve = async (status: number, type: string, port = 0): Promise<Server | null> => {
  const server = createServer((_req, res) => { res.writeHead(status, { "content-type": type }); res.end("x"); });
  return await new Promise<Server | null>((resolve) => { server.once("error", () => resolve(null)); server.listen(port, "127.0.0.1", () => resolve(server)); });
};
const portOf = (server: Server) => (server.address() as AddressInfo).port;
const close = (server: Server | null) => new Promise<void>((resolve) => { if (!server) resolve(); else server.close(() => resolve()); });

/** The runner stand-in: a shell script at ~/.agents/bin/browser-qa-codex of a scratch HOME; it keeps its arguments and writes the report the case names. */
async function qaRun(report: string | null, exitCode: number, over: Row = {}) {
  const home = mkdtempSync(join(tmpdir(), "lp-qa-home-")), project = mkdtempSync(join(tmpdir(), "lp-qa-project-"));
  mkdirSync(join(home, ".agents", "bin"), { recursive: true });
  const runner = join(home, ".agents", "bin", "browser-qa-codex");
  writeFileSync(runner, `#!/bin/sh
printf '%s\\n' "$@" > "$HOME/argv.txt"
slug=""
while [ $# -gt 0 ]; do if [ "$1" = "--slug" ]; then slug="$2"; fi; shift; done
mkdir -p ".agents/qa/$slug"
${report === null ? "" : `cat > ".agents/qa/$slug/REPORT.md" <<'REPORT_END'\n${report}\nREPORT_END`}
echo '{"model":"gpt-x","reasoning_effort":"high","backend":"chrome-qa"}' > ".agents/qa/$slug/codex-run.json"
exit ${exitCode}
`);
  chmodSync(runner, 0o755);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const input = { requestedHostId: "h_test", projectCwd: project, url: "http://127.0.0.1:5173/", slug: "check-1", cases: ["Home opens", "Menu shows three items"], envClass: "local", viewports: "375,768,1280",
      authorized: false, provider: "codex", model: "gpt-x", reasoningEffort: "high", backend: "chrome-qa", timeoutSec: 60, ...over };
    const result = await runBrowserQa(input as never, {} as never);
    return { result, argv: readFileSync(join(home, "argv.txt"), "utf8").trimEnd().split("\n") };
  } finally {
    if (before === undefined) delete process.env.HOME; else process.env.HOME = before;
    rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
  }
}
const plaque = (counts: string) => `# QA report\n\nTotal / Passed / Failed / Blocked: ${counts}\n`;

/** The code critique stage on a fake host, as tests/critique-stage-reuse.test.ts builds it. */
async function critiqueRun(settings: Row, taskOver: Row = {}) {
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    providers: { list: async () => { calls.push("providers.list"); return []; }, models: async () => { calls.push("providers.models"); return { models: [] }; } },
    threads: { send: async () => ({}) }, files: { write: async () => ({}), read: async () => { calls.push("files.read"); return { content: "tiny", contentEncoding: "utf8" }; } },
  } as never });
  bb.hosts.experimental_client = (() => ({ call: async (method: string) => { calls.push(method); return {}; } })) as never;
  const db = openDatabase(bb);
  const task = { schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: "/repo", read_first: ["new.ts"], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"],
    owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [], ...taskOver } as never;
  const config = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "test-model", writerProviderId: "codex", writerModel: "test-model" } as never;
  createRun(db, "r", "P", "cli", "/repo");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  createAttempt(db, { id: "a", runId: "r", taskId: "t1" });
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "P", key, value as never);
  const evidence = buildCandidateEvidence({ produced: ["src/a.ts"], hashes: { "src/a.ts": "a".repeat(64) }, verification: [{ command: "npm test", exitCode: 0, stdout: "1 passed" }],
    files: [{ path: "src/a.ts", content: "export const a = 1;" }], output: "done", ownsPaths: ["src/**"], neverTouch: [], dirtOk: true, workspace: "/repo" });
  const result = await runCodeCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "r", taskId: "t1", config, task, evidence } as never);
  const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
  await harness.lifecycle.dispose();
  return { allowed: result.allowed, review: result.review, state: receipt?.state ?? null, reason: receipt?.reason ?? null };
}

/** `git.diff_files`, the step that decides which files a review looks at, run for real on a scratch git repository. */
async function diffFiles(inputs: Row, prepare: (checkout: string, git: (...args: string[]) => void) => void) {
  const checkout = mkdtempSync(join(tmpdir(), "lp-scope-"));
  const git = (...args: string[]) => { execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: checkout, stdio: "ignore" }); };
  git("init", "-q");
  writeFileSync(join(checkout, "README.md"), "hello\n"); git("add", "."); git("commit", "-q", "-m", "base");
  prepare(checkout, git);
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Row }) => { if (call.method === "runCommand") return runCommand(call.input as never, undefined as never); throw new Error(`unexpected host method ${call.method}`); }) as never,
    sdk: { threads: { get: async () => ({ id: "pm", status: "idle", environmentId: "env-pm" }) }, environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) } } as never,
  });
  const ctx = createCore(bb, openDatabase(bb));
  const actions = new Map<string, (c: never, rt: never) => Promise<Row>>();
  registerCheckoutActions(null as never, ctx, { action: (key, run) => { actions.set(key, run as never); }, planHome: async () => null, flagOf: () => false });
  const c = { resolve: (ref: string) => inputs[ref.replace("$inputs.", "")] };
  try { return await actions.get("git.diff_files")!(c as never, { ctx, services: {}, pmThreadId: "pm", projectId: "P", runId: null } as never); }
  finally { await harness.lifecycle.dispose(); rmSync(checkout, { recursive: true, force: true }); }
}

/** lp.browser-qa as the engine runs it: the real executors with a stubbed `runBrowserQa` of the services (a trimmed copy of tests/qa-browser-graphs.test.ts's setup). */
async function qaGraph(reply: Row) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const qaCalls: Row[] = [];
  const ctx = { db, host: { call: async () => { throw new Error("no host call"); } }, bb: { log: { info: () => undefined } }, isDisposed: () => false } as never;
  const services = { runBrowserQa: async (args: Row) => { qaCalls.push(args); return reply; } };
  const engine = new WorkflowEngine({ db, harnessVersion: HARNESS_VERSION, resolveWorkflow: (id, version) => builtinWorkflow(id, version) });
  registerPureActions(engine);
  registerBrowserExecutors(engine, ctx, services as never);
  saveProjectSetting(db, "proj", QA_HOST_KEY, "host_mini");
  const input = { pmThreadId: "pm", projectId: "proj", runId: "lprun_1", taskId: "task-1", url: "http://127.0.0.1:5173/", cases: ["Open home"], envClass: "local", viewports: "375,768,1280", authorized: false };
  let answered: unknown, threw: string | null = null;
  try { answered = await runBrowserQaGraph(ctx, input as never); } catch (cause) { threw = cause instanceof Error ? cause.message : String(cause); }
  const run = db.prepare("SELECT workflow_id, status, reason FROM lane_pilot_wf_run").all() as Row[];
  return { answered, threw, run, qaCalls };
}

const reviewStubs = (over: Row = {}) => ({ "lp.plan": { status: "ok", task_count: 1, tasks: [{ id: "f1", objective: "f1", depends_on: [] }] }, "lp.build": { status: "done", merged_commits: ["f1"] }, ...over });

export const observeE2 = {
  /** n1283: /sma-audit-fix with nothing given audits first, then plans, builds and re-reviews the fixes, and closes the rest by class for the owner. */
  async k_c_auditfix() {
    const rework = { status: "rework", findings: [FINDING], remaining_actionable: 1 };
    const audited = await runSim("review-fix", { input: { goal: "Fix the audit findings" }, stubs: reviewStubs({ "lp.review": [rework, { status: "pass", remaining_actionable: 0 }] }) });
    const clean = await runSim("review-fix", { input: { goal: "Fix the audit findings" }, stubs: reviewStubs({ "lp.review": { status: "pass", findings: [] } }) });
    const stuck = await runSim("review-fix", { input: { goal: "Fix the audit findings" }, stubs: reviewStubs({ "lp.review": rework, classify: { remaining: [FINDING], fix_later: [], accepted: [] }, ask: { answer: "ok", answer_kind: "accept" } }) });
    return {
      audited: [ranOf(audited), audited.called("plan_fix")[0]?.input.gaps ?? null, outOf(audited).status],
      clean: [ranOf(clean), outOf(clean).status],
      stuck: [ranOf(stuck), outOf(stuck).status, outOf(stuck).remaining, stuck.called("ask").length],
    };
  },
  /** n1284: /sma-add-tests with gaps given writes the tests at once; with a phase and no gaps it derives the gaps and the owner confirms (a timeout blocks); failing tests go to a fixer up to three rounds. */
  async k_c_addtests() {
    const stubs = (over: Row = {}) => ({ write_tests: { state: "accepted", tests_added: 5 }, run: { ok: true, pass_rate: 100, failures: [], no_framework: false }, derive: { gaps: [{ file: "a.ts", layer: "L1", priority: "high" }] }, ...over });
    const gap = [{ file: "src/a.ts", layer: "L1", priority: "high" }];
    const given = await runSim("test-gen", { input: { scope: "src", gaps: gap }, stubs: stubs() });
    const derived = await runSim("test-gen", { input: { scope: "src", phase_id: "ph_a" }, stubs: stubs(), humans: { confirm: { answer: "all", answer_kind: "agree" } } });
    const timeout = await runSim("test-gen", { input: { scope: "src", phase_id: "ph_a" }, stubs: stubs(), humans: { confirm: { answer: "", answer_kind: "timeout" } } });
    const fixing = await runSim("test-gen", { input: { scope: "src", gaps: gap }, stubs: stubs({ run: { ok: false, pass_rate: 60, failures: [{ id: "F1" }], no_framework: false }, classify: [{ converged: false, test_defects: [{ id: "F1" }], code_defects: [], env_issues: [] }, { converged: true, test_defects: [], code_defects: [], env_issues: [] }], fix_tests: { state: "accepted", merge_commit: "c1" } }) });
    const noWrite = await runSim("test-gen", { input: { scope: "src", gaps: gap }, stubs: stubs({ write_tests: { state: "failed", tests_added: 0 } }) });
    const pick = (r: Awaited<ReturnType<typeof runSim>>) => [ranOf(r), outOf(r).status];
    return { given: [...pick(given), outOf(given).tests_added], derived: pick(derived), timeout: pick(timeout), fixing: pick(fixing), noWrite: pick(noWrite) };
  },
  /** n1285: /sma-qa runs the live check of an accepted task through the graph lp.browser-qa: the arguments reach the check as given, the reply comes back untouched, a red verdict leaves the run failed. */
  async k_c_qa() {
    const passed = { runId: "lprun_1", taskId: "task-1", state: "passed", link: "@thread:thr_qa", result: { verdict: "passed" } };
    const failed = { runId: "lprun_1", taskId: "task-1", state: "failed", link: "@thread:thr_qa", result: { verdict: "failed" }, reason: "case 1 failed" };
    const ok = await qaGraph(passed), red = await qaGraph(failed);
    return { ok: { answered: ok.answered, run: ok.run, args: ok.qaCalls[0] }, red: { answered: red.answered, threw: red.threw, run: red.run } };
  },
  /** n1286: the check finds the app by itself: every default dev-server port that answers like a web page is a target, nothing else is. */
  async k_wqa_find() {
    const wanted = QA_DEFAULT_PORTS.map((port) => `http://127.0.0.1:${port}/`);
    const bound: Array<{ port: number; server: Server }> = [];
    for (const port of QA_DEFAULT_PORTS) { const server = await serve(200, "text/html; charset=utf-8", port); if (server) bound.push({ port, server }); }
    const html = await serve(200, "text/html; charset=utf-8"), moved = await serve(302, "text/html"), missing = await serve(404, "text/html"), json = await serve(200, "application/json");
    const gone = await serve(200, "text/html"); const goneAt = portOf(gone!); await close(gone);
    try {
      const found = await findBrowserQaTarget({ requestedHostId: "h_test" } as never, {} as never);
      const scanned = await scanBrowserQaPorts([portOf(json!), portOf(html!), goneAt, portOf(missing!), portOf(moved!)]);
      return {
        hostId: found.hostId === (process.env.BB_HOST_ID ?? "h_test"), listed: found.urls.every((url) => wanted.includes(url)), boundSome: bound.length > 0,
        mineFound: bound.every(({ port }) => found.urls.includes(`http://127.0.0.1:${port}/`)),
        scan: scanned.map((url) => url.replace(/:\d+\//, ":<port>/")), scanFirst: scanned[0] === `http://127.0.0.1:${portOf(html!)}/`,
        defaults: [...QA_DEFAULT_PORTS],
      };
    } finally { for (const { server } of bound) await close(server); for (const server of [html, moved, missing, json]) await close(server); }
  },
  /** n1287: nothing answers at the address: the probe throws and no check is run; an address that answers, a bad address and an unreachable workspace are told apart. */
  async k_wqa_notrun() {
    const work = mkdtempSync(join(tmpdir(), "lp-qa-ws-"));
    const live = await serve(200, "text/html"), dead = await serve(200, "text/html"); const deadAt = portOf(dead!); await close(dead);
    const probe = async (url: string, workspacePath = work) => { try { const r = await probeBrowserQaTarget({ requestedHostId: "h_test", workspacePath, url } as never, {} as never); return { ok: true as const, url: r.url, hostOk: r.hostId === (process.env.BB_HOST_ID ?? "h_test"), workspaceKnown: r.workspaceRealPath.length > 0 }; } catch (cause) { return { ok: false as const, error: (cause instanceof Error ? cause.message : String(cause)).replace(/:\d+/g, ":<port>").slice(0, 70) }; } };
    try {
      return {
        reachable: await probe(`http://127.0.0.1:${portOf(live!)}/`).then((r) => ({ ...r, url: "…" })),
        unreachable: await probe(`http://127.0.0.1:${deadAt}/`),
        userinfo: await probe(`http://user:pw@127.0.0.1:${portOf(live!)}/`),
        scheme: await probe("ftp://127.0.0.1/"),
        workspace: await probe(`http://127.0.0.1:${portOf(live!)}/`, join(work, "absent")),
      };
    } finally { await close(live); rmSync(work, { recursive: true, force: true }); }
  },
  /** n1288: the live check is handed to the runner of the machine with the address, the cases, the viewports and the model it was given, and its exit code and report come back. */
  async k_wqa_spawn() {
    const passed = await qaRun(plaque("3 / 3 / 0 / 0"), 0);
    const authorized = await qaRun(plaque("3 / 3 / 0 / 0"), 0, { authorized: true, cases: ["Home opens"], viewports: "375" });
    const none = await qaRun(null, 0);
    const bad = await qaRun(plaque("3 / 3 / 0 / 0"), 0, { url: "ftp://127.0.0.1/" }).then(() => "ran", (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    const production = await qaRun(plaque("3 / 3 / 0 / 0"), 0, { envClass: "production" }).then(() => "ran", (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    const slim = (r: Awaited<ReturnType<typeof qaRun>>) => ({ runner: r.result.runner, exit: r.result.exitCode, verdict: r.result.verdict, report: r.result.reportPath, model: r.result.actualModel, backend: r.result.actualBackend, reason: r.result.reason });
    return { passed: { ...slim(passed), argv: passed.argv.filter((arg) => !arg.startsWith("/")) }, authorized: authorized.argv.filter((arg) => !arg.startsWith("/")), none: slim(none), bad, production };
  },
  /** n1289: the plaque says passed, failed or blocked and how many controls were pressed: a check is passed only when every control passed. */
  async k_wqa_result() {
    const verdicts = Object.fromEntries(([["all", "3 / 3 / 0 / 0", 0], ["failed", "3 / 2 / 1 / 0", 0], ["blocked", "3 / 2 / 0 / 1", 0], ["pending", "4 / 2 / 0 / 0 / 2", 0], ["sum", "3 / 3 / 1 / 0", 1], ["zero", "0 / 0 / 0 / 0", 0], ["exit", "3 / 3 / 0 / 0", 1]] as const).map(([name, counts, exit]) => [name, browserQaVerdict(plaque(counts), exit)]));
    const run = await qaRun(plaque("3 / 2 / 1 / 0"), 0);
    const missing = await qaRun(null, 0);
    return { verdicts, noPlaque: browserQaVerdict("no totals here", 0), failedRun: { verdict: run.result.verdict, text: run.result.reportText?.trim().split("\n").at(-1), path: run.result.reportPath, artifacts: run.result.artifacts.map((a) => a.path).sort() }, missing: { verdict: missing.result.verdict, reason: missing.result.reason, text: missing.result.reportText } };
  },
  /** n1290: a failed check goes back to the builder; a blocked one does not; the family stops at the writer.qa_stop_after-th failure (two by default). */
  k_wqa_route() {
    const r = (...states: string[]) => states.map((state, index) => ({ state, updatedAt: index }));
    return {
      one: qaRoute(r("failed")), blocked: qaRoute(r("blocked")), laterFailed: qaRoute(r("blocked", "failed")), laterBlocked: qaRoute(r("failed", "blocked")),
      stopTwo: qaRoute(r("failed", "failed"), qaStopAfter(undefined)), oneOfTwo: qaRoute(r("failed"), qaStopAfter(undefined)), stopThree: qaRoute(r("failed", "failed"), qaStopAfter("3")),
      never: qaRoute(r("failed", "failed", "failed"), qaStopAfter("off")), byTime: qaRoute([{ state: "blocked", updatedAt: 1 }, { state: "failed", updatedAt: 5 }].reverse()),
      defaults: [qaStopAfter(undefined), qaStopAfter("0"), qaStopAfter("off"), qaStopAfter("4"), qaStopAfter("x")],
    };
  },

  // ---- the review pipeline
  /** n1291: a code review that is switched off by the project's config, or by the quick quality mode, does nothing: it asks no provider, takes no files and records a skipped receipt with the reason. */
  async k_wr_gate() {
    return { off: await critiqueRun({ "code_critique.enabled": "off" }), quick: await critiqueRun({ "code_critique.enabled": "on" }, { quality_mode: "quick" }) };
  },
  /** n1292: the files to review: the list that was given first, else the commits of the range, else the pull request's files; lock files and vendored folders never count. */
  async k_wr_scope() {
    const files = (checkout: string, names: string[]) => { for (const name of names) { mkdirSync(join(checkout, name, ".."), { recursive: true }); writeFileSync(join(checkout, name), "x\n"); } };
    const range = (git: (...args: string[]) => void, checkout: string, names: string[]) => { files(checkout, names); git("add", "."); git("commit", "-q", "-m", "two"); };
    const given = await diffFiles({ files: ["src/x.ts", "src/y.ts"], range: "HEAD~1..HEAD" }, (checkout, git) => range(git, checkout, ["src/a.ts"]));
    const ranged = await diffFiles({ files: [], range: "HEAD~1..HEAD" }, (checkout, git) => range(git, checkout, ["src/a.ts", "src/b.ts", "package-lock.json", "node_modules/x/i.js", "dist/o.js", "yarn.lock"]));
    const commits = await diffFiles({ range: ["HEAD"] }, (checkout, git) => range(git, checkout, ["src/c.ts"]));
    const nothing = await diffFiles({}, () => undefined);
    const many = await diffFiles({ range: "HEAD~1..HEAD" }, (checkout, git) => range(git, checkout, Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)));
    const some = await diffFiles({ range: "HEAD~1..HEAD" }, (checkout, git) => range(git, checkout, Array.from({ length: 4 }, (_, i) => `src/g${i}.ts`)));
    return { given, ranged, commits, nothing, many: [many.count, many.level], some: [some.count, some.level] };
  },
  /** n1293: an empty scope stops the review: nothing is read, no reviewer starts, and the answer is a pass with no findings. */
  async k_wr_empty() {
    const stubs = (count: number) => ({ scope: { files: Array.from({ length: count }, (_, i) => `f${i}.ts`), count, level: "quick" }, prepass: { findings: [], notes: "", critical_count: 0, rework: false } });
    const empty = await runSim("lp.review", { input: { dimensions: ["correctness"], range: "a..b" }, stubs: stubs(0) });
    const some = await runSim("lp.review", { input: { dimensions: ["correctness"], range: "a..b" }, stubs: stubs(2) });
    const out = outOf(empty);
    return { empty: [ranOf(empty), out.status, out.findings, out.critical_count, empty.called("dims:child").length], some: ranOf(some).split(" ").slice(0, 4).join(" "), someDims: some.called("dims:child").length };
  },
  /** n1294: the cheap structural check runs before any model: a finding that is already a rework ends the review there, otherwise the reviewers start. */
  async k_wr_prepass() {
    const scope = { files: ["a.ts"], count: 1, level: "quick" };
    const rework = await runSim("lp.review", { input: { dimensions: ["correctness"], range: "a..b" }, stubs: { scope, prepass: { findings: [{ severity: "critical", file: "a.ts", line: 3, evidence: "<<<<<<< conflict marker" }], notes: "conflict marker", critical_count: 1, rework: true } } });
    const clean = await runSim("lp.review", { input: { dimensions: ["correctness"], range: "a..b" }, stubs: { scope, prepass: { findings: [], notes: "", critical_count: 0, rework: false } } });
    return { rework: [ranOf(rework), outOf(rework).status, rework.called("dims:child").length, rework.called("spec_check").length], clean: [ranOf(clean).split(" ").slice(0, 4).join(" "), clean.called("dims:child").length, clean.called("spec_check").length] };
  },
  /** n1295: the reviewer is started at the depth of the quality mode: two dimensions in quick, four in standard, seven in full. */
  async k_wr_spawn() {
    const run = async (mode: "quick" | "standard" | "full") => {
      const dims: string[] = [];
      const stubs = { "git.diff_files": { files: ["a.ts", "b.ts"], count: 2, level: "quick" }, prepass: { findings: [], notes: "", critical_count: 0, rework: false }, dims: (ctx: { input: Row }) => { dims.push(String(ctx.input.item)); return {}; } };
      await runSim("code-review", { input: { range: "a..b" }, mode, stubs: stubs as never });
      return dims;
    };
    return { quick: await run("quick"), standard: await run("standard"), full: await run("full") };
  },
  /** n1296: a finished review wave is kept in the phase as REVIEW.md, one section per wave, committed with the wave in its message; a later pass over a wave replaces that wave's section only. */
  async k_wr_commit() {
    const written: Array<{ path: string; message: string }> = [], waves: Row[] = [], texts = new Map<string, string>();
    const stages = createAutoStages({ log: () => undefined } as never, { workflowEngine: {} } as never, {
      api: { waveReview: (input: Row) => { waves.push(input); } }, exhausted: async () => undefined, get: () => phase({}, "execution"), save: () => undefined, book: () => undefined,
      writeDocs: async (_p: unknown, files: Array<{ path: string; content: string }>, message: string) => { for (const file of files) { texts.set(file.path, file.content); written.push({ path: file.path, message }); } return { written: files.map((file) => file.path) }; },
      readText: async (_p: unknown, path: string) => texts.get(path) ?? null, runtime: () => null, pmIdle: async () => true, now: () => 10,
    } as never);
    const run = (wave: number, output: Row) => stages.apply(phase({}, "execution"), { kind: "review", wfRunId: `w${wave}`, startedAt: 1, wave } as never, output);
    const doc = () => texts.get(`.agents/phases/${PH}/REVIEW.md`)?.split("\n").filter(Boolean).map((line) => line.replace(/reviewer .*/, "reviewer <by>"));
    await run(1, { status: "pass", critical_count: 0, high_count: 0, findings: [] });
    const first = doc();
    await run(2, { status: "rework", critical_count: 1, high_count: 2, findings: [{ file: "src/a.ts", line: 3, title: "bad" }] });
    const second = doc();
    await run(1, { status: "rework", critical_count: 0, high_count: 1, findings: [{ path: "src/b.ts", message: "late" }] });
    return { first, second, replaced: doc(), written, waves: waves.map((w) => [w.wave, w.state]) };
  },
  /** n1297: the review hands the fix over: with rework it offers review-fix with the findings; review-fix with those findings fixes exactly them and does not review again first. */
  async k_wr_fix() {
    const review = await runSim("code-review", { input: { range: "main..feature" }, stubs: { "lp.review": { status: "rework", findings: [FINDING], high_count: 1 } } });
    const fix = await runSim("review-fix", { input: { goal: "Fix the review findings", findings: [FINDING] }, stubs: reviewStubs({ "lp.review": { status: "pass", remaining_actionable: 0 } }) });
    const audit = await runSim("review-fix", { input: { goal: "Fix", range: "a..b" }, stubs: reviewStubs({ "lp.review": [{ status: "rework", findings: [FINDING] }, { status: "pass", remaining_actionable: 0 }] }) });
    return {
      offered: [outOf(review).status, outOf(review).proposed_workflow],
      fix: { path: ranOf(fix), skipped: fix.skipped, gaps: fix.called("plan_fix")[0]?.input.gaps ?? null, mode: fix.called("plan_fix")[0]?.input.mode ?? null, status: outOf(fix).status },
      audit: { path: ranOf(audit), reviewed: audit.called("first_review").length, gaps: audit.called("plan_fix")[0]?.input.gaps ?? null },
    };
  },
};
void chmodSync;
