// Region 24 «Safety nets, budget and guards» (n1653–n1679): the behaviour proofs that the older card tests did not give —
// the owner verbs run through the CLI, the stall rules one by one, the shadow findings of a disarm, the permit round
// trip between the guard and the PM's answer, the airbag advice, and the Claude Code usage reading.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { answerPermit } from "../../src/rooms/host-worker/host-handlers";
import { breakerRowId, noteBreakerRound, ruleHash } from "../../src/rooms/learning/breaker";
import { integrityReport } from "../../src/rooms/policy";
import { noteProtectionDisarm } from "../../src/rooms/storage/protections-store";
import { appendGateEvaluation, createRun, createTask, migrations, openDatabase } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { stallFailed, stallObserve, type StallState } from "../../src/rooms/session-hooks/logic";
import { recordEvidence } from "../../src/rooms/storage";
import { readGateReport } from "../../src/rooms/tasks/gate-report";
import { queryTokenUsage, syncTokenUsage, utcDay } from "../../src/rooms/usage/server/token-usage";

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
const guard = (payload: Record<string, unknown>, env: Record<string, string> = {}) => {
  const ran = spawnSync("python3", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
};
const bashPayload = (command: string, cwd: string, session = "sess-r24") => ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: session });

const cliHost = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  registerCli(createCore(bb, db), {} as Services, migrations);
  return { bb, harness, db };
};

