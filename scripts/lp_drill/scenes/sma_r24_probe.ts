// Probe of scenes/sma_r24.py: runs the real safety-net code paths of THIS checkout (the commit under drill) on scratch state — a fake plugin
// host with an in-memory database, a throw-away git repository, a throw-away HOME, the guard hook as a real python process — and prints one
// JSON line {nodes: {nNNNN: {ok, detail}}}. It writes nothing to the hub database, calls no model and no network. The scene prove()s each node.
// The scene starts this file with HOME pointing at a scratch folder: the guard's permit and reflex files and the store journal land there,
// and a check that would write under a HOME that is not a scratch folder refuses instead.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations, openDatabase } from "../../../src/rooms/plugin-db";
import type { Services } from "../../../server";
import { createCore } from "../../../src/rooms/core/server/core";
import { registerCli } from "../../../src/rooms/tools/server/cli";
import { answerPermit } from "../../../src/rooms/host-worker/handlers/machine";
import { breakerRowId, listTripped, noteBreakerRound, ruleHash, trippedRules } from "../../../src/rooms/learning/breaker";
import { claudeExecLine } from "../../../src/rooms/native-agent/native-claude-host";
import { PRICE_LIST, priceOf, rowUsd, spendBook } from "../../../src/rooms/money/logic";
import { POLICY, classifyChange } from "../../../src/rooms/policy/policy";
import { integrityReport, rearmExpiredDisarms } from "../../../src/rooms/policy/protections";
import { createRollback } from "../../../src/rooms/rollback/server/rollback";
import { conventionGateHits, stallFailed, stallObserve, type StallState } from "../../../src/rooms/session-hooks/logic";
import { createAttempt } from "../../../src/rooms/storage/attempts-store";
import { listEvidence, recordEvidence } from "../../../src/rooms/storage/evidence-store";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { saveProjectSetting, savePrototypeConfig } from "../../../src/rooms/storage/settings-store";
import { appendGateEvaluation } from "../../../src/rooms/storage/stages-store";
import { createTask } from "../../../src/rooms/storage/tasks-store";
import { noteProtectionDisarm } from "../../../src/rooms/storage/protections-store";
import { readGateReport } from "../../../src/rooms/tasks/gate-report";
import { recordStage } from "../../../src/rooms/runs/server/stage-records";
import { STORE_JOURNAL, journalStoreInstall } from "../../../src/rooms/verification/git-integrate/deps-install";
import { createWorktree, removeLaneWorktree } from "../../../src/rooms/verification/git-integrate/worktree-lifecycle";
import { integrateWorktree } from "../../../src/rooms/verification/git-integrate/merge";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../../src/rooms/verification/git-rollback";
import { resolveGitOwnershipBase } from "../../../src/rooms/verification/git-ownership";
import { gateResolverFor } from "../../../src/rooms/verification/server/gate-detect";
import { PROGRESS_CAP, progressJournal } from "../../../src/rooms/writer/progress-journal";

type Seen = { ok: boolean; detail: string };
const seen: Record<string, Seen> = {};
const GUARD = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const HOME = homedir();
const scratchHome = HOME.startsWith(tmpdir());
const refused = (): Seen => ({ ok: false, detail: `refused: HOME is ${HOME}, not a scratch folder` });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const IDENT = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT } });
const scratch = (name: string) => mkdtempSync(join(tmpdir(), `lp-r24-${name}-`));
const guard = (payload: Record<string, unknown>, env: Record<string, string> = {}) => {
  const ran = spawnSync("python3", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return ran.stdout + ran.stderr;
};
const bash = (command: string, cwd: string, session = "sess-r24") => ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: session });
const WRITER = { LANE_PILOT_ROLE: "writer" };
const cliHost = (services: unknown = {}) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  registerCli(createCore(bb, db), services as Services, migrations);
  return { bb, harness, db };
};
async function node(id: string, run: () => Promise<Seen> | Seen): Promise<void> {
  try { seen[id] = await run(); } catch (error) { seen[id] = { ok: false, detail: `the probe threw: ${String((error as Error)?.stack ?? error).slice(0, 300)}` }; }
}

