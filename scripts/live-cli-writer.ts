import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCliInvocation } from "../src/argv-builder";
import { runCliOnHost } from "../src/cli-run";

const RAW = "/Users/vechkasov/Documents/BB-сервис/.agency/jobs/AG-194/tmp/raw";
const FIXTURE = process.env.AG194_FIXTURE ?? "/tmp/ag194-fixture";
const SLUG = process.env.AG194_SLUG ?? "ag194-cursor1";
mkdirSync(RAW, { recursive: true });

function sh(cmd: string, cwd = FIXTURE) {
  return spawnSync("/bin/bash", ["-lc", cmd], { cwd, encoding:"utf8" });
}

if (!existsSync(join(FIXTURE, "README.md"))) {
  writeFileSync(join(FIXTURE, "README.md"), "AG-194 fixture\n");
}
if (!existsSync(join(FIXTURE, ".git"))) sh("git init");
sh("git add README.md && git -c user.email=ag194@local -c user.name=ag194 commit -m 'ag194 fixture' --allow-empty");

const runDir = join(FIXTURE, `.agents/runs/${SLUG}`);
const init = existsSync(join(runDir, "tasks/001.yaml"))
  ? { status:0, stdout:runDir, stderr:"reuse" }
  : sh(`run-init . ${SLUG} --score 1 --brief 'write hello.txt'`);
writeFileSync(join(RAW, "a-run-init-codex.txt"), `${init.stdout}\n${init.stderr}\nexit=${init.status}\n`);
const resolvedRunDir = existsSync(runDir) ? runDir : (init.stdout.trim().split("\n").at(-1) ?? runDir);
const taskPath = join(resolvedRunDir, "tasks/001.yaml");
writeFileSync(taskPath, `schema_version: 2
id: "001"
title: "Write hello fixture"
risk: low
lane: writer
project_cwd: ${JSON.stringify(FIXTURE)}
read_first:
  - README.md
interfaces:
  - "hello.txt contains hello"
invariants:
  - "Do not edit other files"
out_of_scope:
  - "plugin source"
expected_outputs:
  - hello.txt
owns_paths:
  - hello.txt
never_touch:
  - .git/**
depends_on: []
objective: |
  Create hello.txt with exactly hello from cli writer and a trailing newline.
acceptance:
  - "hello.txt exists"
verify: none
verification: []
`);

const settings = {
  "writer.provider": process.env.AG194_PROVIDER ?? "cursor",
  "writer.reasoning_effort": "low",
  "jev.LANE_JEV_EFFORT": true,
  "jev.LANE_OPENCODE_JEV": true,
  "plan_critique.mode": "advisory",
};
const start = buildCliInvocation({
  binary:"lane-ctl",
  subcommand:"start",
  settings,
  required:{
    "--run-dir": resolvedRunDir,
    "--task-file": taskPath,
    "--project-cwd": FIXTURE,
  },
});
writeFileSync(join(RAW, "a-codex-receipt.json"), `${JSON.stringify(start, null, 2)}\n`);
mkdirSync(resolvedRunDir, { recursive: true });
writeFileSync(join(resolvedRunDir, "cli-receipt.json"), `${JSON.stringify({
  schemaVersion:1,
  kind:"cli",
  binary:"lane-ctl",
  argv:start.argv,
  env:start.env,
  applied:start.applied,
  unapplied:start.unapplied,
  receiptPath: join(resolvedRunDir, "cli-receipt.json"),
}, null, 2)}\n`);
writeFileSync(join(RAW, "a-cli-receipt.json"), readFileSync(join(resolvedRunDir, "cli-receipt.json"), "utf8"));

const started = await runCliOnHost({
  requestedHostId:"host_7sea4qaad8",
  binary:"lane-ctl",
  argv: start.argv,
  env: start.env,
  cwd: FIXTURE,
  timeoutMs: 90_000,
});
writeFileSync(join(RAW, "a-lane-ctl-start.json"), `${JSON.stringify({ start, started }, null, 2)}\n`);

const acceptPath = join(resolvedRunDir, "artifacts/001/acceptance.json");
let lastStatus = "";
for (let i = 0; i < 40; i += 1) {
  const watch = await runCliOnHost({
    requestedHostId:"host_7sea4qaad8",
    binary:"lane-ctl",
    argv:["status", "--run-dir", resolvedRunDir, "--task-id", "001", "--json"],
    env: start.env,
    cwd: FIXTURE,
    timeoutMs: 15_000,
  });
  lastStatus = watch.stdout;
  writeFileSync(join(RAW, "a-lane-ctl-status.json"), `${JSON.stringify(watch, null, 2)}\n`);
  const accepted = existsSync(acceptPath);
  let parsed: { accepted?: boolean; status?: string; exit_code?: number | null } = {};
  try { parsed = JSON.parse(watch.stdout) as typeof parsed; } catch { /* keep polling */ }
  const terminal = parsed.accepted === true || parsed.status === "accepted"
    || (parsed.status !== undefined && !["started", "running", "provider_partial"].includes(parsed.status) && parsed.exit_code !== null && parsed.exit_code !== undefined);
  if (accepted || parsed.status === "accepted") break;
  if (parsed.status === "awaiting_verification" || parsed.status === "verified") {
    sh(`lane-ctl verify --run-dir ${JSON.stringify(resolvedRunDir)} --task-id 001 --task-file ${JSON.stringify(taskPath)} --project-cwd ${JSON.stringify(FIXTURE)}`);
    sh(`check-owns-paths ${JSON.stringify(taskPath)} --cwd ${JSON.stringify(FIXTURE)} --run-scope`);
    sh(`lane-ctl accept --run-dir ${JSON.stringify(resolvedRunDir)} --task-id 001 --task-file ${JSON.stringify(taskPath)} --project-cwd ${JSON.stringify(FIXTURE)}`);
    break;
  }
  if (parsed.status === "provider_partial" && i >= 2) break;
  if (terminal && parsed.status !== "awaiting_verification") break;
  spawnSync("/bin/sleep", ["15"]);
}

const summary = {
  initExit: init.status,
  runDir: resolvedRunDir,
  startArgv: start.argv,
  startEnv: start.env,
  unapplied: start.unapplied,
  startExit: started.exitCode,
  startStderr: started.stderr.slice(0, 800),
  startStdout: started.stdout.slice(0, 800),
  lastStatus: lastStatus.slice(0, 2000),
  acceptanceExists: existsSync(acceptPath),
  acceptance: existsSync(acceptPath) ? readFileSync(acceptPath, "utf8") : null,
  hello: existsSync(join(FIXTURE, "hello.txt")) ? readFileSync(join(FIXTURE, "hello.txt"), "utf8") : null,
  apply: started.argv.some((token) => token.includes("--apply") || token === "setup"),
};
writeFileSync(join(RAW, "a-cli-writer.txt"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