describe("owner verbs of the safety nets", () => {
  it("[sma:k_v_breaker] the breaker verb lists a tripped rule with its streak and re-arms only with a reason, by the owner", async () => {
    const { bb, harness } = cliHost();
    const kv = bb.storage.kv as never;
    for (let round = 0; round < 3; round++) await noteBreakerRound(kv, { project: "p", target: "fam", fired: ["rule R"] });
    const id = breakerRowId("p", ruleHash("rule R"), "fam");
    const listed = JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id, rule: ruleHash("rule R"), target: "fam", count: 3 });
    expect(JSON.parse((await harness.behavior.runCli(["breaker", "other-project"])).stdout)).toEqual([]);
    const noWhy = await harness.behavior.runCli(["breaker", "rearm", id]);
    expect(noWhy.exitCode).toBe(1);
    expect(String(noWhy.stderr)).toContain("a reason is required");
    expect(JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout)).toHaveLength(1);
    const done = await harness.behavior.runCli(["breaker", "rearm", id, "--why", "reviewed, rule fixed"]);
    expect(done.exitCode).toBe(0);
    expect(JSON.parse(done.stdout)).toEqual({ rearmed: id, by: "owner", why: "reviewed, rule fixed" });
    expect(JSON.parse((await harness.behavior.runCli(["breaker", "p"])).stdout)).toEqual([]);
    expect((await harness.behavior.runCli(["breaker", "rearm", id, "--why", "again"])).exitCode).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_gates] a firing the owner acks stays counted but leaves the blockers, and an ack needs a reason", async () => {
    const { bb, harness, db } = cliHost();
    const now = Date.now();
    appendGateEvaluation(db, { projectId: "p", runId: "r1", taskId: "t-ack", gate: "accept", status: "rejected", inputSha256: "a", outputSha256: null, attempt: 1, occurredAt: now - 1000 });
    appendGateEvaluation(db, { projectId: "p", runId: "r1", taskId: "t-real", gate: "accept", status: "rejected", inputSha256: "b", outputSha256: null, attempt: 1, occurredAt: now - 500 });
    appendGateEvaluation(db, { projectId: "p", runId: "r1", taskId: "t-ack2", gate: "accept", status: "failed", inputSha256: "c", outputSha256: null, attempt: 1, occurredAt: now - 800 });
    const ids = db.prepare("SELECT id, task_id AS task FROM lane_pilot_gate_event ORDER BY id").all() as Array<{ id: number; task: string }>;
    const ackId = ids.find((row) => row.task === "t-ack")!.id;
    const before = await readGateReport(db, { projectId: "p", days: 1, now }, bb.storage.kv as never);
    expect(before.recentGateBlockers.map((row) => row.taskId).sort()).toEqual(["t-ack", "t-ack2", "t-real"]);
    const refused = await harness.behavior.runCli(["gates", "ack", String(ackId)]);
    expect(refused.exitCode).toBe(1);
    expect((await readGateReport(db, { projectId: "p", days: 1, now }, bb.storage.kv as never)).recentGateBlockers).toHaveLength(3);
    const acked = await harness.behavior.runCli(["gates", "ack", String(ackId), "--why", "the file was renamed before the task"]);
    expect(acked.exitCode).toBe(0);
    expect(JSON.parse(acked.stdout)).toEqual({ acked: ackId, why: "the file was renamed before the task" });
    const ack2Id = ids.find((row) => row.task === "t-ack2")!.id;
    expect((await harness.behavior.runCli(["gates", "ack", String(ack2Id), "--why", "flaky network"])).exitCode).toBe(0);
    const after = await readGateReport(db, { projectId: "p", days: 1, now }, bb.storage.kv as never);
    expect(after.recentGateBlockers.map((row) => row.taskId)).toEqual(["t-real"]);
    const accept = after.byGate.find((row) => row.gate === "accept")!;
    // two of the three firings are false alarms: still counted by status, named apart
    expect(accept).toMatchObject({ total: 3, falseAlarms: 2 });
    expect(accept.byStatus).toMatchObject({ rejected: 2, failed: 1 });
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_evidence] the evidence verb prints operation, target, reason, checks and who, newest first, filtered by operation", async () => {
    const { bb, harness } = cliHost();
    const kv = bb.storage.kv as never;
    await recordEvidence(kv, { op: "revert", projectId: "p", target: "t1", why: "gate red on main anyway", checks: [{ name: "integration_gate", ok: false, detail: "skipped on request" }], by: "cli", at: Date.now() - 5000 });
    await recordEvidence(kv, { op: "permit", projectId: "p", target: "h/abc", why: "scratch table", checks: [{ name: "ticket", ok: true }], by: "lane_pilot_permit", at: Date.now() - 1000 });
    const all = await harness.behavior.runCli(["evidence", "p"]);
    expect(all.exitCode).toBe(0);
    const text = String(all.stdout);
    expect(text.indexOf("permit h/abc")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("permit h/abc")).toBeLessThan(text.indexOf("revert t1"));
    expect(text).toContain("why: scratch table");
    expect(text).toContain("checks: ok ticket");
    expect(text).toContain("by: lane_pilot_permit");
    expect(text).toContain("why: gate red on main anyway");
    expect(text).toContain("checks: FAIL integration_gate — skipped on request");
    const onlyRevert = String((await harness.behavior.runCli(["evidence", "p", "--op", "revert"])).stdout);
    expect(onlyRevert).toContain("revert t1");
    expect(onlyRevert).not.toContain("permit h/abc");
    expect((await harness.behavior.runCli(["evidence", "p", "--op", "janitor"])).stdout).toBe("no evidence records");
    expect((await harness.behavior.runCli(["evidence"])).exitCode).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_integrity] a disarmed gate names the findings it would have blocked in shadow, and the verb renews the term only with a reason", async () => {
    const { harness, db } = cliHost();
    createRun(db, "run_i", "p", "bb", "/w");
    createTask(db, { id: "t_i", runId: "run_i", kind: "bb", contract: {} });
    const disarmedAt = Date.now() - 60_000;
    noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner", now: disarmedAt });
    // A critique that failed AFTER the disarm is a shadow finding; one that failed before it is not.
    recordStage(db, { runId: "run_i", taskId: "t_i", stageId: "code-critique", state: "failed", input: "x", result: { status: "block" } });
    db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=? WHERE task_id='t_i'").run(disarmedAt - 1000);
    const early = integrityReport(db as never, { "code_critique.mode": "advisory" }, "p").find((row) => row.key === "code_critique.mode")!;
    expect(early.shadow_findings).toEqual([]);
    db.prepare("UPDATE lane_pilot_stage_receipt SET updated_at=? WHERE task_id='t_i'").run(disarmedAt + 1000);
    const report = integrityReport(db as never, { "code_critique.mode": "advisory" }, "p").find((row) => row.key === "code_critique.mode")!;
    expect(report.disarmed).toBe(true);
    expect(report.shadow_findings).toEqual([{ taskId: "t_i", stageId: "code-critique", state: "failed", at: disarmedAt + 1000 }]);
    expect(report.term).toMatchObject({ at: disarmedAt });
    const viaCli = JSON.parse(String((await harness.behavior.runCli(["integrity", "p"])).stdout)) as Array<Record<string, unknown>>;
    expect(viaCli.find((row) => row.key === "code_critique.mode")).toMatchObject({ disarmed: true, shadow_findings: [{ taskId: "t_i" }] });
    const noWhy = await harness.behavior.runCli(["integrity", "p", "--renew", "code_critique.mode", "--days", "30"]);
    expect(noWhy.exitCode).toBe(1);
    const renewed = await harness.behavior.runCli(["integrity", "p", "--renew", "code_critique.mode", "--days", "30", "--why", "still auditing the critic"]);
    expect(renewed.exitCode).toBe(0);
    expect(JSON.parse(renewed.stdout).renewals).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});

