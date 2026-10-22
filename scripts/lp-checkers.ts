/**
 * Runs `bb lane-pilot checkers …` from outside BB, with the same room code (src/rooms/checkers) and the ports of a shell: the candidates come from a
 * copy of the bench snapshot (LP_BENCH_HOME/bench.db, taken by `lp-bench refresh-snapshot`), the checks run on the machines the way lp-bench's
 * warm-up runs them, the critics are hidden `bb thread spawn` threads. It exists for the time before the plugin carrying the command is deployed.
 *
 *   npx esbuild scripts/lp-checkers.ts --bundle --platform=node --format=esm --outfile=/tmp/lp-checkers.mjs --external:better-sqlite3 --external:@get-bb/plugin-sdk \
 *     --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" && node /tmp/lp-checkers.mjs drill
 *   node /tmp/lp-checkers.mjs score --tasks 6 --critic codex/gpt-6-luna --budget-tokens 400000
 *   node /tmp/lp-checkers.mjs scorecard
 *
 * `drill` needs nothing else (no hub, no model): it is what lp-drill.py runs as the `checkers` scenario.
 * State lives in LP_CHECKERS_HOME (default ~/lp-checkers): checkers.db holds the runs and their rows. Env: LP_BENCH_HOME, LP_BENCH_SSH_OVH (used only with LP_CHECKERS_OVH=1), BB_CLI.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { runCheckersCli, createCheckers } from "../src/rooms/checkers/api";
import { checkerMigrations } from "../src/rooms/checkers/migrations";
import { loadHistory } from "../src/rooms/checkers/history";
import type { ModelPort } from "../src/rooms/checkers/checkers";
import { quote } from "../src/rooms/checkers/workspace";
import { loadCandidates } from "../src/rooms/bench/candidates";
import { findSolutionCommit } from "../src/rooms/bench/warmup";
import { isSandboxProjectName } from "../src/rooms/stability/server";

const HOME = process.env.LP_CHECKERS_HOME ?? join(homedir(), "lp-checkers");
const BENCH_HOME = process.env.LP_BENCH_HOME ?? join(homedir(), "lp-bench");
const OVH = process.env.LP_BENCH_SSH_OVH ?? "ovh-main";
const BB = process.env.BB_CLI ?? "bb";
const LOCAL_HOST = "host_7sea4qaad8", OVH_HOST = "host_rwrxyi39aw";
const log = (line: string) => console.error(`${new Date().toISOString().slice(11, 19)} checkers: ${line}`);

type Exec = { exitCode: number; stdout: string; stderr: string };

function exec(file: string, args: string[], options: { cwd?: string; input?: string; timeoutSec?: number } = {}): Promise<Exec> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd ?? "/", env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = options.timeoutSec ? setTimeout(() => child.kill("SIGKILL"), options.timeoutSec * 1000) : null;
    child.on("error", (error) => { if (timer) clearTimeout(timer); resolve({ exitCode: 127, stdout, stderr: String(error) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ exitCode: code ?? 255, stdout, stderr }); });
    child.stdin.end(options.input ?? "");
  });
}

const host = {
  run: (hostId: string, cwd: string, command: string, timeoutSec = 120): Promise<Exec> => {
    if (hostId === LOCAL_HOST || hostId === "local") return exec("/bin/sh", ["-c", command], { cwd, timeoutSec });
    // OVH holds the SelfyStudio clones and little disk: a scoring run clones a whole project per candidate there, so it is opt-in.
    if (hostId === OVH_HOST && process.env.LP_CHECKERS_OVH !== "1") return Promise.resolve({ exitCode: 127, stdout: "", stderr: "OVH is off for the checker scorecard (set LP_CHECKERS_OVH=1)" });
    if (hostId === OVH_HOST) return exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", OVH, `cd ${quote(cwd)} && ${command}`], { timeoutSec: timeoutSec + 20 });
    return Promise.resolve({ exitCode: 127, stdout: "", stderr: `the live driver cannot reach ${hostId}` });
  },
};

const jsonField = (raw: string, name: string): string => { try { const data = JSON.parse(raw); return String((data?.thread ?? data)?.[name] ?? ""); } catch { return ""; } };

/** A critic as a hidden thread in the candidate's own project folder; the output is read when the thread is idle. */
function threadModel(providerId: string, model: string): ModelPort {
  return {
    async ask(prompt, kind, where) {
      if (!where) throw new Error("a critic thread needs the candidate's project and folder");
      const spawned = await exec(BB, ["thread", "spawn", "--project", where.projectId, "--environment", where.path, "--machine", where.hostId, "--provider", providerId, "--model", model,
        "--reasoning-level", "low", "--visibility", "hidden", "--title", `checkers ${kind}`, "--prompt-file", "-", "--json"], { input: prompt, timeoutSec: 120 });
      const id = spawned.exitCode === 0 ? jsonField(spawned.stdout, "id") : "";
      if (!id) throw new Error(`the critic thread did not start: ${(spawned.stderr || spawned.stdout).trim().slice(0, 300)}`);
      try {
        for (let i = 0; i < 80; i++) {
          const shown = await exec(BB, ["thread", "get", id, "--json"], { timeoutSec: 60 });
          const status = jsonField(shown.stdout, "status");
          if (status === "idle") break;
          if (i === 79 || ["failed", "errored", "stopped"].includes(status)) throw new Error(`the critic thread ended as ${status || "unknown"}`);
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        const output = await exec(BB, ["thread", "output", id, "--json"], { timeoutSec: 60 });
        const text = jsonField(output.stdout, "output");
        if (!text.trim()) throw new Error("the critic gave no output");
        return { text, tokens: null, costUsd: null };
      } finally {
        await exec(BB, ["thread", "archive", id], { timeoutSec: 60 });
      }
    },
  };
}

/**
 * A critic through the local `claude -p` (provider id `claude-cli`): no BB thread, so it works when the hub does not answer, and the answer
 * carries the real token usage and cost. Tools are off and the session is not kept; the prompt goes in on stdin.
 */
function claudeCliModel(model: string): ModelPort {
  return {
    async ask(prompt) {
      const result = await exec("claude", ["-p", "--model", model, "--tools", "", "--system-prompt", "You are a strict code reviewer. Answer exactly as asked.", "--no-session-persistence", "--output-format", "json"], { input: prompt, timeoutSec: 240 });
      let data: { result?: unknown; is_error?: unknown; total_cost_usd?: unknown; modelUsage?: Record<string, Record<string, unknown>> };
      try { data = JSON.parse(result.stdout); } catch { throw new Error(`claude -p gave no JSON: ${(result.stderr || result.stdout).trim().slice(0, 300)}`); }
      if (data.is_error || typeof data.result !== "string" || !data.result.trim()) throw new Error(`claude -p failed: ${String(data.result ?? result.stderr).slice(0, 300)}`);
      // The tokens billed at full price (the cached part of Claude Code's own context is not the review's); the cost is the real one.
      const usage = Object.values(data.modelUsage ?? {})[0] ?? {};
      const tokens = ["inputTokens", "outputTokens", "cacheCreationInputTokens"].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
      return { text: data.result, tokens: tokens || null, costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : null };
    },
  };
}

function openResults(): Database.Database {
  mkdirSync(HOME, { recursive: true });
  const db = new Database(join(HOME, "checkers.db"));
  db.pragma("foreign_keys = OFF");
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='lane_pilot_checker_run'").get()) for (const statement of checkerMigrations) db.exec(statement);
  return db;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // The drill needs no database: it runs the code checkers on a fixture.
  const db = argv[0] === "drill" ? ({} as Database.Database) : openResults();
  const api = createCheckers({
    db: db as never, log,
    async load(options) {
      const source = join(BENCH_HOME, "bench.db");
      if (!existsSync(source)) throw new Error(`no ${source}: run lp-bench refresh-snapshot first`);
      const copy = join(HOME, "snapshot.db");
      copyFileSync(source, copy);
      const snapshot = new Database(copy, { readonly: true });
      const names = new Map([["proj_acpiaqf4wq", "SelfyStudio"], ["proj_ejbam66722", "BB-сервис"], ["proj_a35nni238u", "Клиенты"]]);
      const all = loadCandidates(snapshot as never, { projectNames: names, isSandboxName: isSandboxProjectName }).candidates;
      const byTask = new Map(all.map((candidate) => [candidate.taskId, candidate]));
      log(`${all.length} accepted candidates in the snapshot`);
      return await loadHistory({
        candidates: () => all, host, log, solutionCommit: (candidate) => findSolutionCommit(host, byTask.get(candidate.taskId)!),
        scratch: (hostId) => (hostId === OVH_HOST ? "/home/ubuntu/lp-checkers/clones" : "/tmp/lp-checkers/clones"),
      }, options);
    },
    model: ({ providerId, model }) => (providerId === "claude-cli" ? claudeCliModel(model) : threadModel(providerId, model)),
  });
  const result = await runCheckersCli(api, argv);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

void main().catch((cause) => { console.error(cause instanceof Error ? cause.stack : String(cause)); process.exit(1); });