// ---- owner verbs ----
await node("n1653", async () => {
  const root = scratch("undo");
  const base = join(root, "project");
  git(root, "init", "-q", "-b", "main", base);
  writeFileSync(join(base, "server.ts"), "line1\nline2\nline3\n");
  git(base, "add", "-A"); git(base, "commit", "-qm", "base");
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", base, "none", undefined, "host-1");
  const host = {
    call: async (method: string, input: Record<string, any>) => {
      const hostId = "host-1";
      switch (method) {
        case "gitCreateWorktree": return { hostId, ...await createWorktree({ basePath: input.basePath, name: input.name, commit: input.commit, targetPath: join(root, "wt", input.name, basename(input.basePath)) }) };
        case "gitPrepareWorktree": return { hostId, linked: [] };
        case "gitRemoveWorktree": return { hostId, ...await removeLaneWorktree({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitMergeInfo": return { hostId, ...await mergeInfo({ basePath: input.basePath, commit: input.commit, attemptId: input.attemptId }) };
        case "gitRevertCommits": return { hostId, ...await revertCommitsInWorktree({ worktreePath: input.worktreePath, commits: input.commits }) };
        case "gitWorktreeState": return { hostId, ...await worktreeState({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitOwnershipBase": return { hostId, ...await resolveGitOwnershipBase({ projectCwd: input.projectCwd }) };
        case "gitIntegrate": return { hostId, ...await integrateWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, message: input.message, removeWorktree: input.removeWorktree }) };
        default: throw new Error(`unexpected host call ${method}`);
      }
    },
  };
  const { rollback } = createRollback({ bb, db, host, log: () => undefined, isDisposed: () => false, configForRun: async () => ({ projectId: "projA", hostId: "host-1", writerWorkspacePath: base }) } as never, {
    resolveIntegrationGate: gateResolverFor({ host, db, log: () => undefined } as never),
    runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
      const ran = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
      return { command: check.command, exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    }),
  } as never);
  try {
    const task = { schema_version: 2, id: "t1", title: "title of t1", risk: "low", lane: "server", project_cwd: base, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: "t1", acceptance: ["done"], verify: "tests", verification: [{ command: "test -f server.ts", cwd: base }] };
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task });
    createAttempt(db, { id: "att_t1", runId: "run1", taskId: "t1" });
    const made = await createWorktree({ basePath: base, name: "att_t1", targetPath: join(base, "..", "wt", "att_t1", "project") });
    rollback.noteBase("att_t1", made.baseSha);
    writeFileSync(join(made.path!, "server.ts"), "rewritten\n");
    const merged = await integrateWorktree({ basePath: base, worktreePath: made.path!, message: "t1: title of t1\n\nLane-Pilot-Attempt: att_t1", removeWorktree: true });
    rollback.noteMerge("att_t1", merged);
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_t1'").run();
    const before = readFileSync(join(base, "server.ts"), "utf8");
    const result = await rollback.revert("t1");
    const after = readFileSync(join(base, "server.ts"), "utf8");
    const checked = await rollback.reverify("t1");
    return { ok: before === "rewritten\n" && result.ok === true && result.state === "merged" && after === "line1\nline2\nline3\n" && checked.revertedIn === result.commit,
      detail: `an accepted change to server.ts (${JSON.stringify(before.trim())}) was reverted in one call: revert ${result.state}, the file reads ${JSON.stringify(after)}, the later check names the revert commit ${String(checked.revertedIn).slice(0, 8)}` };
  } finally { await harness.lifecycle.dispose(); }
});

await node("n1654", async () => {
  const repo = scratch("airbag-repo");
  const dated = { ...process.env, ...IDENT, GIT_AUTHOR_DATE: "2020-01-01 00:00:00 +0000", GIT_COMMITTER_DATE: "2020-01-01 00:00:00 +0000" };
  git(repo, "init", "-q", "-b", "main"); git(repo, "commit", "-qm", "base", "--allow-empty");
  spawnSync("git", ["commit", "-qm", "old", "--allow-empty"], { cwd: repo, env: dated });
  const old = git(repo, "rev-parse", "HEAD").stdout.trim();
  git(repo, "commit", "-qm", "fresh", "--allow-empty");
  const fresh = git(repo, "rev-parse", "HEAD").stdout.trim();
  git(repo, "update-ref", "refs/lane-airbag/old", old); git(repo, "update-ref", "refs/lane-airbag/fresh", fresh);
  // The verb runs its script on the project's host: the host here is this machine, a plain shell in the repository.
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: ((call: { method: string; input: { cwd?: string; command?: string } }) => {
      if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
      const ran = spawnSync("bash", ["-c", call.input.command ?? ""], { cwd: call.input.cwd, encoding: "utf8" });
      return { hostId: "host-test", exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    }) as never,
  });
  const db = openDatabase(bb);
  registerCli(createCore(bb, db), {} as Services, migrations);
  savePrototypeConfig(db, { projectId: "proj_air", hostId: "host-test", pmWorkspacePath: repo, writerWorkspacePath: repo, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" });
  const refs = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/lane-airbag/").stdout.trim().split("\n").sort();
  const listing = await harness.behavior.runCli(["airbag", "proj_air"]);
  const listed = String(listing.stdout);
  const pruning = await harness.behavior.runCli(["airbag", "proj_air", "--prune", "1"]);
  const afterPrune = refs();
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "x", encoding: "utf8" }).stdout.trim();
  git(repo, "update-ref", "refs/lane-airbag/broken", blob);
  const probing = await harness.behavior.runCli(["airbag", "proj_air", "--probe"]);
  const probed = String(probing.stdout);
  await harness.lifecycle.dispose();
  return { ok: listed.includes("refs/lane-airbag/old") && listed.includes("refs/lane-airbag/fresh") && same(afterPrune, ["refs/lane-airbag/fresh"]) && probed.includes("probe ok refs/lane-airbag/fresh") && probed.includes("probe broken refs/lane-airbag/broken"),
    detail: `the verb listed both points, --prune 1 left ${JSON.stringify(afterPrune)} (the 2020 point gone), --probe: ${probed.split("\n").filter(Boolean).join(" | ")}; exits ${listing.exitCode}/${pruning.exitCode}/${probing.exitCode}${probing.stderr ? ` stderr ${String(probing.stderr).slice(0, 160)}` : ""}` };
});

