import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { storeMemoryRecords, type MemorySettings } from "@lane-pilot/memory-core";
import { TASK_PIPELINE_STAGES } from "@lane-pilot/contracts";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { claudeGuardLauncherScript } from "../../src/rooms/native-agent/claude-guard-launch";
import { runMemoryImport } from "../../src/rooms/memory/server/import";
import { planScopeMigration } from "../../src/rooms/memory/server/scope-migration";
import { sessionMemoryRpc } from "../../src/rooms/memory/server";
import { insertPhase, getPhase, savePhase } from "../../src/rooms/phase/store";
import { autoDue } from "../../src/rooms/phase/server/auto-stages";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { buildCapsule, capsuleRestored } from "../../src/rooms/session-hooks/logic";
import {
  appendGateEvaluation, casUpsertSettings, createAttempt, createRun, createTask, getSettingVersions,
  listGateEventsForTask, listStageReceipts, migrations, openDatabase, savePrototypeConfig, stageEventsForTask,
} from "../../src/rooms/plugin-db";

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
const db = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);

const MEMORY_SETTINGS: MemorySettings = { enabled: true, maintain: true, inject: true, audience: "subagent", personalBot: "",
  searchEngine: "auto", coreBudget: 999_999, noteBudget: 999_999, indexBudget: 9_999_999, contextBudget: 2500, maintainEvery: 3 };

