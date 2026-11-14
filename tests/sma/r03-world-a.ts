// Region 3 · Worker, batch a: the worlds the node proofs run in. Used by tests/sma/four-proofs-r03-a*.test.ts and, through
// `observe`, by the region scene (scripts/lp_drill/scenes/sma_r03_probe.ts). Everything is a stand-in: a scratch database, a fake plugin host,
// temporary folders, a scratch HOME, a fake sudo/setfacl on PATH. No model turn, no hub write, no real sudo.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { taskV2Schema } from "../../src/rooms/contracts";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { buildWriterLaunch } from "../../src/rooms/writer/server/spawn-brief";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { createSecrets } from "../../src/rooms/secrets/server/secrets";
import { CAPABILITIES, listReceipts } from "../../src/rooms/capability";
import { createCapabilities } from "../../src/rooms/capability/server";
import { mountPermits } from "../../src/rooms/writer/server";
import { answerPermit, listPermitTickets } from "../../src/rooms/host-worker/host-handlers";
import { claudeGuardLauncherScript, WRITER_DISALLOWED_TOOLS } from "../../src/rooms/native-agent/claude-guard-launch";
import { createActivation } from "../../src/rooms/native-agent/server/activation";
import { createCore } from "../../src/rooms/core/server/core";
import { grantRunFolders } from "../../src/rooms/verification/worker-user";
import { runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";
import { attemptEnvironment } from "../../src/rooms/critique/server/critique-runs/attempt-diffs";
import { openTaskHome, renderTaskManifest, resolveTaskFile } from "../../src/rooms/storage";
import { bbTaskFileIo, placeTaskHomeIn, recordAcceptanceFiles, writeDispatchHome } from "../../src/rooms/writer/server/task-home";
import { resolveRoleModel, roleDefaultModel } from "../../packages/models/src/role-models";
import { creatorBrief, lintDraft } from "../../src/rooms/forge/logic";

/** n411: the Creator's brief for one draft, and the lint that refuses a forbidden grant. */
export function forgeBrief(): { brief: string; lintClean: string[]; lintGrant: string[]; lintName: string[] } {
  const skill = (name: string, extra = "") => `---\nname: ${name}\ndescription: Use when the owner asks for a forged draft of this one skill and nothing else.\n---\nSteps: write the file. Never read a secret.\n${extra}`;
  return {
    brief: creatorBrief("skill", "cell-sum", "skip empty cells"),
    lintClean: lintDraft("skill", "cell-sum", skill("cell-sum")).map((row) => row.code),
    lintGrant: lintDraft("skill", "cell-sum", skill("cell-sum", "tools: *\n")).map((row) => row.code),
    lintName: lintDraft("skill", "cell-sum", skill("other")).map((row) => row.code),
  };
}

export const scratch = (name: string): string => mkdtempSync(join(tmpdir(), `sma-r03a-${name}-`));
const ROOT = join(__dirname, "../..");

export const CONFIG: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: "/ws", writerWorkspacePath: "/ws", pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

export const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind: "feature", title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: "/ws",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }],
});

/** Runs `body` with HOME pointing at a scratch folder (the permit and grant code read os.homedir()). */
export async function withHome<T>(home: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { return await body(); } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
}