await node("n1655", () => {
  const now = Date.parse("2026-10-15T12:00:00.000Z");
  const row = (day: string, providerId: string, model: string, inputTokens: number) => ({ day, providerId, model, inputTokens, outputTokens: 0, cachedTokens: 0 });
  const book = spendBook([row("2026-10-02", "anthropic", "claude-haiku", 1_000_000), row("2026-10-02", "claude-code", "claude-sonnet", 5_000_000), row("2026-09-02", "anthropic", "claude-haiku", 1_000_000)], now);
  return { ok: book.monthUsd === 0.8 && book.byProvider.anthropic === 0.8 && book.byProvider["claude-code"] === 0 && book.table.length === 14,
    detail: `this month ${book.monthUsd} USD (anthropic ${book.byProvider.anthropic}, claude-code ${book.byProvider["claude-code"]}); September's row left out; ${book.table.length} days in the series` };
});

await node("n1656", async () => {
  const { bb, harness } = cliHost();
  const kv = bb.storage.kv as never;
  for (let round = 0; round < 3; round++) await noteBreakerRound(kv, { project: "p", target: "fam", fired: ["rule R"] });
  const id = breakerRowId("p", ruleHash("rule R"), "fam");
  const listed = JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout) as Array<Record<string, unknown>>;
  const noWhy = await harness.behavior.runCli(["breaker", "rearm", id]);
  const stillThere = JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout) as unknown[];
  const done = await harness.behavior.runCli(["breaker", "rearm", id, "--why", "reviewed, rule fixed"]);
  const left = JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout) as unknown[];
  await harness.lifecycle.dispose();
  return { ok: listed.length === 1 && listed[0]!.count === 3 && listed[0]!.target === "fam" && noWhy.exitCode === 1 && String(noWhy.stderr).includes("a reason is required") && stillThere.length === 1
    && done.exitCode === 0 && same(JSON.parse(done.stdout), { rearmed: id, by: "owner", why: "reviewed, rule fixed" }) && left.length === 0,
    detail: `a rule tripped after 3 rounds is listed (count ${listed[0]?.count}); a re-arm without a reason exits ${noWhy.exitCode} and the rule stays (${stillThere.length}); with a reason it comes back as ${done.stdout.trim().replace(/\s+/g, " ")}, ${left.length} left` };
});

await node("n1657", async () => {
  const { bb, harness, db } = cliHost();
  const now = Date.now();
  const fire = (task: string, status: string, at: number) => appendGateEvaluation(db, { projectId: "p", runId: "r1", taskId: task, gate: "accept", status, inputSha256: task, outputSha256: null, attempt: 1, occurredAt: at } as never);
  fire("t-ack", "rejected", now - 1000); fire("t-real", "rejected", now - 500); fire("t-ack2", "failed", now - 800);
  const ids = db.prepare("SELECT id, task_id AS task FROM lane_pilot_gate_event ORDER BY id").all() as Array<{ id: number; task: string }>;
  const idOf = (task: string) => ids.find((row) => row.task === task)!.id;
  const read = () => readGateReport(db, { projectId: "p", days: 1, now }, bb.storage.kv as never);
  const before = (await read()).recentGateBlockers.map((row) => row.taskId).sort();
  const noReason = await harness.behavior.runCli(["gates", "ack", String(idOf("t-ack"))]);
  const blockedAfterRefusal = (await read()).recentGateBlockers.length;
  await harness.behavior.runCli(["gates", "ack", String(idOf("t-ack")), "--why", "the file was renamed before the task"]);
  await harness.behavior.runCli(["gates", "ack", String(idOf("t-ack2")), "--why", "flaky network"]);
  const after = await read();
  const accept = after.byGate.find((row) => row.gate === "accept")!;
  await harness.lifecycle.dispose();
  return { ok: same(before, ["t-ack", "t-ack2", "t-real"]) && noReason.exitCode === 1 && blockedAfterRefusal === 3 && same(after.recentGateBlockers.map((row) => row.taskId), ["t-real"]) && accept.total === 3 && accept.falseAlarms === 2,
    detail: `3 firings are blockers; an ack with no reason exits ${noReason.exitCode} and changes nothing; two acks with a reason leave blockers ${JSON.stringify(after.recentGateBlockers.map((row) => row.taskId))}, the accept gate is still counted ${accept.total} with ${accept.falseAlarms} false alarms` };
});