describe("stall rules", () => {
  const observe = (state: StallState | Record<string, number>, tool: string, input: unknown, response: unknown) => stallObserve(state, tool, input, response);

  it("[sma:k_lib_stall] each of the four rules gives its advice once, from the plain call record, and never blocks", () => {
    // 1. the same failing call twice
    let run = observe({}, "Bash", { command: "npm test" }, { exit_code: 1 });
    expect(run.hint).toBe("");
    run = observe(run.state, "Bash", { command: "npm test" }, { exit_code: 1 });
    expect(run.hint).toContain("the same failing call twice");
    run = observe(run.state, "Bash", { command: "npm test" }, { exit_code: 1 });
    expect(run.hint, "a pattern speaks once per session").toBe("");
    // 2. the same result three times
    let reads = observe({}, "Read", { file_path: "a.ts" }, "same text");
    reads = observe(reads.state, "Read", { file_path: "a.ts" }, "same text");
    expect(reads.hint).toBe("");
    reads = observe(reads.state, "Read", { file_path: "a.ts" }, "same text");
    expect(reads.hint).toContain("already been returned 3 times");
    // 3. the last six calls alternate between two fingerprints
    let ping = observe({}, "Bash", { command: "a" }, "ok a");
    const hints: string[] = [ping.hint];
    for (const name of ["b", "a", "b", "a", "b"]) { ping = observe(ping.state, "Bash", { command: name }, `ok ${name}`); hints.push(ping.hint); }
    expect(hints.slice(0, 4).every((hint) => hint === "")).toBe(true);
    // the third identical call speaks its own rule first; the sixth call of the alternation is the ping-pong
    expect(hints[4]).toContain("Change the hypothesis");
    expect(hints[5]).toContain("alternating between two calls");
    // 4. eight read-only calls in a row with nothing written
    let mono = observe({}, "Grep", { pattern: "p0" }, "r0");
    const seen: string[] = [mono.hint];
    for (let n = 1; n < 8; n++) { mono = observe(mono.state, n % 2 ? "Glob" : "Read", { pattern: `p${n}` }, `r${n}`); seen.push(mono.hint); }
    expect(seen.slice(0, 7).every((hint) => hint === "")).toBe(true);
    expect(seen[7]).toContain("eight read-only calls in a row");
    // a write between the reads starts the count again
    let broken = observe({}, "Grep", { pattern: "q0" }, "r");
    for (let n = 1; n < 7; n++) broken = observe(broken.state, "Read", { file_path: `f${n}` }, `r${n}`);
    broken = observe(broken.state, "Edit", { file_path: "f" }, "edited");
    broken = observe(broken.state, "Read", { file_path: "g" }, "r");
    expect(broken.hint).toBe("");
    expect(broken.state.readRun).toBe(1);
    // judged on the record, not by a model: failure means an error flag, a non-zero exit, an interruption or error text
    expect(stallFailed({ is_error: true })).toBe(true);
    expect(stallFailed({ exitCode: 2 })).toBe(true);
    expect(stallFailed({ interrupted: true })).toBe(true);
    expect(stallFailed("Traceback (most recent call last)")).toBe(true);
    expect(stallFailed("12 passed, 0 failed")).toBe(false);
    expect(stallFailed({ exit_code: 0, stdout: "fine" })).toBe(false);
  });
});

