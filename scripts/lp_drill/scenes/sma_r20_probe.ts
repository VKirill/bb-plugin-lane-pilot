// Probe of scenes/sma_r20.py (region 20, Terminal coordination): drives the REAL code of THIS checkout with TWO actors against one scratch state and prints
// what each of them saw as one JSON line. It judges nothing: the scene compares each value with the card's expected result and prove()s it.
// No model, no hub write: kv and the database are the fake host's, git repositories are temporary folders, the webhook is a stand-in fetch.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../../src/rooms/core/server/core";
import { registerCli } from "../../../src/rooms/tools/server/cli";
import { migrations, openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt, createRun, createTask, listEvidence, saveProjectSetting, savePrototypeConfig } from "../../../src/rooms/storage";
import { claimScope, listClaims, listLiveWindows, noteCheckoutGuest, projectCheckoutPaths, releaseClaim, windowCollisions, workFingerprint } from "../../../src/rooms/verification/server";
import { buildCapsule } from "../../../src/rooms/session-hooks/logic";
import { createRelay, type RelayItem } from "../../../src/rooms/relay/server/relay";
import { EVENT_FIELDS, postEvent, taskEventBody } from "../../../src/rooms/relay/server/outbound";
import { collectHandoffBrief } from "../../../src/rooms/writer/server/writer-handoff";
import { BASE_MOVED } from "../../../src/rooms/verification/git-integrate/git-core";
import { integrateWorktree, syncWorktree } from "../../../src/rooms/verification/git-integrate/merge";
import { stateBlockText, stateBlockSections, parseState, STATE_BLOCK_START, STATE_BLOCK_END } from "../../../src/rooms/phase/stages";
import migrationLock from "../../../tests/fixtures/migrations.lock.json";

const s: Record<string, any> = {};
const PATH = "/repo/plugin";
const hour = 3_600_000;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function world(hostCall: (method: string, input: { command?: string }) => Promise<unknown> = async () => ({ exitCode: 0, stdout: "", stderr: "" })) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { getPluginMetadata: async () => null, get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "P" }) } } as never });
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo/pm", writerWorkspacePath: PATH, pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
  bb.hosts.experimental_client = (() => ({ call: hostCall })) as never;
  registerCli(createCore(bb, db), {} as never, migrations);
  return { bb, harness, db, kv: bb.storage.kv };
}
const run = async (w: ReturnType<typeof world>, ...args: string[]) => w.harness.behavior.runCli(args);