await node("n1658", async () => {
  const { bb, harness } = cliHost();
  const kv = bb.storage.kv as never;
  await recordEvidence(kv, { op: "revert", projectId: "p", target: "t1", why: "gate red on main anyway", checks: [{ name: "integration_gate", ok: false, detail: "skipped on request" }], by: "cli", at: Date.now() - 5000 });
  await recordEvidence(kv, { op: "permit", projectId: "p", target: "h/abc", why: "scratch table", checks: [{ name: "ticket", ok: true }], by: "lane_pilot_permit", at: Date.now() - 1000 });
  const text = String((await harness.behavior.runCli(["evidence", "p"])).stdout);
  const onlyRevert = String((await harness.behavior.runCli(["evidence", "p", "--op", "revert"])).stdout);
  const none = String((await harness.behavior.runCli(["evidence", "p", "--op", "janitor"])).stdout);
  await harness.lifecycle.dispose();
  const lines = text.split("\n");
  return { ok: text.indexOf(" permit h/abc") >= 0 && text.indexOf(" permit h/abc") < text.indexOf(" revert t1") && lines.includes("  why: scratch table") && lines.includes("  checks: ok ticket") && lines.includes("  by: lane_pilot_permit")
    && lines.includes("  checks: FAIL integration_gate — skipped on request") && onlyRevert.includes(" revert t1") && !onlyRevert.includes("permit h/abc") && none === "no evidence records",
    detail: `newest first (permit before revert); each record prints its reason, checks and who; --op revert keeps one record, --op janitor prints «${none}»` };
});

await node("n1659", async () => {
  const { harness, db } = cliHost();
  createRun(db, "run_i", "p", "bb", "/w");
  createTask(db, { id: "t_i", runId: "run_i", kind: "bb", contract: {} });
  const disarmedAt = Date.now() - 60_000;
  noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner", now: disarmedAt });
  recordStage(db, { runId: "run_i", taskId: "t_i", stageId: "code-critique", state: "failed", input: "x", result: { status: "block" } });
  const row = () => integrityReport(db as never, { "code_critique.mode": "advisory" }, "p").find((item) => item.key === "code_critique.mode")!;
  db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=? WHERE task_id='t_i'").run(disarmedAt - 1000);
  const early = row().shadow_findings;
  db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=? WHERE task_id='t_i'").run(disarmedAt + 1000);
  const late = row();
  const noWhy = await harness.behavior.runCli(["integrity", "p", "--renew", "code_critique.mode", "--days", "30"]);
  const renewed = await harness.behavior.runCli(["integrity", "p", "--renew", "code_critique.mode", "--days", "30", "--why", "still auditing the critic"]);
  await harness.lifecycle.dispose();
  return { ok: same(early, []) && late.disarmed === true && same(late.shadow_findings, [{ taskId: "t_i", stageId: "code-critique", state: "failed", at: disarmedAt + 1000 }]) && noWhy.exitCode === 1 && renewed.exitCode === 0 && JSON.parse(renewed.stdout).renewals.length === 1,
    detail: `a gate disarmed at T: a critique that failed before T is no shadow finding (${early.length}), one after T is (${JSON.stringify(late.shadow_findings.map((item) => item.taskId))}); renew with no reason exits ${noWhy.exitCode}, with a reason it records ${JSON.parse(renewed.stdout).renewals.length} renewal` };
});