const memoryCount = (database: ReturnType<typeof db>, projectId = "p") =>
  (database.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id=?").get(projectId) as { n: number }).n;

describe("session settings and the memory import door", () => {
  it("[sma:k_st_settings] the session settings merge keeps every key of the person and adds the guard once", async () => {
    const project = mkdtempSync(join(tmpdir(), "sma-st-"));
    const dest = mkdtempSync(join(tmpdir(), "sma-st-dest-"));
    mkdirSync(join(project, ".claude"), { recursive: true });
    const settingsFile = join(project, ".claude", "settings.json");
    const written = JSON.stringify({
      model: "claude-test", env: { KEEP_ME: "1" },
      permissions: { deny: ["Bash(rm:*)"], allow: ["Bash(echo:*)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo custom" }] }] },
      otherKey: { nested: true },
    });
    writeFileSync(settingsFile, written);
    const session = await materializeNativeHookSession({ cwd: project, destDir: dest });
    const merged = JSON.parse(readFileSync(session.settingsPath, "utf8"));
    expect(merged.model).toBe("claude-test");
    expect(merged.env).toEqual({ KEEP_ME: "1" });
    expect(merged.permissions).toEqual({ deny: ["Bash(rm:*)"], allow: ["Bash(echo:*)"] });
    expect(merged.otherKey).toEqual({ nested: true });
    const preToolUse = merged.hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const commands = preToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
    expect(commands.some((command) => command.includes("echo custom"))).toBe(true);
    expect(commands.filter((command) => command.includes("guard_shell.py"))).toHaveLength(1);
    for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStop", "PostToolUse"]) {
      const groups = (merged.hooks[event] ?? []) as Array<{ hooks: Array<{ command: string }> }>;
      expect(groups.flatMap((group) => group.hooks).filter((hook) => hook.command.includes("session-hook.mjs")), event).toHaveLength(1);
    }
    expect(readFileSync(settingsFile, "utf8")).toBe(written);
  });

  it("[sma:k_lib_migrate] a dry-run import reports each line's outcome and writes nothing; the scope plan applies nothing", () => {
    const database = db();
    const stored = storeMemoryRecords(database, { projectId: "p", personalBot: "", audience: "subagent",
      sourceSha256: "a".repeat(64), entries: [{ kind: "note", content: "Deploys run nightly on the staging host.", concepts: ["deploy"] }],
      trust: "confirmed", origin: "session", coreBudget: 999_999, noteBudget: 999_999, indexBudget: 9_999_999 });
    database.prepare(`INSERT INTO lane_pilot_rule_proposal
      (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,evidence_json,scope_json,audience,first_seen_at,last_seen_at,updated_at)
      VALUES ('r1','p','sig','migrations need a backup first','sweep','accepted',1,1,'[]','[]','["legacy:label"]','writer',1,1,1)`).run();
    const jsonl = `${JSON.stringify({ source_id: "s1", content: "Releases go through the release captain on weekdays.", kind: "project" })}\n`;
    const report = runMemoryImport({ db: database, projectId: "p", source: "bb-memory", jsonl, settings: MEMORY_SETTINGS, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]!.outcome).toBe("added");
    expect(memoryCount(database)).toBe(1);
    expect(database.prepare("SELECT status FROM lane_pilot_memory WHERE id=?").get(stored.insertedIds[0]!)).toEqual({ status: "active" });
    const plan = planScopeMigration(database, ":memory:");
    expect(plan.applied).toBe(false);
    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0]!.proposal.action).toBe("hold");
    expect(database.prepare("SELECT scope_json FROM lane_pilot_rule_proposal WHERE id='r1'").get()).toEqual({ scope_json: "[\"legacy:label\"]" });
  });

  it("[sma:k_v_mem_migrate] the memory_import RPC with dryRun true previews per line and the store is unchanged", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const database = openDatabase(bb);
    const rpc = sessionMemoryRpc({ bb, db: database, log: () => undefined } as never, {} as Services);
    const jsonl = [
      JSON.stringify({ source_id: "s1", content: "The billing worker clears its queue every night at three." }),
      JSON.stringify({ source_id: "s2", content: "" }),
    ].join("\n");
    const before = memoryCount(database);
    const report = await rpc.memory_import({ source: "bb-memory", projectId: "p", jsonl, dryRun: true }) as {
      dryRun: boolean; outcomes: Array<{ outcome: string }>; summary: string };
    expect(report.dryRun).toBe(true);
    expect(report.outcomes.map((row) => row.outcome)).toEqual(["added", "dropped"]);
    expect(report.summary).toContain("всухую");
    expect(memoryCount(database)).toBe(before);
  });

  it("[sma:k_lib_automem] a claude-files import drops a credential with reason secret and the collector only reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-mem-"));
    const memoryDir = join(dir, "proj", "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "fact.md"), "---\nname: fact\ntype: project\n---\nThe staging host reboots at four every night.\n");
    const before = readFileSync(join(memoryDir, "fact.md"), "utf8");
    const collected = execFileSync("python3", ["scripts/memory-collect-claude.py", dir], { encoding: "utf8" });
    expect(readFileSync(join(memoryDir, "fact.md"), "utf8")).toBe(before);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const jsonl = `${collected.trim()}\n${JSON.stringify({ source_id: "sec", content: `The deploy token is ${jwt} and must stay secret.` })}\n`;
    const database = db();
    const report = runMemoryImport({ db: database, projectId: "p", source: "claude-files", jsonl, settings: MEMORY_SETTINGS });
    const bySource = Object.fromEntries(report.outcomes.map((outcome) => [outcome.source_id, outcome]));
    expect(bySource["sec"]).toMatchObject({ outcome: "dropped", reason: "secret" });
    expect(bySource["proj/fact"]).toMatchObject({ outcome: "added" });
    expect(memoryCount(database)).toBe(1);
  });
});