// ---- windows: n1517 n1519 n1520 n1523 n1534 n1535 n1536 n1539 n1540 n1538 ----
{
  const w = world(async (_m, input) => {
    const command = input.command ?? "";
    if (command === "git rev-parse HEAD") return { exitCode: 0, stdout: "ba5e123\n", stderr: "" };
    if (command === "git rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: "main\n", stderr: "" };
    if (command.startsWith("git status --porcelain -uall --")) return { exitCode: 0, stdout: " M src/app.ts\n", stderr: "" };
    if (command.startsWith("git status")) return { exitCode: 0, stdout: " M docs/readme.md\n M src/app.ts\n", stderr: "" };
    if (command.startsWith("git diff")) return { exitCode: 0, stdout: "src/app.ts\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  createRun(w.db, "run", "P", "cli", PATH);
  createTask(w.db, { id: "t1", runId: "run", kind: "cli", contract: { id: "t1", owns_paths: ["src/**"] } as never });
  createAttempt(w.db, { id: "a1", runId: "run", taskId: "t1" });
  // thr_a and thr_b are two terminals of one project.
  await noteCheckoutGuest(w.bb, w.db, "thr_a", PATH, { providerId: "claude-code" });
  await noteCheckoutGuest(w.bb, w.db, "thr_b", PATH);
  const a1 = await run(w, "window", "claim", "P", "thr_a", "ui", "src/**", "front end");
  const b1 = await run(w, "window", "claim", "P", "thr_b", "docs", "docs/**");
  const b2 = await run(w, "window", "claim", "P", "thr_b", "ui", "lib/**");
  s.claim = { a: [a1.exitCode, a1.stdout], b: [b1.exitCode], taken: [b2.exitCode, b2.stderr] };
  const status = await run(w, "window", "status", "P");
  s.status = { exit: status.exitCode, out: status.stdout };
  const paths = projectCheckoutPaths(w.db, "P");
  const live = await listLiveWindows(w.kv as never, paths);
  s.registry = { live: live.map((row) => row.threadId).sort(), provider: live.find((row) => row.threadId === "thr_a")?.providerId ?? null, afterTtl: (await listLiveWindows(w.kv as never, paths, Date.now() + 7 * hour)).length };
  s.claims = (await listClaims(w.kv as never, PATH)).map((c) => `${c.name}:${c.threadId}:${c.globs.join(",")}`).sort();
  // two claims fired together: exactly one wins the name
  const w2 = world();
  const race = await Promise.all([claimScope(w2.kv as never, { path: PATH, threadId: "thr_x", name: "api", globs: ["a/**"] }), claimScope(w2.kv as never, { path: PATH, threadId: "thr_y", name: "api", globs: ["b/**"] })]);
  s.race = { winners: race.filter((r) => r.ok).length, loser: race.find((r) => !r.ok) ? (race.find((r) => !r.ok) as { code?: string }).code : null, kept: (await listClaims(w2.kv as never, PATH)).length };
  const bad = await claimScope(w2.kv as never, { path: PATH, threadId: "thr_z", name: "bad", globs: ["../x/**", "ok/**"] });
  s.race.invalid = bad.ok ? "stored" : bad.code;
  s.race.afterInvalid = (await listClaims(w2.kv as never, PATH)).map((c) => c.name);
  s.collision = {
    hits: windowCollisions([{ name: "ui", globs: ["src/**"] }, { name: "page", globs: ["src/page/**"] }, { name: "docs", globs: ["docs/**"] }], [{ id: "t1", globs: ["src/app.ts"] }]),
    bad: windowCollisions([{ name: "x" } as never], null as never),
  };
  const fp = await workFingerprint({ call: async (_m: string, input: { command?: string }) => (input.command === "git rev-parse --abbrev-ref HEAD" ? { exitCode: 0, stdout: "feat\n", stderr: "" } : { exitCode: 0, stdout: Array.from({ length: 60 }, (_, i) => ` M f${i}.ts`).join("\n"), stderr: "" }) } as never, "h1", PATH);
  s.fingerprint = { branch: fp.branch, n: fp.paths.length };
  // a foreign window cannot release thr_a's claim; the holder's release leaves a record under its name; abandoned is told apart
  const forged = await releaseClaim(w.kv as never, { path: PATH, threadId: "thr_b", name: "ui" });
  const viaVerb = await run(w, "window", "release", "P", "thr_b", "ui");
  const evidenceAfterForgery = (await listEvidence(w.kv as never, "P", { op: "window" })).length;
  const relA = await run(w, "window", "release", "P", "thr_a", "ui", "--outcome", "abandoned");
  const relB = await run(w, "window", "release", "P", "thr_b", "docs", "--outcome", "handed_off");
  const records = await listEvidence(w.kv as never, "P", { op: "window" });
  const check = (target: string, name: string) => records.find((r) => r.target === target)?.checks.find((c) => c.name === name);
  s.release = {
    forged: [forged.ok, (forged as { code?: string }).code, (forged as { holder?: string }).holder], verb: [viaVerb.exitCode, viaVerb.stderr], evidenceAfterForgery,
    a: [relA.exitCode, relA.stdout], b: [relB.exitCode, relB.stdout], left: (await listClaims(w.kv as never, PATH)).length,
    records: records.map((r) => `${r.target}:${r.by}`).sort(), outcomeUi: [check("ui", "outcome")?.ok, check("ui", "outcome")?.detail], outcomeDocs: [check("docs", "outcome")?.ok, check("docs", "outcome")?.detail],
    filesUi: check("ui", "files")?.detail, baseUi: check("ui", "base")?.detail,
  };
  // force-clear: refused without a reason, then the foreign claim goes and the second window can take the name
  const w3 = world();
  await run(w3, "window", "claim", "P", "thr_a", "ui", "src/**");
  const noReason = await run(w3, "window", "force-clear", "P", "ui");
  const stillThere = (await listClaims(w3.kv as never, PATH)).length;
  const fromChat = await w3.harness.behavior.runCli(["window", "force-clear", "P", "ui", "--reason", "x"], { threadId: "thr_b" });
  const cleared = await run(w3, "window", "force-clear", "P", "ui", "--reason", "thr_a is gone");
  const takeover = await run(w3, "window", "claim", "P", "thr_b", "ui", "lib/**");
  const holderRecord = (await listEvidence(w3.kv as never, "P", { op: "window" }))[0]?.checks.find((c) => c.name === "holder")?.detail;
  s.forceClear = { noReason: [noReason.exitCode, stillThere], fromChat: fromChat.exitCode, cleared: [cleared.exitCode, cleared.stdout], takeover: takeover.exitCode, now: (await listClaims(w3.kv as never, PATH)).map((c) => `${c.name}:${c.threadId}`), holderRecord };
  // heartbeat: a window that keeps sending keeps its lease, a quiet one drops out
  const w4 = world();
  await noteCheckoutGuest(w4.bb, w4.db, "thr_a", PATH);
  await noteCheckoutGuest(w4.bb, w4.db, "thr_b", PATH);
  await claimScope(w4.kv as never, { path: PATH, threadId: "thr_a", name: "ui", globs: ["src/**"] });
  const KEY = "checkout-guests:/repo/plugin";
  const old = (await w4.kv.get(KEY)) as Array<{ threadId: string; at: number }>;
  await w4.kv.set(KEY, old.map((row) => ({ ...row, at: row.at - 5.5 * hour })) as never);
  await noteCheckoutGuest(w4.bb, w4.db, "thr_a", PATH);
  const later = await listLiveWindows(w4.kv as never, projectCheckoutPaths(w4.db, "P"), Date.now() + hour);
  s.heartbeat = { live: later.map((r) => r.threadId), claims: (await listClaims(w4.kv as never, PATH, Date.now() + hour)).map((c) => c.name) };
}

// ---- relay: n1524 ----
{
  let items: RelayItem[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const relay = createRelay({ load: async () => structuredClone(items), save: async (next) => { items = structuredClone(next); }, send: async (threadId, text) => { sent.push({ threadId, text }); },
    settled: async () => true, output: async () => "", taskStates: async () => ({}), now: () => 1_000_000, log: () => undefined });
  const ask = await relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
  const again = await relay.ask({ projectId: "P", fromThreadId: "thr_pm", toThreadId: "thr_writer", question: "Which files do you hold?" });
  const intruder = await relay.reply({ askId: ask.id, fromThreadId: "thr_other", answer: "mine" }).then(() => "accepted", (e: Error) => e.message);
  const sentBeforeAnswer = sent.length;
  await relay.reply({ askId: ask.id, fromThreadId: "thr_writer", answer: "src/** until 14:00" });
  s.ask = { first: [sent[0]?.threadId, sent[0]?.text.includes("Which files do you hold?"), sent[0]?.text.includes(ask.id)], repeat: again.alreadyWaiting === true, sentBeforeAnswer, intruder, answer: [sent[1]?.threadId, sent[1]?.text.includes("src/** until 14:00")], answeredAt: items[0] && (items[0] as { answeredAt: number | null }).answeredAt };
}

// ---- test impact analysis: n1525 ----
{
  const repo = mkdtempSync(join(tmpdir(), "sma-r20-tia-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  for (const dir of ["src", "tests", "scripts"]) mkdirSync(join(repo, dir), { recursive: true });
  cpSync(join(process.cwd(), "scripts", "test-changed.mjs"), join(repo, "scripts", "test-changed.mjs"));
  writeFileSync(join(repo, "src", "widget.ts"), "export function widget() { return 1 }\n");
  writeFileSync(join(repo, "tests", "alpha.test.ts"), 'import { widget } from "../src/widget";\nconsole.log(widget());\n');
  writeFileSync(join(repo, "tests", "beta.test.ts"), "console.log('unrelated');\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "src", "widget.ts"), "export function widget() { return 2 }\n");
  const listed = execFileSync("node", ["scripts/test-changed.mjs", "--list"], { cwd: repo, encoding: "utf8" });
  s.tia = { alpha: listed.includes("tests/alpha.test.ts"), beta: listed.includes("tests/beta.test.ts") };
  rmSync(repo, { recursive: true, force: true });
}

// ---- hand-off brief and capsule: n1528 n1547 ----
{
  const events = [{ data: { item: { type: "agentMessage", text: "parser nearly done" } } }, { data: { item: { type: "commandExecution", command: "npm test -- parser", exitCode: 1, aggregatedOutput: "AssertionError: parser boom" } } }];
  const bb = { log: { warn: () => undefined, error: () => undefined, info: () => undefined }, sdk: { threads: { events: { list: async (q: { types?: unknown }) => (q.types ? events : []) } } } };
  const host = { call: async () => ({ exitCode: 0, stdout: " M src/parser.ts\n", stderr: "" }) };
  const brief = await collectHandoffBrief({ bb: bb as never, host: host as never, hostId: "h1", threadId: "thr_first", workspacePath: "/wt/a1", stopReason: "provider_error: limit" });
  s.handoff = { reason: brief.includes("Stop reason: provider_error: limit"), dirty: brief.includes(" M src/parser.ts"), failing: brief.includes("Last failing command (exit 1): npm test -- parser"), tail: brief.includes("AssertionError: parser boom"), instruction: brief.includes("Do not start over") };
  const asks = Array.from({ length: 9 }, (_, i) => `ask ${i} ${"x".repeat(400)}`);
  const files = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`);
  const capsule = buildCapsule({ asks, files, claims: files.slice(), trigger: "precompact" });
  s.capsule = { asks: capsule.asks.map((a) => a.slice(0, 5)), askLen: capsule.asks.map((a) => a.length), files: capsule.files.length, claims: capsule.claims.length, trigger: capsule.trigger };
}

// ---- outward status: n1529 n1548 ----
{
  const body = taskEventBody({ event: "task.accepted", projectId: "P", taskId: "t1", title: "x".repeat(500), attempt: 3, contract: { owns_paths: ["secret/**"] }, output: "stdout" });
  s.body = { keys: Object.keys(body), title: String(body.title).length, attempt: body.attempt, extra: Object.keys(body).filter((k) => !(EVENT_FIELDS as readonly string[]).includes(k)) };
  const w = world();
  const posts: Array<{ url: string; body: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { posts.push({ url: String(url), body: String(init.body) }); return new Response("ok"); }) as never;
  try {
    saveProjectSetting(w.db, "P", "events.webhook_url", "http://hooks.example/lp");
    const http = await postEvent(w.db, "P", { event: "owner.waiting", state: "waiting" });
    saveProjectSetting(w.db, "P", "events.webhook_url", "https://hooks.example/lp");
    const https = await postEvent(w.db, "P", { event: "owner.waiting", state: "waiting", title: "needs you", projectId: "EVIL", contract: { secret: 1 }, output: "leak" }, () => undefined);
    const other = await postEvent(w.db, "Q", { event: "owner.waiting" });
    const sentBody = posts[0] ? JSON.parse(posts[0].body) as Record<string, unknown> : {};
    s.post = { http, https, other, posts: posts.length, keys: Object.keys(sentBody), projectId: sentBody.projectId, leak: JSON.stringify(sentBody).match(/secret|leak/) !== null };
  } finally { globalThis.fetch = real; }
}

// ---- migrations as the shared counter: n1537 ----
{
  const hashes = migrations.map((m) => createHash("sha256").update(m).digest("hex"));
  const a = createFakePluginHost({ pluginId: "lane-pilot" }).bb; const dbA = a.storage.database();
  a.storage.migrate(dbA, migrations as never);
  let appendOk = true; try { a.storage.migrate(dbA, [...migrations, "CREATE TABLE branch_a_added(x)"] as never); } catch { appendOk = false; }
  const b = createFakePluginHost({ pluginId: "lane-pilot" }).bb; const dbB = b.storage.database();
  b.storage.migrate(dbB, migrations as never);
  let middle = "accepted"; try { b.storage.migrate(dbB, [...migrations.slice(0, 40), "CREATE TABLE branch_b_added(x)", ...migrations.slice(40)] as never); } catch (e) { middle = (e as Error).message; }
  s.slots = { locked: hashes.length === (migrationLock as string[]).length && hashes.every((h, i) => h === (migrationLock as string[])[i]), appendOk, middle };
}

// ---- git copies: n1532 n1544 n1542 ----
{
  const root = mkdtempSync(join(tmpdir(), "sma-r20-git-"));
  const base = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "main", base]);
  writeFileSync(join(base, "page.vue"), "hero\nhow\nfaq\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const tree = (name: string) => { const p = join(root, name); git(base, "worktree", "add", "-q", "-b", `bb/${name}`, p, "main"); return p; };
  const a = tree("a"), b = tree("b"), c = tree("c");
  writeFileSync(join(a, "page.vue"), "hero from a\nhow\nfaq\n");
  const mergedA = await integrateWorktree({ basePath: base, worktreePath: a, message: "a" });
  writeFileSync(join(b, "other.ts"), "export {};\n");
  const mergedB = await integrateWorktree({ basePath: base, worktreePath: b, message: "b", committedOnly: false });
  const synced = await syncWorktree({ basePath: base, worktreePath: a });
  const mainHead = git(base, "rev-parse", "HEAD").trim();
  s.sync = { merged: [mergedA.status, mergedB.status], status: synced.status, head: synced.head === mainHead, sawOther: existsSync(join(a, "other.ts")), again: (await syncWorktree({ basePath: base, worktreePath: a })).status };
  // a worktree with uncommitted edits is refused and kept; a conflicting sync is undone and names the file
  writeFileSync(join(c, "page.vue"), "half done\n");
  const dirty = await syncWorktree({ basePath: base, worktreePath: c });
  git(c, "checkout", "--", "page.vue");
  writeFileSync(join(c, "page.vue"), "hero C\nhow\nfaq\n"); git(c, "add", "-A"); git(c, "commit", "-qm", "c");
  const cHead = git(c, "rev-parse", "HEAD").trim();
  const clash = await syncWorktree({ basePath: base, worktreePath: c });
  s.sync.dirty = dirty.status; s.sync.clash = [clash.status, clash.reason?.includes("page.vue") ?? false, git(c, "rev-parse", "HEAD").trim() === cHead, git(c, "status", "--porcelain").trim() === ""];
  // merge gate: a candidate that did not take main in is refused with BASE_MOVED and main stays
  const d = tree("d");
  writeFileSync(join(d, "d.ts"), "export const d = 1;\n"); git(d, "add", "-A"); git(d, "commit", "-qm", "d");
  writeFileSync(join(base, "main-moves.txt"), "x\n"); git(base, "add", "-A"); git(base, "commit", "-qm", "main moves");
  const moved = git(base, "rev-parse", "HEAD").trim();
  const stale = await integrateWorktree({ basePath: base, worktreePath: d, message: "d", committedOnly: true, baseInHead: true });
  const unchanged = git(base, "rev-parse", "HEAD").trim() === moved;
  await syncWorktree({ basePath: base, worktreePath: d });
  const fresh = await integrateWorktree({ basePath: base, worktreePath: d, message: "d", committedOnly: true, baseInHead: true });
  s.gate = { stale: [stale.status, (stale.reason ?? "").includes(BASE_MOVED), unchanged], fresh: fresh.status, landed: existsSync(join(base, "d.ts")) };
  rmSync(root, { recursive: true, force: true });
}

// ---- STATE.md: n1526 n1545 (the pure core both verbs compose; the verbs themselves are proved by their unit tests) ----
{
  const HAND = "# Project state\r\n\r\n## Decisions\r\n\r\n### Storage\r\n- chose sqlite, do not change\r\n\r\n## Notes\r\nmy own notes";
  const first = stateBlockText(HAND, {}, { Position: ["stage planning"], Decisions: ["manual: use WAL"] });
  const text = "text" in first ? first.text : "";
  const second = stateBlockText(text, {}, { Position: ["stage execution"] }, true);
  const text2 = "text" in second ? second.text : "";
  const outside = (t: string) => t.slice(0, t.indexOf(STATE_BLOCK_START)) + t.slice(t.indexOf(STATE_BLOCK_END) + STATE_BLOCK_END.length);
  s.state = { keepsHand: text.startsWith(HAND), outsideSame: outside(text2).startsWith(HAND), blockHasWal: stateBlockSections(text2).Decisions ?? [], stage: stateBlockSections(text2).Position ?? [], parsed: parseState(text2).sections.Decisions ?? [], personalHeading: text.includes("## Decisions (Lane Pilot)"), broken: "refused" in stateBlockText(`# Mine\n${STATE_BLOCK_START}\nno end`, {}, { Position: ["x"] }) };
}

console.log(JSON.stringify(s)); // guardian: allow (a probe prints its observations as one JSON line)
process.exit(0);