// ---- the airbag, the guard and the permit round trip (the real hook, a real python process) ----
await node("n1660", () => {
  if (!scratchHome) return refused();
  const repo = scratch("airbag");
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "committed\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  writeFileSync(join(repo, "tracked.txt"), "edited\n"); writeFileSync(join(repo, "untracked.txt"), "never added\n");
  const out = guard(bash("git reset --hard", repo), WRITER);
  const ref = git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/lane-airbag/").stdout.trim().split(" ");
  const advice = /\[git-airbag\] saved as (refs\/lane-airbag\/\d+): git checkout ([0-9a-f]{10}) -- \. brings it back/.exec(out);
  const shown = (path: string) => git(repo, "show", `${ref[1]}:${path}`).stdout;
  const status = git(repo, "status", "--porcelain").stdout;
  return { ok: /^refs\/lane-airbag\/\d+$/.test(ref[0] ?? "") && advice?.[1] === ref[0] && !!ref[1]?.startsWith(advice?.[2] ?? "-") && shown("tracked.txt") === "edited\n" && shown("untracked.txt") === "never added\n" && !status.includes("A  untracked.txt"),
    detail: `before «git reset --hard» the guard saved ${ref[0]}: it holds the edited tracked file and the untracked one; the advice names «git checkout ${advice?.[2]} -- .»; the real index is untouched` };
});

await node("n1666", () => {
  if (!scratchHome) return refused();
  const dir = scratch("reflex");
  writeFileSync(join(dir, "REFLEXES.md"), "- WHEN prisma migrate → run it on a copy of the DB first\n");
  const fire = (command: string) => guard(bash(command, dir, "sess-reflex"), WRITER);
  const [first, second, third] = [fire("npx prisma migrate dev"), fire("npx prisma migrate dev"), fire("npx prisma migrate dev")];
  const other = fire("npm test");
  const says = (text: string) => text.includes("run it on a copy of the DB first");
  return { ok: says(first) && says(second) && !says(third) && !says(other),
    detail: `the lesson fires on the matching act (call 1: ${says(first)}, call 2: ${says(second)}), tires on the third (${says(third)}), and stays silent on another command (${says(other)})` };
});

await node("n1670", () => {
  if (!scratchHome) return refused();
  const a = scratch("depa"), b = scratch("depb"), c = scratch("depc");
  mkdirSync(join(a, "node_modules", "pkg"), { recursive: true }); mkdirSync(join(b, "node_modules")); mkdirSync(join(c, "node_modules"));
  symlinkSync(join(a, "node_modules", "pkg"), join(b, "node_modules", "pkg"));
  const denied = guard(bash("npm install left-pad", b), WRITER);
  const allowed = guard(bash("npm install left-pad", c), WRITER);
  const edit = guard({ tool_name: "Edit", tool_input: { file_path: join(b, "node_modules", "pkg", "index.js") }, cwd: b, session_id: "sess-r24" }, WRITER);
  return { ok: denied.includes("dependency store") && !allowed.includes("dependency store") && edit.includes("dependency store"),
    detail: `an install into a copy whose node_modules links to another tree is refused (${denied.includes("dependency store")}), a plain copy installs (refused: ${allowed.includes("dependency store")}), an edit inside the linked package is refused (${edit.includes("dependency store")})` };
});

await node("n1673", async () => {
  if (!scratchHome) return refused();
  const cwd = scratch("permit-cwd");
  const command = "rm customer.csv";
  const first = guard(bash(command, cwd), WRITER);
  const folder = join(HOME, ".agents", "permits", "sess-r24");
  const ticket = readdirSync(folder).find((name) => name.endsWith(".ticket.json"))!.replace(".ticket.json", "");
  await answerPermit({ requestedHostId: "h", session: "sess-r24", ticket, decision: "allow", why: "the contract owns it" } as never, {} as never);
  const allowed = guard(bash(command, cwd), WRITER);
  const used = JSON.parse(readFileSync(join(folder, `${ticket}.answer.json`), "utf8"));
  const again = guard(bash(command, cwd), WRITER);
  const flat = guard(bash(command, cwd, "sess-flat"), { LANE_PILOT_ROLE: "" });
  return { ok: first.includes("Permit ticket") && !allowed.includes("Permit ticket") && typeof used.used === "number" && again.includes("Permit ticket") && !flat.includes("Permit ticket"),
    detail: `a writer's «rm customer.csv» is refused with a permit ticket (${first.includes("Permit ticket")}); after the PM's allow it runs once (ticket asked again: ${allowed.includes("Permit ticket")}, used stamped: ${typeof used.used === "number"}), the next try asks again (${again.includes("Permit ticket")}); a session with no writer role gets no ticket (${!flat.includes("Permit ticket")})` };
});