describe("guard hook round trips", () => {
  let home = "";
  afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = ""; });

  it("[sma:k_lib_airbag] the saved point is a ref of the whole tree, and the advice names the command that brings it back", () => {
    home = mkdtempSync(join(tmpdir(), "r24-home-"));
    const repo = mkdtempSync(join(tmpdir(), "r24-airbag-"));
    const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "tracked.txt"), "committed\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: repo, env: { ...process.env, ...env } });
    writeFileSync(join(repo, "tracked.txt"), "edited\n");
    writeFileSync(join(repo, "untracked.txt"), "never added\n");
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home });
    const ref = spawnSync("git", ["for-each-ref", "--format=%(refname) %(objectname)", "refs/lane-airbag/"], { cwd: repo, encoding: "utf8" }).stdout.trim().split(" ");
    expect(ref[0]).toMatch(/^refs\/lane-airbag\/\d+$/);
    const advice = /\[git-airbag\] saved as (refs\/lane-airbag\/\d+): git checkout ([0-9a-f]{10}) -- \. brings it back/.exec(out.stdout + out.stderr);
    expect(advice, out.stdout + out.stderr).not.toBeNull();
    expect(advice![1]).toBe(ref[0]);
    expect(ref[1]!.startsWith(advice![2]!)).toBe(true);
    const shown = (path: string) => spawnSync("git", ["show", `${ref[1]}:${path}`], { cwd: repo, encoding: "utf8" }).stdout;
    expect(shown("tracked.txt")).toBe("edited\n");
    expect(shown("untracked.txt")).toBe("never added\n");
    // the real index is untouched by taking the point: the untracked file is still not staged
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout).not.toContain("A  untracked.txt");
  });

  it("[sma:k_lib_tooldecision] [sma:k_lib_actionclient] the PM's answer file is what the worker's guard reads: allow runs the command once, the next try asks again", async () => {
    home = mkdtempSync(join(tmpdir(), "r24-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "r24-permit-cwd-"));
    const env = { LANE_PILOT_ROLE: "writer", HOME: home };
    const command = "rm customer.csv";
    const first = guard(bashPayload(command, cwd), env);
    expect(first.stdout + first.stderr).toContain("Permit ticket");
    const folder = join(home, ".agents", "permits", "sess-r24");
    const ticketFile = readdirSync(folder).find((name) => name.endsWith(".ticket.json"))!;
    const ticket = ticketFile.replace(".ticket.json", "");
    expect(JSON.parse(readFileSync(join(folder, ticketFile), "utf8"))).toMatchObject({ category: expect.any(String), command });
    const priorHome = process.env.HOME;
    process.env.HOME = home;
    try {
      // the PM denies first: the refusal carries the PM's reason
      expect(await answerPermit({ requestedHostId: "h", session: "sess-r24", ticket, decision: "deny", why: "not this task" } as never, {} as never)).toMatchObject({ written: true });
      expect(JSON.parse(readFileSync(join(folder, `${ticket}.answer.json`), "utf8"))).toMatchObject({ decision: "deny", why: "not this task" });
      const denied = guard(bashPayload(command, cwd), env);
      expect(denied.stdout + denied.stderr).toContain("The PM refused this permit: not this task");
      // then allows: the same command in the same folder goes through, once
      expect(await answerPermit({ requestedHostId: "h", session: "sess-r24", ticket, decision: "allow", why: "the contract owns it" } as never, {} as never)).toMatchObject({ written: true });
      const allowed = guard(bashPayload(command, cwd), env);
      expect(allowed.stdout + allowed.stderr).not.toContain("Permit ticket");
      const answer = JSON.parse(readFileSync(join(folder, `${ticket}.answer.json`), "utf8"));
      expect(answer).toMatchObject({ decision: "allow", why: "the contract owns it" });
      expect(typeof answer.used).toBe("number");
      const again = guard(bashPayload(command, cwd), env);
      expect(again.stdout + again.stderr, "a grant is used once").toContain("Permit ticket");
      // another folder is a different ticket, even for the same words
      const other = mkdtempSync(join(tmpdir(), "r24-permit-other-"));
      const elsewhere = guard(bashPayload(command, other), env);
      expect(elsewhere.stdout + elsewhere.stderr).toContain("Permit ticket");
      expect(readdirSync(folder).filter((name) => name.endsWith(".ticket.json")).length).toBe(2);
      // an unknown ticket is not written
      expect(await answerPermit({ requestedHostId: "h", session: "sess-r24", ticket: "0123456789abcdef", decision: "allow", why: "none" } as never, {} as never)).toMatchObject({ written: false });
      expect(existsSync(join(folder, "0123456789abcdef.answer.json"))).toBe(false);
    } finally { process.env.HOME = priorHome; }
  });
});