describe("the worker's merged layer and the permit gate", () => {
  const launcherFixture = async (role: string, extra: string[], home: string) => {
    const { mkdir, writeFile, chmod } = await import("node:fs/promises");
    const dest = await import("node:fs/promises").then((fs) => fs.mkdtemp(join(tmpdir(), `sma-${role}-`)));
    await mkdir(join(dest, "hooks"), { recursive: true });
    const settingsPath = join(dest, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "guard" }] }] } }));
    await writeFile(join(dest, "hooks", "inject_agent_type.py"), "# inject\n");
    await writeFile(join(dest, "hooks", "guard_shell.py"), "# guard\n");
    const command = join(dest, "real-claude");
    await writeFile(command, "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done\n");
    await chmod(command, 0o700);
    const launcher = join(dest, "claude");
    await writeFile(launcher, claudeGuardLauncherScript({ destDir: dest, command, settingsPath, role, agentType: role }));
    await chmod(launcher, 0o700);
    const args = spawnSync(launcher, ["-p", "hi", ...extra], { encoding: "utf8", env: { ...process.env, HOME: home } }).stdout.trim().split("\n");
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"));
    return { args, settings };
  };

  it("[sma:k_st_automem] a helper launch forces autoMemoryEnabled false even when core passes true", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-automem-home-"));
    const extra = ["--settings", JSON.stringify({ autoMemoryEnabled: true, fastMode: false })];
    const writer = await launcherFixture("writer", extra, home);
    expect(writer.settings).toMatchObject({ autoMemoryEnabled: false, fastMode: false });
    const errand = await launcherFixture("errand", extra, home);
    expect(errand.settings.autoMemoryEnabled).toBe(false);
    const pm = await launcherFixture("pm", extra, home);
    expect(pm.settings.autoMemoryEnabled).toBe(false);
  });

  it("[sma:m_pl_merge] a helper launch merges core flags with the guard file and mirrors only the person's deny list", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-merge-home-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      permissions: { deny: ["Bash(rm -rf /)"], allow: ["Bash(*)"], defaultMode: "bypassPermissions" },
    }));
    const core = JSON.stringify({ enabledPlugins: { "x@x": false }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "core" }] }] } });
    const { args, settings } = await launcherFixture("writer", ["--settings", core], home);
    expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
    expect(settings.enabledPlugins).toEqual({ "x@x": false });
    expect(settings.hooks.PreToolUse.flatMap((group: { hooks: Array<{ command: string }> }) => group.hooks.map((hook) => hook.command))).toEqual(["core", "guard"]);
    expect(settings.permissions?.deny).toContain("Bash(rm -rf /)");
    expect(settings.permissions?.allow).toBeUndefined();
    expect(settings.permissions?.defaultMode).toBeUndefined();
    expect(args).toContain("--setting-sources=project,local");
  });

  it("[sma:m_pl_tool_gate] a dangerous writer call files a ticket and waits; a grant for exactly that call is used once", () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-ticket-"));
    try {
      const out = execFileSync("python3", ["-c", `
import importlib.util, json, os
spec = importlib.util.spec_from_file_location("guard_shell", ${JSON.stringify(GUARD)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.PERMIT_DIR = __import__("pathlib").Path(${JSON.stringify(dir)})
p = {"session_id": "s1", "cwd": ${JSON.stringify(dir)}}
cmd = "sqlite3 app.db 'DROP TABLE sessions'"
os.environ["LANE_PILOT_ROLE"] = "writer"
first = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
assert first and "Permit ticket" in first and "DROP/TRUNCATE blocked" in first, first
folder = list(mod.PERMIT_DIR.glob("s1"))[0]
digest = next(folder.glob("*.ticket.json")).name.split(".")[0]
(folder / f"{digest}.answer.json").write_text(json.dumps({"decision": "allow"}))
second = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
assert second is None, second
third = mod._permit_or_ticket(p, cmd, "sql_drop", "[agent-guard] DROP/TRUNCATE blocked.")
assert third and "Permit ticket" in third, third
print("ok")
`], { encoding: "utf8" });
      expect(out.trim()).toBe("ok");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("terminal verbs", () => {
  const cliHost = () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: ((call: { method: string; input: { cwd?: string; command?: string } }) => {
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const ran = spawnSync("bash", ["-c", call.input.command ?? ""], { cwd: call.input.cwd, encoding: "utf8" });
        return { hostId: "host-test", exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
      }) as never,
    });
    const database = openDatabase(bb);
    registerCli(createCore(bb, database), {} as Services, migrations);
    return { bb, harness, db: database };
  };

  it("[sma:k_v_subreceipts] bb lane-pilot subagent-receipts parses --project and --days and prints the report", async () => {
    const { harness, db: database } = cliHost();
    createRun(database, "run_s", "proj_s", "bb", "/w");
    createTask(database, { id: "t1", runId: "run_s", kind: "bb", contract: {} });
    createAttempt(database, { id: "a1", runId: "run_s", taskId: "t1" });
    database.prepare("INSERT INTO lane_pilot_attempt_reasoning (attempt_id, trace_json) VALUES (?,?)").run("a1", JSON.stringify({ dispatchContext: "x".repeat(2000) }));
    recordStage(database, { runId: "run_s", taskId: "t1", stageId: "plan-fact", state: "passed", input: "{}", result: { table: "ok", items: [] } });
    const out = await harness.behavior.runCli(["subagent-receipts", "--project", "proj_s", "--days", "30"]);
    expect(out.exitCode).toBe(0);
    const report = JSON.parse(out.stdout);
    expect(report.attempts).toBe(1);
    expect(report.coverage).toMatchObject({ checked: 1, skipped: 0 });
    expect(report.pack.median).toBe(2000);
  });

  it("[sma:k_v_airbag] airbag lists return points, prunes the old and probes the broken", async () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-airbag-repo-"));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.trim();
    git("init", "-q", "-b", "main");
    git("commit", "-qm", "base", "--allow-empty");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_DATE: "2020-01-01 00:00:00 +0000", GIT_COMMITTER_DATE: "2020-01-01 00:00:00 +0000" };
    spawnSync("git", ["commit", "-qm", "old", "--allow-empty"], { cwd: repo, env });
    const old = git("rev-parse", "HEAD");
    spawnSync("git", ["commit", "-qm", "fresh", "--allow-empty"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    const fresh = git("rev-parse", "HEAD");
    for (const [name, sha] of [["old", old], ["fresh", fresh]] as const) git("update-ref", `refs/lane-airbag/${name}`, sha);
    const { harness, db: database } = cliHost();
    savePrototypeConfig(database, { projectId: "proj_air", hostId: "host-test", pmWorkspacePath: repo, writerWorkspacePath: repo,
      pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" });
    const listed = await harness.behavior.runCli(["airbag", "proj_air"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("refs/lane-airbag/old");
    expect(listed.stdout).toContain("refs/lane-airbag/fresh");
    await harness.behavior.runCli(["airbag", "proj_air", "--prune", "1"]);
    const after = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/lane-airbag/"], { cwd: repo, encoding: "utf8" }).stdout;
    expect(after).not.toContain("refs/lane-airbag/old");
    expect(after).toContain("refs/lane-airbag/fresh");
    // A ref that resolves but has no tree behind it (a blob): listed, but `^{tree}` fails the probe.
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: "x", encoding: "utf8" }).stdout.trim();
    git("update-ref", "refs/lane-airbag/broken", blob);
    const probed = await harness.behavior.runCli(["airbag", "proj_air", "--probe"]);
    expect(probed.stdout).toContain(`probe ok refs/lane-airbag/fresh`);
    expect(probed.stdout).toContain(`probe broken refs/lane-airbag/broken`);
  });

  it("[sma:k_c_help] help lists every registered verb with its usage and needs no project", async () => {
    const { harness } = cliHost();
    const help = (await harness.behavior.runCli(["--help"])).stderr ?? "";
    const verbs = (harness.registrations.cli?.commands ?? []).map((command: { name: string }) => command.name);
    expect(verbs.length).toBeGreaterThan(10);
    for (const name of verbs) expect(help, name).toMatch(new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m"));
  });

  it("[sma:k_t_entry] an unknown verb exits 1 and prints a usage naming every registered command", async () => {
    const { harness } = cliHost();
    const out = await harness.behavior.runCli(["no-such-verb"]);
    expect(out.exitCode).toBe(1);
    const verbs = (harness.registrations.cli?.commands ?? []).map((command: { name: string }) => command.name);
    for (const name of verbs) expect(out.stderr, name).toMatch(new RegExp(`^bb lane-pilot ${name}(\\s|$)`, "m"));
  });

  it("[sma:k_t_config] a setting save is value-checked and version-checked", () => {
    const database = db();
    const versions = () => getSettingVersions(database, "p", ["code_critique.max_rounds"])["code_critique.max_rounds"] ?? 0;
    const refused = casUpsertSettings(database, { projectId: "p", changes: [{ key: "code_critique.max_rounds", value: 9, expectedVersion: versions() }] });
    expect(refused.ok).toBe(false);
    expect((refused as { validation?: { code: string } }).validation?.code).toBe("invalid_choice");
    const saved = casUpsertSettings(database, { projectId: "p", changes: [{ key: "code_critique.max_rounds", value: 2, expectedVersion: versions() }] });
    expect(saved.ok).toBe(true);
    const stale = casUpsertSettings(database, { projectId: "p", changes: [{ key: "code_critique.max_rounds", value: 1, expectedVersion: 0 }] });
    expect(stale).toMatchObject({ ok: false, conflict: true });
    expect(versions()).toBe(1);
  });
});

describe("journals, capsules and the cheap test search", () => {
  it("[sma:k_v_exec] progress saved per stage is read back after a reload and the next due step is found", () => {
    const database = db();
    insertPhase(database, { id: "ph_e2", projectId: "p", pmThreadId: "thr_pm", title: "t", goal: "g", at: 1 });
    savePhase(database, "ph_e2", { stage: "planning", record: { context: { sha: "ctx1" } } as never, at: 2 });
    // A fresh read from the rows (what a restart does): the stored record, not the object we saved.
    const reloaded = getPhase(database, "ph_e2")!;
    expect(reloaded.stage).toBe("planning");
    expect(autoDue(reloaded)).toEqual({ kind: "plan" });
    savePhase(database, "ph_e2", { stage: "design", record: { context: { sha: "ctx1" } } as never, at: 3 });
    expect(autoDue(getPhase(database, "ph_e2")!)).toEqual({ kind: "draw" });
  });

  it("[sma:k_lib_execjournal] one line per finished stage; the next undone stage is read from the rows", () => {
    const database = db();
    createRun(database, "run_j", "proj_j", "bb", "/w");
    createTask(database, { id: "task_j", runId: "run_j", kind: "bb", contract: {} });
    recordStage(database, { runId: "run_j", taskId: "task_j", stageId: "pm-read", state: "passed", input: "{}" });
    recordStage(database, { runId: "run_j", taskId: "task_j", stageId: "plan-critique", state: "passed", input: "{}" });
    const events = stageEventsForTask(database, "run_j", "task_j");
    expect(events.map((row) => [row.stage_id, row.state])).toEqual([["pm-read", "passed"], ["plan-critique", "passed"]]);
    const done = new Set(listStageReceipts(database, "run_j", "task_j").filter((row) => row.state === "passed").map((row) => row.stageId));
    const next = TASK_PIPELINE_STAGES.find((stage) => !done.has(stage));
    expect(next).toBe("run-gate");
  });

  it("[sma:k_st_journal] gate and stage events of an attempt are kept and listed for it in order", () => {
    const database = db();
    createRun(database, "run_g", "proj_g", "bb", "/w");
    createTask(database, { id: "task_g", runId: "run_g", kind: "bb", contract: {} });
    createAttempt(database, { id: "att_g", runId: "run_g", taskId: "task_g" });
    appendGateEvaluation(database, { projectId: "proj_g", runId: "run_g", taskId: "task_g", gate: "owns-paths", status: "passed",
      inputSha256: "a".repeat(64), outputSha256: null, attempt: 0, occurredAt: 10 });
    recordStage(database, { runId: "run_g", taskId: "task_g", stageId: "writer-agent", state: "passed", input: "{}", attempt: 0 });
    appendGateEvaluation(database, { projectId: "proj_g", runId: "run_g", taskId: "task_g", gate: "accept", status: "rejected",
      inputSha256: "b".repeat(64), outputSha256: null, attempt: 0, occurredAt: 20 });
    const stages = stageEventsForTask(database, "run_g", "task_g");
    expect(stages.map((row) => [row.stage_id, row.state])).toEqual([["writer-agent", "passed"]]);
    const gates = listGateEventsForTask(database, "run_g", "task_g");
    expect(gates.map((row) => [row.gate, row.status])).toEqual([["owns-paths", "passed"], ["accept", "rejected"]]);
    expect(gates.every((row) => row.attempt === 0)).toBe(true);
  });

  it("[sma:k_st_flight] the capsule trims to five asks and thirty files and the restore text is capped", () => {
    const capsule = buildCapsule({
      asks: Array.from({ length: 9 }, (_, index) => `ask ${index} ${"x".repeat(400)}`),
      files: Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`),
      claims: Array.from({ length: 40 }, (_, index) => `claim ${index}`),
      trigger: "precompact",
    });
    expect(capsule.asks).toHaveLength(5);
    expect(capsule.asks.every((ask) => ask.length <= 300)).toBe(true);
    expect(capsule.asks[4]).toContain("ask 8");
    expect(capsule.files).toHaveLength(30);
    expect(capsule.claims).toHaveLength(30);
    const restored = capsuleRestored(capsule);
    expect(restored).toContain("Capsule restored after compaction:");
    expect(restored.length).toBeLessThanOrEqual("Capsule restored after compaction:\n".length + 3000);
  });

  const tempRepo = () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-tia-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "tests"), { recursive: true });
    mkdirSync(join(repo, "scripts"), { recursive: true });
    cpSync(join(process.cwd(), "scripts", "test-changed.mjs"), join(repo, "scripts", "test-changed.mjs"));
    return repo;
  };
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

  it("[sma:k_v_tia] changed files select the tests that import them and nothing else", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "src", "widget.ts"), "export function widget() { return 1 }\n");
    writeFileSync(join(repo, "tests", "alpha.test.ts"), 'import { widget } from "../src/widget";\nconsole.log(widget());\n');
    writeFileSync(join(repo, "tests", "beta.test.ts"), "console.log('unrelated');\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, "src", "widget.ts"), "export function widget() { return 2 }\n");
    const out = spawnSync("node", ["scripts/test-changed.mjs", "--list"], { cwd: repo, encoding: "utf8" }).stdout;
    expect(out).toContain("tests/alpha.test.ts");
    expect(out).not.toContain("tests/beta.test.ts");
  });

  it("[sma:k_lib_tia] a wide file imported by many tests selects only the ones naming the changed export", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "src", "hub.ts"), "export function alphaOne() { return 1 }\nexport function betaTwo() {\n  return 2\n}\n");
    for (let index = 0; index < 18; index++) {
      writeFileSync(join(repo, "tests", `t${index}.test.ts`),
        `import { alphaOne } from "../src/hub";\nconsole.log(alphaOne()${index < 2 ? ", betaTwo" : ""});\n`);
    }
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "base"], { cwd: repo, env: gitEnv });
    writeFileSync(join(repo, "src", "hub.ts"), "export function alphaOne() { return 1 }\nexport function betaTwo() {\n  return 3\n}\n");
    const out = spawnSync("node", ["scripts/test-changed.mjs", "--list"], { cwd: repo, encoding: "utf8" }).stdout;
    const selected = out.split("\n").filter((line) => line.endsWith(".test.ts"));
    expect(selected.sort()).toEqual(["tests/t0.test.ts", "tests/t1.test.ts"]);
  });
});

describe("references for agents", () => {
  it("[sma:k_d_ref_ai] the AI phase graph chooses a framework and writes the spec with the evaluation plan", () => {
    const phase = readFileSync("workflows/ai-integration-phase.json", "utf8");
    const graph = JSON.parse(phase) as { nodes: Array<{ id: string; prompt?: string }> };
    expect(phase).toContain("AI-SPEC.md");
    expect(phase).toContain("evaluation");
    const nodes = JSON.stringify(graph.nodes);
    expect(nodes).toContain("AI framework selector");
    const spec = graph.nodes.find((node) => node.id === "spec");
    // The evaluation plan is a step of its own now (eval_plan), and the spec must hold an «## Evaluation» section fed by it.
    expect(JSON.stringify(spec)).toContain("## Evaluation");
    expect(JSON.stringify(spec)).toContain('"from":"eval_plan"');
    expect(graph.nodes.some((node) => node.id === "eval_plan")).toBe(true);
    const review = JSON.parse(readFileSync("workflows/eval-review.json", "utf8")) as { nodes?: unknown };
    expect(Array.isArray(review.nodes) && review.nodes.length > 0).toBe(true);
  });
});