await node("n1672", async () => {
  if (!scratchHome) return refused();
  const folder = join(HOME, ".agents", "permits", "sess1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a1b2c3d4e5f60718.ticket.json"), JSON.stringify({ category: "delete", command: "rm build", cwd: "/w", at: Date.now() / 1000 }));
  const denied = await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "a1b2c3d4e5f60718", decision: "deny", why: "not this task" } as never, {} as never) as { written: boolean };
  const stored = JSON.parse(readFileSync(join(folder, "a1b2c3d4e5f60718.answer.json"), "utf8"));
  const missing = await answerPermit({ requestedHostId: "h", session: "sess1", ticket: "ffffffffffffffff", decision: "allow", why: "no ticket" } as never, {} as never) as { written: boolean };
  return { ok: denied.written === true && stored.decision === "deny" && stored.why === "not this task" && missing.written === false && !existsSync(join(folder, "ffffffffffffffff.answer.json")),
    detail: `an answer to a filed ticket is written as ${JSON.stringify({ decision: stored.decision, why: stored.why })}; an answer to a ticket nobody filed is not written (written: ${missing.written})` };
});

// ---- rules and stores on real inputs ----
await node("n1663", () => {
  const row = { day: "2026-10-02", providerId: "anthropic", model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
  const named = priceOf("anthropic", "claude-haiku-4-5"), fallback = priceOf("anthropic", "claude-unknown"), sub = priceOf("claude-code", "claude-haiku");
  return { ok: same(named, PRICE_LIST.anthropic!["claude-haiku"]) && same(fallback, PRICE_LIST.anthropic!.default) && sub === null && rowUsd(row) === 0.8 && rowUsd({ ...row, providerId: "claude-code" }) === 0,
    detail: `a named model takes its own price (haiku ${named?.inputPerM}/M), an unlisted one the provider default (${fallback?.inputPerM}/M), a subscription lane none (${sub}); 1M haiku input tokens cost ${rowUsd(row)} USD, the same on a subscription lane ${rowUsd({ ...row, providerId: "claude-code" })}` };
});

await node("n1664", async () => {
  const { bb, harness } = cliHost();
  const kv = bb.storage.kv as never;
  const fired = ["never run rm -rf /"];
  for (let n = 0; n < 2; n++) await noteBreakerRound(kv, { project: "p", target: "task-a", fired });
  const twice = [...await trippedRules(kv, "p", "task-a")];
  await noteBreakerRound(kv, { project: "p", target: "task-a", fired });
  const thrice = await trippedRules(kv, "p", "task-a");
  const elsewhere = await trippedRules(kv, "p", "task-b");
  await noteBreakerRound(kv, { project: "p", target: "task-b", fired });
  const listed = (await listTripped(kv, "p")).map((row) => row.target);
  await harness.lifecycle.dispose();
  return { ok: twice.length === 0 && same([...thrice], [ruleHash(fired[0]!)]) && elsewhere.size === 0 && same(listed, ["task-a"]),
    detail: `after 2 rounds nothing is tripped (${twice.length}), after the 3rd the rule is soft-disabled for task-a only (task-b: ${elsewhere.size}); tripped list ${JSON.stringify(listed)}` };
});

await node("n1665", () => {
  const observe = (state: StallState | Record<string, number>, tool: string, input: unknown, response: unknown) => stallObserve(state, tool, input, response);
  let run = observe({}, "Bash", { command: "npm test" }, { exit_code: 1 });
  const once = run.hint;
  run = observe(run.state, "Bash", { command: "npm test" }, { exit_code: 1 });
  const twice = run.hint;
  run = observe(run.state, "Bash", { command: "npm test" }, { exit_code: 1 });
  const spoken = run.hint;
  let mono = observe({}, "Grep", { pattern: "p0" }, "r0");
  const hints: string[] = [mono.hint];
  for (let n = 1; n < 8; n++) { mono = observe(mono.state, n % 2 ? "Glob" : "Read", { pattern: `p${n}` }, `r${n}`); hints.push(mono.hint); }
  return { ok: once === "" && twice.includes("the same failing call twice") && spoken === "" && hints.slice(0, 7).every((hint) => hint === "") && hints[7]!.includes("eight read-only calls in a row") && stallFailed({ exitCode: 2 }) && !stallFailed({ exit_code: 0, stdout: "fine" }),
    detail: `the same failing call twice gives advice (${twice.slice(0, 40)}…) once per session (third: «${spoken}»); eight read-only calls in a row give advice on the 8th (earlier ones silent: ${hints.slice(0, 7).every((hint) => hint === "")}); advice only, never a block` };
});

await node("n1667", () => {
  const gate = { id: "no-console", pattern: "console\\.log", paths: ["src/**"] };
  const diff = { "src/a.ts": "+console.log(1)\n" };
  const warn = conventionGateHits([gate], diff);
  const block = conventionGateHits([{ ...gate, mode: "block" as const }], diff);
  const outside = conventionGateHits([gate], { "tests/a.ts": "+console.log(1)\n" });
  const removed = conventionGateHits([gate], { "src/a.ts": "-console.log(1)\n" });
  return { ok: same(warn.warnings, ["no-console"]) && warn.blocks.length === 0 && same(block.blocks, ["no-console"]) && block.warnings.length === 0 && outside.warnings.length === 0 && removed.warnings.length === 0,
    detail: `a console.log added under src/ is a warning by default (warnings ${JSON.stringify(warn.warnings)}, blocks ${warn.blocks.length}), a block in mode block (blocks ${JSON.stringify(block.blocks)}); a file outside the rule's paths or a removed line fires nothing` };
});

await node("n1668", async () => {
  const { bb, harness } = cliHost();
  const kv = bb.storage.kv as never;
  await recordEvidence(kv, { op: "revert", projectId: "p", target: "t1", why: "gate red on main anyway", checks: [{ name: "integration_gate", ok: true, detail: "skipped" }], by: "cli", at: 2 });
  await recordEvidence(kv, { op: "permit", projectId: "p", target: "h/abc", why: "scratch table", checks: [{ name: "ticket", ok: true }], by: "lane_pilot_permit", at: 3 });
  const rows = await listEvidence(kv, "p");
  const onlyRevert = (await listEvidence(kv, "p", { op: "revert" })).map((item) => item.op);
  await harness.lifecycle.dispose();
  return { ok: rows.length === 2 && rows[0]!.op === "permit" && rows[0]!.why === "scratch table" && rows[1]!.why === "gate red on main anyway" && same(onlyRevert, ["revert"]),
    detail: `two records stored with their reason and checks, newest first (${rows.map((item) => item.op).join(", ")}); filtered by op revert: ${JSON.stringify(onlyRevert)}` };
});

await node("n1669", () => {
  const { db } = cliHost();
  const t0 = Date.now() - 9 * 86_400_000;
  saveProjectSetting(db as never, "p", "plan_critique.mode", "advisory");
  db.prepare(`UPDATE lane_pilot_project_settings SET value=? WHERE project_id='p' AND binding_id='' AND key='protection.disarm.plan_critique.mode'`)
    .run(JSON.stringify({ key: "plan_critique.mode", by: "owner", at: t0, until: t0 + 7 * 86_400_000 }));
  const rearmed = rearmExpiredDisarms(db as never, "p");
  const value = db.prepare(`SELECT value FROM lane_pilot_project_settings WHERE project_id='p' AND key='plan_critique.mode'`).get() as { value: string };
  const items = db.prepare(`SELECT what FROM lane_pilot_owner_item WHERE key LIKE 'protection-rearm:%'`).all() as Array<{ what: string }>;
  const again = rearmExpiredDisarms(db as never, "p");
  return { ok: same(rearmed, ["plan_critique.mode"]) && JSON.parse(value.value) === "advisory" && items.length === 1 && again.length === 0,
    detail: `a protection disarmed 9 days ago with a 7-day term is re-armed (${JSON.stringify(rearmed)}) as ${value.value}, ${items.length} owner item posted; a second pass re-arms ${again.length}` };
});

await node("n1676", () => {
  const home = scratch("rules");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm -rf:*)"], allow: ["Bash(*)"], defaultMode: "bypassPermissions" } }));
  const guardFile = join(home, "guard.json");
  writeFileSync(guardFile, JSON.stringify({ permissions: { deny: ["Bash(bb plugin remove:*)"] } }));
  const stub = join(home, "claude");
  writeFileSync(stub, "#!/bin/sh\nfor a in \"$@\"; do [ \"$p\" = \"--settings\" ] && cat \"$a\"; p=\"$a\"; done\n");
  spawnSync("chmod", ["+x", stub]);
  const run = (role: string) => JSON.parse(spawnSync("sh", ["-c", claudeExecLine(stub, guardFile)], { encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", LANE_PILOT_ROLE: role } }).stdout);
  const merged = run("writer"), pm = run("pm");
  const deny: string[] = merged.permissions.deny;
  return { ok: deny.includes("Bash(bb plugin remove:*)") && deny.includes("Bash(rm -rf:*)") && !(merged.permissions.allow ?? []).includes("Bash(*)") && merged.permissions.defaultMode !== "bypassPermissions" && !pm.permissions.deny.includes("Bash(rm -rf:*)"),
    detail: `a helper session launched through the native launcher gets the person's deny list plus the guard's (${deny.join(", ")}), none of the person's allow or bypass mode (allow ${JSON.stringify(merged.permissions.allow ?? [])}); the PM role keeps no person deny (${pm.permissions.deny.length} rules)` };
});

await node("n1678", async () => {
  const setup = (windows: unknown) => {
    const { harness } = cliHost({ providerUsage: { windows: async () => windows } });
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }]);
    return harness;
  };
  const live = setup({ at: new Date().toISOString(), windows: { five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 18, resetsAt: null } } });
  const old = setup({ at: new Date(Date.now() - 5 * 3_600_000).toISOString(), windows: { five_hour: { utilization: 10, resetsAt: null } } });
  const none = setup({ at: null, windows: {} });
  const a = await live.behavior.runCli(["statusline", "h1"]);
  const b = await old.behavior.runCli(["statusline", "h1"]);
  const c = await none.behavior.runCli(["statusline", "h1"]);
  const unknown = await live.behavior.runCli(["statusline", "no-such-host"]);
  for (const harness of [live, old, none]) await harness.lifecycle.dispose();
  return { ok: a.exitCode === 0 && a.stdout === "5h 42% - 7d 18%" && b.stdout === "⚠ 5h 10%" && c.stdout === "" && unknown.exitCode === 1,
    detail: `a fresh reading prints «${a.stdout}», one 5 hours old «${b.stdout}», no windows «${c.stdout}»; an unknown host exits ${unknown.exitCode}` };
});