/** n406: the launch of a writer attempt with a stand-in host; what the thread was started with. */
export async function writerLaunch(emergency: boolean): Promise<{ role: unknown; lanePilotTaskId: unknown; attemptId: unknown; parentPmThreadId: unknown; prompt: string }> {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const spawns: Array<Record<string, unknown>> = [];
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "proj1", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: "thr_w" }; });
  harness.sdk.stub("files.read", async () => null);
  harness.sdk.stub("files.write", async () => ({}));
  createRun(db, "run1", "proj1", "bb", "/ws");
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, CONFIG);
  const task = contract("T1");
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
  const knowledge = { allRules: [], rules: [], rulesText: "", mixed: { text: "", ids: [] as string[] },
    briefContext: { broadSkills: true, gitnexusTools: false, metamcpTools: false, gitnexusIndex: false, gitnexusRepo: null } };
  const built = await buildWriterLaunch({
    bb: bb as never, db, harness: undefined,
    skillPick: { pick: async () => ({ skills: [], sources: [] }) } as never,
    skillMaterial: { materialize: async () => ({ linked: [] }), compactionOff: async () => undefined } as never,
  }, {
    input: { attemptId: "a1", projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: "thr_pm", config: CONFIG, task, ...(emergency ? { emergency: true } : {}) } as never,
    settings: {}, attemptTask: task, workspacePath: "/wt/a1", live: false, knowledge: knowledge as never, relevantMemory: { text: "" },
    writerProviderId: "p", writerModel: "wm", execution: { providerId: "p", model: "wm" } as never, at: () => undefined,
  });
  await built.launch({ type: "host", hostId: "h1", workspace: { type: "unmanaged", path: "/wt/a1" } } as never);
  const meta = (spawns[0]?.pluginMetadata ?? {}) as Record<string, unknown>;
  return { role: meta.role, lanePilotTaskId: meta.lanePilotTaskId, attemptId: meta.attemptId, parentPmThreadId: meta.parentPmThreadId, prompt: JSON.stringify(spawns[0]?.input ?? "") };
}

/** n410: the PM's activation on a stand-in host; the spawn the conversation orchestrator is started with and the run it is bound to. */
export async function pmActivation(): Promise<{ threadId: string; runId: string; role: unknown; metaRunId: unknown; runPmThread: string | null; runKind: string | null; spawns: number }> {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const spawns: Array<Record<string, unknown>> = [];
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "user" }));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: "pm-main" }; });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  (ctx.host as { call: unknown }).call = async (method: string) => (method === "detect" ? { workspace: { path: "/ws", present: true } } : {});
  savePrototypeConfig(ctx.db, CONFIG);
  const out = await createActivation(ctx, { resumeOrphans: async () => [] } as never).activate("proj1", null, "bb");
  const run = ctx.db.prepare("SELECT pm_thread_id, kind FROM lane_pilot_run WHERE id=?").get(out.runId) as { pm_thread_id: string | null; kind: string | null } | undefined;
  const meta = (spawns[0]?.pluginMetadata ?? {}) as Record<string, unknown>;
  return { threadId: out.threadId, runId: out.runId, role: meta.role, metaRunId: meta.lanePilotRunId, runPmThread: run?.pm_thread_id ?? null, runKind: run?.kind ?? null, spawns: spawns.length };
}

/** n388..n395: the capability sweep on stand-in providers; the receipts it keeps. `accountingFails` leaves one cell red. */
export async function capabilitySweep(): Promise<{ receipts: Array<{ providerId: string; version: string; capability: string; state: string; model: string | null; detail: string | null }>; probed: string[]; second: number; rows: number }> {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
  harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
  const db = openDatabase(bb);
  createRun(db, "run_s", "proj_3tb652jpsi", "bb", "/s");
  setRunThread(db, "run_s", "thr_pm");
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
  const probed: string[] = [];
  const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, {
    startHelperProbe: async (_p: string, _r: string, _provider: string, _m: string, kind: string) => {
      probed.push(kind);
      return kind === "accounting" ? { ok: false, started: true, answered: true, reason: "accounting: the turn's spend is not on the books (known=false, tokens=0)" } : { ok: true, reason: null };
    },
    providerBreaker: { record: () => undefined },
  } as never).capabilities;
  await api.sweep(1234);
  const receipts = listReceipts(db).filter((row) => row.providerId === "codex").map((row) => ({ providerId: row.providerId, version: row.version, capability: row.capability, state: row.state, model: row.model, detail: row.detail }));
  const second = (await api.sweep(5678)).length;
  return { receipts, probed, second, rows: listReceipts(db).length };
}

