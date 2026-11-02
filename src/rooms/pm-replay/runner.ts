import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runOnHost, type RunCommandHost } from "@lane-pilot/host-calls";
import type { Scenario } from "./store";

/**
 * Ships the replay bundle to a host that has the `claude` CLI and runs scenarios through it (scripts/pm-replay/
 * pm-replay.mjs — the manual harness ported to one file: stub MCP + claude run + judge + score, one JSON line out).
 * Everything travels over runCommand: files are base64 written, results come back on stdout.
 */

const SCRIPT = readFileSync(join(__dirname, "../../../scripts/pm-replay/pm-replay.mjs"), "utf8");
// Absolute: the host RPC refuses a relative cwd. /tmp keeps the bundle out of every repository.
const DIR = "/tmp/lp-pm-replay";

export type ReplayRunResult = { verdict: string; why: string; calls: Array<{ tool: string; args: unknown }>; costUsd: number; reply: string; error?: string };

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const writeCmd = (path: string, text: string) => `mkdir -p ${DIR} && printf %s ${b64(text)} | base64 -d > ${path}`;

/** The bundle on a host: the runner script, the surface, one prompt file per arm, the scenarios file. Returns the remote dir. */
export async function stageBundle(host: RunCommandHost, input: {
  hostId: string; surface: { tools: unknown[] }; arms: Record<string, string>; scenarios: Scenario[];
}): Promise<{ dir: string } | { error: string }> {
  const dir = `${DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const files: Array<[string, string]> = [
    [`${dir}/pm-replay.mjs`, SCRIPT],
    [`${dir}/surface.json`, JSON.stringify(input.surface)],
    [`${dir}/scenarios.json`, JSON.stringify(input.scenarios.map((s) => ({ id: s.id, msg: s.msg, responses: s.responses, expect: s.expect, forbid: s.forbid, argCheck: s.argCheck, should: s.should ?? "", fail_if: s.failIf ?? "" })))],
  ];
  for (const [arm, prompt] of Object.entries(input.arms)) files.push([`${dir}/prompt-${arm}.txt`, prompt]);
  const command = files.map(([path, text]) => `mkdir -p $(dirname ${path}) && printf %s ${b64(text)} | base64 -d > ${path}`).join(" && ");
  const ran = await runOnHost(host, { hostId: input.hostId, cwd: "/tmp", command: `command -v node >/dev/null && command -v claude >/dev/null && ${command}`, timeoutSec: 60 }).catch((cause: unknown) => ({ hostId: input.hostId, exitCode: 1, stdout: "", stderr: String(cause) }));
  if (ran.exitCode !== 0) return { error: `host has no node/claude or the write failed: ${ran.stderr.slice(0, 300)}` };
  return { dir };
}

/** One scenario on one arm; the script prints one JSON line. */
export async function runScenario(host: RunCommandHost, input: {
  hostId: string; dir: string; arm: string; scenarioId: string; sample?: number; timeoutSec?: number;
}): Promise<ReplayRunResult> {
  const work = `${input.dir}/run-${input.arm}-${input.scenarioId}-${input.sample ?? 1}`;
  const cmd = `cd ${input.dir} && node -e "const s=JSON.parse(require('fs').readFileSync('scenarios.json','utf8'));const x=s.find(y=>y.id==='${input.scenarioId}');if(!x)process.exit(3);require('fs').writeFileSync('one.json',JSON.stringify(x))" && node pm-replay.mjs run --scenario one.json --surface surface.json --prompt prompt-${input.arm}.txt --workdir ${work}`;
  const ran = await runOnHost(host, { hostId: input.hostId, cwd: "/tmp", command: cmd, timeoutSec: input.timeoutSec ?? 700 }).catch((cause: unknown) => ({ hostId: input.hostId, exitCode: 1, stdout: "", stderr: String(cause) }));
  const line = ran.stdout.trim().split("\n").pop() ?? "";
  try {
    const out = JSON.parse(line) as { verdict?: string; why?: string; calls?: Array<{ tool: string; args: unknown }>; cost_usd?: number; reply?: string };
    return { verdict: out.verdict ?? "ERROR", why: out.why ?? "", calls: out.calls ?? [], costUsd: out.cost_usd ?? 0, reply: out.reply ?? "" };
  } catch {
    return { verdict: "ERROR", why: `no result line (exit ${ran.exitCode}): ${(ran.stderr || ran.stdout).slice(0, 300)}`, calls: [], costUsd: 0, reply: "" };
  }
}