describe("Claude Code usage reading", () => {
  it("[sma:k_lib_spendadapter] Claude Code turns in the common BB form land as per-turn rows under claude-code, cache read and write kept, cumulative totals never re-added", async () => {
    const day = utcDay(Date.now());
    const turn = (seq: number, turnId: string, last: Record<string, number>, total: Record<string, number>) => ({
      seq, createdAt: Date.now(), type: "thread/tokenUsage/updated", data: { turnId, tokenUsage: { last, total } },
    });
    const first = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 700, cacheWriteInputTokens: 50, totalTokens: 870 };
    const second = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 800, cacheWriteInputTokens: 0, totalTokens: 815 };
    const events = [
      { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "claude-sonnet-5-5", providerId: "claude-code" } } },
      turn(2, "turn_1", first, first),
      turn(3, "turn_2", second, { inputTokens: 110, outputTokens: 25, cacheReadInputTokens: 1500, cacheWriteInputTokens: 50, totalTokens: 1685 }),
    ];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
      projects: { list: async () => [{ id: "proj_a", name: "A" }] },
      threads: { list: async () => [{ id: "thr_cc", projectId: "proj_a", providerId: "claude-code" }],
        events: { list: async (args: { afterSeq?: string }) => events.filter((event) => event.seq > Number(args.afterSeq ?? 0)) } },
    } as never });
    const db = openDatabase(bb);
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const row = db.prepare("SELECT provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens, cache_read_tokens, cache_write_tokens FROM lane_pilot_token_daily WHERE day=?").get(day) as Record<string, unknown>;
    expect(row).toEqual({ provider_id: "claude-code", model: "claude-sonnet-5-5", input_tokens: 1710, output_tokens: 25, cached_tokens: 1550, total_tokens: 1685, cache_read_tokens: 1500, cache_write_tokens: 50 });
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(result.byModel[0]).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", input: 1710, output: 25, cached: 1550, total: 1685 });
  });
});