/** n386: the permit channel of a machine: a fresh ticket, one 601 seconds old, and the answers to each. */
export async function permitChannel(): Promise<{ listed: string[]; staleAnswer: unknown; freshAnswer: unknown; staleAnswerFile: boolean; freshAnswerFile: boolean }> {
  const home = scratch("permit-home");
  return withHome(home, async () => {
    const session = "sess_r03";
    const folder = join(home, ".agents", "permits", session);
    mkdirSync(folder, { recursive: true });
    const stale = "a1b2c3d4e5f60718", fresh = "ffffffffffffffff";
    writeFileSync(join(folder, `${stale}.ticket.json`), JSON.stringify({ category: "worker_reset_hard", command: "git reset --hard", cwd: "/w", at: Date.now() / 1000 - 601 }));
    writeFileSync(join(folder, `${fresh}.ticket.json`), JSON.stringify({ category: "worker_clean_force", command: "git clean -fd", cwd: "/w", at: Date.now() / 1000 - 5 }));
    const listed = (await listPermitTickets({ requestedHostId: "h" } as never, {} as never)).tickets.map((row) => row.ticket);
    const staleAnswer = await answerPermit({ requestedHostId: "h", session, ticket: stale, decision: "allow", why: "late" } as never, {} as never);
    const freshAnswer = await answerPermit({ requestedHostId: "h", session, ticket: fresh, decision: "allow", why: "the task owns it" } as never, {} as never);
    return { listed, staleAnswer, freshAnswer, staleAnswerFile: existsSync(join(folder, `${stale}.answer.json`)), freshAnswerFile: existsSync(join(folder, `${fresh}.answer.json`)) };
  });
}

/** n387: the PM answers a ticket with lane_pilot_permit: what the host is told and what the writer's thread is told (queued, after its turn). */
export async function permitDecision(): Promise<Array<{ decision: string; sentMode: string | undefined; sentTo: string | undefined; text: string | undefined; hostGot: unknown }>> {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const sends: Array<{ threadId: string; mode?: string; text?: string }> = [];
  const answers: Array<Record<string, unknown>> = [];
  let answerTool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
  const tickets = [{ session: "sess-b", ticket: "a1b2c3d4e5f60718", category: "delete_for_good", command: "rm data.csv", cwd: "/fixture/b", at: 1 }];
  const facade = {
    ...bb,
    agents: { registerTool: (tool: { execute: NonNullable<typeof answerTool>["execute"] }) => { answerTool = tool; } },
    background: { schedule: () => undefined },
    hosts: { experimental_client: () => ({ call: async (method: string, payload: Record<string, unknown>) => {
      if (method === "answerPermit") answers.push(payload);
      return method === "listPermitTickets" ? { tickets } : { written: true };
    } }) },
    sdk: { ...bb.sdk, threads: { send: async (payload: { threadId: string; mode?: string; input?: Array<{ text?: string }> }) => {
      sends.push({ threadId: payload.threadId, mode: payload.mode, text: payload.input?.[0]?.text });
    } } },
  };
  createRun(db, "run-b", "project");
  createTask(db, { id: "task-b", runId: "run-b", kind: "bb", contract: {} });
  createAttempt(db, { id: "b", runId: "run-b", taskId: "task-b" });
  transitionAttempt(db, "b", "spawn_requested");
  transitionAttempt(db, "b", "running", { threadId: "writer-b" });
  db.prepare("UPDATE lane_pilot_run SET writer_host_id=?, pm_thread_id=? WHERE id=?").run("host", "pm-b", "run-b");
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run("/fixture/b", "b");
  mountPermits({ bb: facade, db, isDisposed: () => false } as never);
  const out: Array<{ decision: string; sentMode: string | undefined; sentTo: string | undefined; text: string | undefined; hostGot: unknown }> = [];
  try {
    for (const decision of ["allow", "deny"] as const) {
      sends.length = 0; answers.length = 0;
      await answerTool!.execute({ hostId: "host", session: "sess-b", ticket: "a1b2c3d4e5f60718", decision, why: "the task owns this file" }, {});
      out.push({ decision, sentMode: sends[0]?.mode, sentTo: sends[0]?.threadId, text: sends[0]?.text, hostGot: { decision: answers[0]?.decision, ticket: answers[0]?.ticket, session: answers[0]?.session } });
    }
  } finally { await harness.lifecycle.dispose(); }
  return out;
}

