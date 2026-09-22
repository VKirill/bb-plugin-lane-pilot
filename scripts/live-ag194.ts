import { mkdirSync, symlinkSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { buildCliInvocation } from "../src/argv-builder";
import { runCliOnHost, runCommandOnHost } from "../src/cli-run";
import {
  claimActivation,
  countAttempts,
  createAttempt,
  createRun,
  createTask,
  getAttempt,
  listOpenAttempts,
  openDatabase,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import plugin from "../server";
import { retryAction } from "../src/state-machine";

const RAW = "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-194/tmp/raw";
const FIXTURE = "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-194/tmp/fixture-repo";
const INSTALLED_GUARD = "/Users/vechkasov/.agents/hooks/guard_shell.py";
mkdirSync(RAW, { recursive: true });
mkdirSync(join(FIXTURE, "tests"), { recursive: true });
if (!existsSync(join(FIXTURE, "README.md"))) writeFileSync(join(FIXTURE, "README.md"), "AG-194 fixture\n");
if (!existsSync(join(FIXTURE, ".git"))) spawnSync("git", ["init"], { cwd: FIXTURE });

function dump(name: string, value: unknown) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(join(RAW, name), text);
  process.stdout.write(`\n===== ${name} =====\n${text}`);
}

const cwd = FIXTURE;
type Case = { name:string; tool:string; input:Record<string,unknown>; allowed:boolean };
const bash = (name:string, command:string, allowed:boolean): Case => ({name,tool:"Bash",input:{command},allowed});
const edit = (name:string, tool:string, file_path:string, allowed:boolean): Case => ({name,tool,input:{file_path},allowed});
const cases: Case[] = [
  bash("git status","git status",true),
  bash("ls runs","ls -la .agents/runs",true),
  bash("adoc json","adoc . --json",true),
  bash("lane ctl status","lane-ctl status --run-dir .agents/runs/r1",true),
  bash("controller watch","run-controller watch --run-dir .agents/runs/r1",true),
  bash("bash c mutate","bash -c 'git add . && git commit -m x'",false),
  bash("bash c read","bash -c 'ls .agents'",false),
  bash("bash script","bash scripts/mutate-production.sh",false),
  bash("sh script","sh ./deploy-overwrite.sh",false),
  bash("python script","python3 scripts/mutate.py",false),
  bash("node script","node scripts/mutate.js",false),
  ...["add .","commit -m x","merge branch","push","rebase main","reset --hard","stash","cherry-pick abc","checkout -b x","apply x.patch","am x.patch","pull"].map((tail) => bash(`git ${tail}`,`git ${tail}`,false)),
  bash("redirect production","echo x > src/production.ts",false),
  bash("redirect temp","echo x > /tmp/lane-pilot-test.log",true),
  bash("tee production","git log | tee src/production.ts",false),
  bash("tee temp","git log | tee /tmp/x.log",false),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} production`,tool,"src/app.ts",false)),
  ...["Edit","Write","MultiEdit","NotebookEdit"].flatMap((tool) => [
    edit(`${tool} progress`,tool,".agents/PROGRESS.md",true),
    edit(`${tool} plan`,tool,"docs/plans/x.md",true),
  ]),
  ...["Edit","Write","MultiEdit","NotebookEdit"].map((tool) => edit(`${tool} receipt`,tool,".agents/runs/r1/controller.json",false)),
  bash("adoc apply","adoc . --apply --writer-provider claude",false),
];

function invoke(path:string, testCase:Case) {
  return spawnSync("python3", [path], {
    input:JSON.stringify({ agent_type:"lane-pilot-pm", tool_name:testCase.tool, tool_input:testCase.input, cwd }),
    encoding:"utf8",
    env:{ ...process.env, AGENT_HOOK_CLIENT:"claude" },
  });
}

const guardRows = cases.map((testCase) => {
  const result = invoke(INSTALLED_GUARD, testCase);
  const pass = result.status === (testCase.allowed ? 0 : 2);
  return { name:testCase.name, allowed:testCase.allowed, status:result.status, pass, stdout:result.stdout.slice(0, 200) };
});
const link = "/tmp/ag194-lane-pilot-prod-link";
try { unlinkSync(link); } catch { /* absent */ }
symlinkSync(cwd, link);
const e2 = [
  "agents-doctor setup . --yes --writer-provider codex --night-review off",
  "yq -i '.x = 1' src/config.yml",
  "git diff --output=src/production.patch",
  `echo x > /tmp/../${cwd.replace(/^\//, "")}/production.txt`,
  `echo x > ${link}/production.txt`,
];
const e2Rows = e2.map((command) => {
  const result = invoke(INSTALLED_GUARD, bash(command, command, false));
  return { command, status:result.status, pass:result.status === 2, stdout:result.stdout.slice(0, 160) };
});
try { unlinkSync(link); } catch { /* ignore */ }
dump("d-guard-installed.json", {
  guard: INSTALLED_GUARD,
  cases: cases.length,
  passed: guardRows.filter((row) => row.pass).length,
  failed: guardRows.filter((row) => !row.pass),
  e2Passed: e2Rows.filter((row) => row.pass).length,
  e2Rows,
});

const settings = {
  "writer.provider": "opencode",
  "writer.model": "kimi-k2.5",
  "writer.reasoning_effort": "low",
  "jev.LANE_JEV_EFFORT": true,
  "jev.LANE_OPENCODE_JEV": true,
  "plan_critique.mode": "advisory",
  "ops.poll_interval": 1,
};
const invocation = buildCliInvocation({
  binary:"run-controller",
  subcommand:"run",
  settings,
  required:{ "--run-dir": join(FIXTURE, ".agents/runs/r-live") },
});
const statusInvocation = buildCliInvocation({
  binary:"run-controller",
  subcommand:"status",
  settings,
  required:{ "--run-dir": join(FIXTURE, ".agents/runs/r-live") },
});
statusInvocation.argv.push("--json");
mkdirSync(join(FIXTURE, ".agents/runs/r-live"), { recursive: true });
const statusRun = await runCliOnHost({
  requestedHostId:"host_7sea4qaad8",
  binary:"run-controller",
  argv: statusInvocation.argv,
  env: statusInvocation.env,
  cwd: FIXTURE,
  timeoutMs: 15_000,
});
const helpRun = await runCliOnHost({
  requestedHostId:"host_7sea4qaad8",
  binary:"lane-ctl",
  argv:["--help"],
  env: invocation.env,
  cwd: FIXTURE,
  timeoutMs: 10_000,
});
dump("a-cli-receipt.json", {
  invocation,
  statusInvocation,
  statusRun,
  helpRun: { exitCode:helpRun.exitCode, stdout:helpRun.stdout.slice(0, 500), binaryPath:helpRun.binaryPath },
  applyInArgv: [...statusRun.argv, ...helpRun.argv, ...invocation.argv].some((token) => token.includes("--apply") || token === "setup"),
  unapplied: invocation.unapplied,
});

const verifyFail = runCommandOnHost({
  requestedHostId:"host_7sea4qaad8",
  command:"test 0 = 1",
  cwd: FIXTURE,
});
dump("b-verify-command.json", verifyFail);

const { bb, harness } = createFakePluginHost({
  pluginId:"lane-pilot",
  sdk:{
    threads:{
      list: async () => [{ id:"writer-orphan" }] as never,
      getPluginMetadata: async ({ threadId }) => threadId === "writer-orphan"
        ? { lanePilotRunId:"run-live", lanePilotTaskId:"task-live", attemptId:"attempt-1" }
        : {},
      get: async () => ({ id:"writer-orphan", status:"active" }) as never,
      spawn: async () => { throw new Error("resume must not spawn"); },
    },
  },
});
const db = openDatabase(bb);
createRun(db, "run-live", "proj_ejbam66722");
setRunThread(db, "run-live", "pm-live");
createTask(db, { id:"task-live", runId:"run-live", kind:"bb", contract:{ verify:"tests" } });
createAttempt(db, { id:"attempt-1", runId:"run-live", taskId:"task-live" });
transitionAttempt(db, "attempt-1", "spawn_unknown", { reason:"plugin restart" });
await plugin(bb);
dump("c-resume.json", { afterResume:getAttempt(db, "attempt-1"), open:listOpenAttempts(db), spawnCalled:false });

createAttempt(db, { id:"attempt-2", runId:"run-live", taskId:"task-live" });
transitionAttempt(db, "attempt-2", "validation_failed", { reason:verifyFail.stderr || "verify failed" });
dump("b-retry.json", {
  attempts: countAttempts(db, "run-live", "task-live"),
  retry1: retryAction("validation_failed", 1),
  retry2: retryAction("validation_failed", 2),
  verifyFail,
});

try {
  claimActivation(db, { projectId:"proj_ejbam66722", pmThreadId:"pm-live", runId:"run-live" });
  claimActivation(db, { projectId:"proj_ejbam66722", pmThreadId:"pm-other", runId:"run-other" });
  dump("v1-second-activation.json", { blocked:false });
} catch (cause) {
  dump("v1-second-activation.json", { blocked:true, message:cause instanceof Error ? cause.message : String(cause) });
}

await harness.lifecycle.dispose();