await node("n1679", () => {
  const owner = classifyChange({ kind: "data_delete" });
  const night = classifyChange({ kind: "lp_fault_repair", attrs: { bench_subset_passed: true, auto_revertible: true } });
  const unknown = classifyChange({ kind: "not-a-kind" });
  const withFiles = classifyChange({ kind: "data_delete", files: ["docs/readme.md"] });
  return { ok: POLICY.version === 4 && owner === "owner_only" && night === "night_decides" && unknown === "night_proposes" && withFiles === "owner_only",
    detail: `tier file version ${POLICY.version}: data_delete is ${owner}, a bench-passed revertible fault repair ${night}, an unknown kind ${unknown}; a data_delete that also names a docs file stays ${withFiles} (the most restrictive match wins)` };
});

await node("n1671", async () => {
  if (!scratchHome || !STORE_JOURNAL.startsWith(HOME)) return { ok: false, detail: `refused: the store journal ${STORE_JOURNAL} is not under a scratch HOME` };
  const root = scratch("store");
  writeFileSync(join(root, "package-lock.json"), `{"lock":${Date.now()}}`);
  await journalStoreInstall({ basePath: root, dir: root, command: "npm ci --no-audit --no-fund", trigger: "/tmp/wt-1", exitCode: 0 });
  const [entry] = readFileSync(STORE_JOURNAL, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const sha = createHash("sha256").update(readFileSync(join(root, "package-lock.json"), "utf8")).digest("hex");
  return { ok: entry!.basePath === root && entry!.command === "npm ci --no-audit --no-fund" && entry!.trigger === "/tmp/wt-1" && entry!.exitCode === 0 && entry!.lockSha256 === sha && typeof entry!.at === "string",
    detail: `an install into the store left one journal line: base ${entry!.basePath === root}, command «${entry!.command}», triggered by ${entry!.trigger}, exit ${entry!.exitCode}, lock sha ${String(entry!.lockSha256).slice(0, 8)}, at ${entry!.at}` };
});

await node("n1674", () => {
  const command = (n: number) => ({ data: { item: { type: "commandExecution", command: `cmd ${n}`, aggregatedOutput: `out ${n}` } } });
  const events = Array.from({ length: PROGRESS_CAP + 50 }, (_, i) => command(i));
  const journal = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: ["src/a.ts"], events });
  const long = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: [], events: [{ data: { item: { type: "commandExecution", command: "x".repeat(10_000), aggregatedOutput: "y".repeat(10_000) } } }] });
  const clean = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: [], events: [command(1)] });
  const lines = journal.split("\n");
  return { ok: lines.includes("- src/a.ts") && lines.includes("… 50 more not shown") && long.includes("[cut:") && !clean.includes("[cut:") && !clean.includes("more not shown"),
    detail: `${PROGRESS_CAP + 50} calls give a journal that lists ${PROGRESS_CAP} and says «… 50 more not shown»; a 10000-char command carries a «[cut: …]» mark; a short, complete journal carries neither mark` };
});

process.stdout.write(`${JSON.stringify({ nodes: seen, home: scratchHome })}\n`);
process.exit(0);