/** n384: the writer's launcher script and the one of a PM, as the writer's claude launch is built. */
export function writerLauncher(): { writerDenies: Record<string, boolean>; pmDenies: Record<string, boolean>; constant: string } {
  const base = { destDir: "/d", command: "/usr/bin/claude", settingsPath: "/d/settings.json" };
  const writer = claudeGuardLauncherScript({ ...base, agentType: "writer", role: "writer" });
  const pm = claudeGuardLauncherScript({ ...base, agentType: "lane-pilot-pm", role: "pm" });
  const denied = ["Bash(git push:*)", "Bash(git merge:*)", "Bash(git tag:*)", "Bash(gh release:*)"];
  return { writerDenies: Object.fromEntries(denied.map((tool) => [tool, writer.includes(tool)])), pmDenies: Object.fromEntries(denied.map((tool) => [tool, pm.includes(tool)])), constant: WRITER_DISALLOWED_TOOLS };
}

/** n385: the bundled guard run once on a command, as a writer or as the PM (scratch HOME; python3 on PATH). */
export function guardOnce(command: string, agentType: string, role: string): { stdout: string; tickets: Array<{ category?: string }> } {
  const home = scratch("guard-home");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, AGENT_HOOK_CLIENT: "claude", LANE_PILOT_ROLE: role };
  const done = spawnSync("python3", [join(ROOT, "lane-stack/hooks/guard_shell.py")], { input: JSON.stringify({ agent_type: agentType, tool_name: "Bash", tool_input: { command }, cwd: "/tmp", session_id: "sess_r03" }), env, encoding: "utf8", timeout: 60_000 });
  const folder = join(home, ".agents", "permits", "sess_r03");
  const tickets = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".ticket.json")).map((name) => JSON.parse(readFileSync(join(folder, name), "utf8")) as { category?: string }) : [];
  return { stdout: String(done.stdout ?? ""), tickets };
}

/** A folder of fake programs put in front of PATH: each logs its arguments (and stdin) to <bin>/calls.log, then exits with the code it was given. */
export function fakeBin(programs: Record<string, { code?: number; body?: string }>): { bin: string; calls: () => string[] } {
  const bin = scratch("bin");
  for (const [name, spec] of Object.entries(programs)) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${join(bin, "calls.log")}"\n${spec.body ?? ""}\nexit ${spec.code ?? 0}\n`);
    chmodSync(file, 0o755);
  }
  return { bin, calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").split("\n").filter(Boolean) : []) };
}

/** n396: scripts/lp-worker-user.sh with a fake sudo: `create` for a user that does not exist, `check`, and a bad name. */
export function workerUserScript(): { rule: string; createOut: string; createCalls: string[]; checkUnreachable: { code: number | null; out: string }; checkReachable: { code: number | null; out: string }; badName: { code: number | null; err: string }; usage: number | null } {
  const home = scratch("wu-home");
  const run = (args: string[], bin: string, extra: Record<string, string> = {}) => {
    const done = spawnSync("bash", [join(ROOT, "scripts/lp-worker-user.sh"), ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, USER: "owner", SUDO_USER: "owner", ...extra }, encoding: "utf8", timeout: 60_000 });
    return { code: done.status, out: String(done.stdout ?? ""), err: String(done.stderr ?? "") };
  };
  const user = "lp-sma-r03-user";
  // a sudo that works for everything (and swallows tee's stdin)
  const ok = fakeBin({ sudo: { body: 'if [ "$1" = "tee" ]; then cat > "$(dirname "$0")/rule.txt"; fi' } });
  const created = run(["create", user], ok.bin);
  const bad = fakeBin({ sudo: { code: 1 } });
  const unreachable = run(["check", user], bad.bin);
  const reachable = run(["check", user], ok.bin);
  return {
    rule: existsSync(join(ok.bin, "rule.txt")) ? readFileSync(join(ok.bin, "rule.txt"), "utf8") : "",
    createOut: created.out, createCalls: ok.calls(),
    checkUnreachable: { code: unreachable.code, out: unreachable.out }, checkReachable: { code: reachable.code, out: reachable.out },
    badName: { code: run(["check", "Bad User"], ok.bin).code, err: run(["check", "Bad User"], ok.bin).err },
    usage: run(["frobnicate"], ok.bin).code,
  };
}

/** n399: the grants of a strict worker (fake setfacl): only the folders named are granted; one the tool refuses is not granted nor listed. */
export async function folderGrants(): Promise<{ granted: string[]; ledger: Array<{ user: string; path: string; owner: string }>; calls: string[] }> {
  const home = scratch("grant-home");
  const good = scratch("grant-run"), refused = scratch("grant-refused");
  // setfacl succeeds for the run folder and fails for the other one
  const fake = fakeBin({ setfacl: { body: `case "$*" in *${refused}*) exit 1;; esac` } });
  const savedPath = process.env.PATH;
  process.env.PATH = `${fake.bin}:${savedPath}`;
  try {
    const granted = await withHome(home, () => grantRunFolders("lp-worker", [good, refused], "linux"));
    const file = join(home, ".lane-pilot", "worker-grants.jsonl");
    const ledger = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { user: string; path: string; owner: string }) : [];
    return { granted: granted.map((dir) => dir.replace(good, "<run>").replace(refused, "<refused>")), ledger: ledger.map((row) => ({ ...row, path: row.path.replace(good, "<run>").replace(refused, "<refused>") })), calls: fake.calls().map((line) => line.replace(good, "<run>").replace(refused, "<refused>")) };
  } finally { process.env.PATH = savedPath; }
}

/** n400: the checks of a project, run through the host call: with worker.strict_user on they ask for the worker user, off they do not. */
export async function checksAsWorker(settings: Record<string, string>): Promise<Array<Record<string, unknown>>> {
  const root = realpathSync(scratch("strict"));
  const task = { schema_version: 2, id: "t", title: "t", risk: "low", lane: "writer", project_cwd: root, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["a.txt"], owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "tests",
    verification: [{ command: "node plain.js", cwd: root }] } as unknown as TaskV2;
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "P", key, value);
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const host = { call: async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
    return { hostId: "h", backend: "linux-bubblewrap", workspacePath: root, cwd: root, exitCode: 0, policySha256: "a".repeat(64), stdout: "ok\n", stderr: "" };
  } };
  const verify = createWriterVerify({ bb, db, host, runPolicyFor: () => ({ pools: { verification: 2 } }), secrets: createSecrets({ bb }) } as never, { runWriterPool: { acquire: async () => () => undefined } } as never);
  await verify.runVerification({ hostId: "h", projectId: "P" } as never, task);
  return calls.filter((call) => call.method === "runSandboxedCommand").map((call) => call.input);
}

/** n401: a real confined run (the Linux sandbox of this machine): one command, its answer, and what it may not do. */
export async function confinedRun(): Promise<{ answer: { exitCode: number; stdout: string; backend: string; policy: boolean }; failing: { exitCode: number; stdout: string }; timedOut: number; outside: { exitCode: number; created: boolean }; inside: { exitCode: number; created: boolean } } | null> {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return null;
  const ws = realpathSync(scratch("confined"));
  const escape = `/var/tmp/sma-r03a-escape-${process.pid}-${Date.now()}`;
  const run = (command: string, timeoutSec?: number) => runSandboxedCommandOnHost({ requestedHostId: "h", workspacePath: ws, cwd: ws, command, backend: "linux-bubblewrap", ...(timeoutSec ? { timeoutSec } : {}) });
  const answer = await run("echo one-answer");
  const failing = await run("echo seen; exit 3");
  const timedOut = (await run("sleep 30", 1)).exitCode;
  const outside = await run(`echo x > ${escape}`);
  const inside = await run("echo x > inside.txt");
  return {
    answer: { exitCode: answer.exitCode, stdout: answer.stdout, backend: answer.backend, policy: /^[a-f0-9]{64}$/.test(answer.policySha256) },
    failing: { exitCode: failing.exitCode, stdout: failing.stdout }, timedOut,
    outside: { exitCode: outside.exitCode, created: existsSync(escape) }, inside: { exitCode: inside.exitCode, created: existsSync(join(ws, "inside.txt")) },
  };
}

/** n402: the critic of an attempt reads the attempt's own copy: the environment of the newest attempt at that path, none for another path. */
export function criticEnvironments(): { atWorktree: unknown; otherPath: unknown; noEnvironment: unknown } {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "proj1", "bb", "/ws");
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: contract("T1") });
  createTask(db, { id: "T2", runId: "run1", kind: "bb", contract: contract("T2") });
  for (const [id, task, path, env, at] of [["a1", "T1", "/wt/a1", "env_old", 1000], ["a2", "T1", "/wt/a1", "env_new", 2000], ["a3", "T1", "/wt/a3", "env_other", 3000], ["a4", "T2", "/wt/a4", null, 4000]] as const) {
    createAttempt(db, { id, runId: "run1", taskId: task });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, environment_id=?, created_at=? WHERE id=?").run(path, env, at, id);
  }
  return { atWorktree: attemptEnvironment(db, "run1", "T1", "/wt/a1"), otherPath: attemptEnvironment(db, "run1", "T1", "/elsewhere"), noEnvironment: attemptEnvironment(db, "run1", "T2", "/wt/a4") };
}

/** n403: an accepted attempt's receipts, written once into the task home in the base checkout; what is still there after the worktree is gone. */
export async function acceptedReceipts(): Promise<{ acceptancePath: string; receiptPath: string; acceptance: string | undefined; receipt: string | undefined; onlyBase: boolean; report: string | undefined; before: boolean }> {
  const BASE = "/srv/proj", WT = "/wt/attempt-a", RUN = "lprun_t";
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host);
  createRun(db, RUN, "proj", "bb", BASE);
  const files = new Map<string, string>();
  const bb = { log: { warn: () => undefined, info: () => undefined }, sdk: { files: {
    read: async ({ path }: { path: string }) => (files.has(path) ? { content: files.get(path) } : null),
    write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
  } } };
  const ctx = { bb, db, log: () => undefined } as never;
  const task = taskV2Schema.parse({ schema_version: 2, id: "t1", title: "T", risk: "high", lane: "writer", project_cwd: BASE, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "Save the form", acceptance: ["the form saves"], verify: "none", verification: [{ command: "npm test", cwd: BASE, timeout_sec: 60 }] });
  createTask(db, { id: "t1", runId: RUN, kind: "bb", contract: task });
  const io = bbTaskFileIo(bb as never, "h1", BASE);
  await writeDispatchHome(db, io, { taskId: "t1", projectId: "proj", runId: RUN, basePath: BASE, hostId: "h1", task, plan: "plan" });
  await placeTaskHomeIn(ctx, { taskId: "t1", hostId: "h1", worktreePath: WT, basePath: BASE });
  const done = await recordAcceptanceFiles(ctx, { taskId: "t1", runId: RUN, attemptId: "a1", output: "the report", acceptance: "{\"ok\":true}\n", receipt: "{\"status\":\"accepted\"}\n" });
  const before = [...files.keys()].some((path) => path.startsWith(WT));
  for (const path of [...files.keys()]) if (path.startsWith(WT)) files.delete(path);
  void openTaskHome; void renderTaskManifest;
  return {
    acceptancePath: done!.acceptancePath, receiptPath: done!.receiptPath, acceptance: files.get(done!.acceptancePath), receipt: files.get(done!.receiptPath),
    onlyBase: [...files.keys()].filter((path) => path.endsWith("/acceptance.json")).join(",") === done!.acceptancePath,
    report: files.get(resolveTaskFile(db, "t1", "writer-report")!.absPath), before,
  };
}

/** n413: what a role runs on: the table's default, an owner's pick with and without an effort of its own. */
export function roleModels(): Record<string, unknown> {
  const gemini = "router9/ag/gemini-3.8-flash-high";
  return {
    plannerDefault: resolveRoleModel("planner", {}),
    pmReaderDefault: roleDefaultModel("pm-reader"),
    ownerPickNoEffort: resolveRoleModel("planner", { "role_model.planner": { model: gemini } }),
    ownerPickWithEffort: resolveRoleModel("planner", { "role_model.planner": { model: "claude-sonnet-5-5", reasoning_effort: "xhigh" } }),
    workerAlias: resolveRoleModel("worker", {}).model,
  };
}
