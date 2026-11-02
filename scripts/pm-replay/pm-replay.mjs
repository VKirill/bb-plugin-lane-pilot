#!/usr/bin/env node
// Lane Pilot PM replay: one scenario, one arm, one JSON result on stdout.
// Ported from the manual pm-live-eval harness (stub-mcp.mjs + run-one.sh + judge.sh + score.py), one file so the
// night graph ships it to a host with a single base64 write.
//
//   node pm-replay.mjs run --scenario <file.json> --surface <file.json> --prompt <file.txt> [--model opus] [--judge-model sonnet] [--workdir <dir>]
//   node pm-replay.mjs stub --surface <file.json> --responses <file.json> --log <calls.jsonl>      (internal: the MCP server claude talks to)
//
// `run` spawns `claude -p` with the PM system prompt and a stub MCP server that publishes the PM tools from the
// surface dump (canned answers from the scenario's `responses`), records every call, then asks a judge model to
// grade the turn against the scenario's should/fail_if. Stdout: {"verdict","why","calls","cost_usd","reply"}.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const self = process.argv[1];

function stub(surfacePath, responsesPath, logPath) {
  const surface = JSON.parse(readFileSync(surfacePath, "utf8"));
  const tools = surface.tools.map((t) => ({
    name: t.name,
    description: [t.description, t.instructions].filter(Boolean).join("\n\n"),
    inputSchema: t.input ?? { type: "object" },
  }));
  const canned = responsesPath ? JSON.parse(readFileSync(responsesPath, "utf8")) : {};
  const seen = {};
  // Per-scenario answers: key "tool" or "tool.action"; a list is served in order, its last entry repeats.
  const answerFor = (name, a) => {
    const key = a?.action && canned[name + "." + a.action] !== undefined ? name + "." + a.action : name;
    const value = canned[key];
    if (value === undefined) return "ok (evaluation harness: the call was accepted; nothing new to report)";
    const list = Array.isArray(value) ? value : [value];
    const i = Math.min((seen[key] = (seen[key] ?? -1) + 1), list.length - 1);
    return typeof list[i] === "string" ? list[i] : JSON.stringify(list[i]);
  };
  const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined) return;
    if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "lp", version: "eval" } } });
    if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    if (m.method === "tools/call") {
      appendFileSync(logPath, JSON.stringify({ tool: m.params.name, args: m.params.arguments }) + "\n");
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: answerFor(m.params.name, m.params.arguments) }] } });
    }
    send({ jsonrpc: "2.0", id: m.id, result: {} });
  });
}

function claude(prompt, { model, systemPromptFile, mcpConfig, allowedTools, maxTurns, cwd }) {
  const argv = ["-p", prompt, "--model", model, "--tools", "", "--setting-sources", "", "--no-session-persistence"];
  if (systemPromptFile) argv.push("--append-system-prompt-file", systemPromptFile);
  if (mcpConfig) argv.push("--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", allowedTools ?? "mcp__lp__*");
  if (maxTurns) argv.push("--max-turns", String(maxTurns));
  argv.push("--output-format", "json");
  const ran = spawnSync("claude", argv, { cwd, input: "", encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: (ran.stderr ?? "") + (ran.error ? `\n${ran.error.message}` : "") };
}

function judgePrompt(scenario, calls, reply) {
  return `You grade one turn of a project-manager agent (Lane Pilot PM) that works for a non-programmer owner. Grade only against the rubric.

SITUATION the PM received:
${scenario.msg}

RIGHT behavior: ${scenario.should ?? ""}
WRONG behavior seen in the real chat (fail if repeated): ${scenario.fail_if ?? ""}

What the PM did — tool calls in order (tool results were canned by the harness; do not penalise it for missing data the harness did not provide):
${JSON.stringify(calls, null, 0).slice(0, 6000)}

PM reply to the owner:
${String(reply).slice(0, 4000)}

Answer with ONLY a JSON object: {"verdict":"PASS"|"FAIL"|"PARTIAL","why":"one sentence"}`;
}

function mechanicalVerdict(scenario, calls) {
  if (!(scenario.expect?.length || scenario.forbid?.length)) return null;
  const names = calls.map((c) => c.tool);
  let ok = (!scenario.expect?.length || names.some((n) => scenario.expect.includes(n))) && !names.some((n) => scenario.forbid?.includes(n));
  for (const [tool, needle] of Object.entries(scenario.argCheck ?? {})) {
    if (!calls.some((c) => c.tool === tool && JSON.stringify(c.args).includes(needle))) ok = false;
  }
  return ok ? "PASS" : "FAIL";
}

function run() {
  const scenario = JSON.parse(readFileSync(flag("scenario"), "utf8"));
  // Absolute: claude runs in the workdir, so a relative prompt or surface path would resolve there.
  const surface = resolve(flag("surface")), prompt = resolve(flag("prompt"));
  const workdir = flag("workdir") ?? mkdtempSync(join(tmpdir(), "pm-replay-"));
  mkdirSync(workdir, { recursive: true });
  // A PM opened in a bare temp folder says «no project here» and does nothing (seen in the manual eval): give it a small git project.
  if (!existsSync(join(workdir, ".git"))) {
    mkdirSync(join(workdir, "src", "pages"), { recursive: true });
    writeFileSync(join(workdir, "README.md"), "# Site\nNuxt site. Pages in src/pages.\n");
    writeFileSync(join(workdir, "src", "pages", "index.vue"), "<template><main>Home</main></template>\n");
    spawnSync("sh", ["-c", "git init -q && git add -A && git -c user.email=replay@lp -c user.name=replay commit -qm init"], { cwd: workdir });
  }
  const responsesPath = join(workdir, "responses.json");
  writeFileSync(responsesPath, JSON.stringify(scenario.responses ?? {}));
  const callsPath = join(workdir, "calls.jsonl");
  const mcpConfig = join(workdir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { lp: { command: "node", args: [self, "stub", "--surface", surface, "--responses", responsesPath, "--log", callsPath] } },
  }));
  const agent = claude(scenario.msg, { model: flag("model", "opus"), systemPromptFile: prompt, mcpConfig, allowedTools: "mcp__lp__*", maxTurns: 8, cwd: workdir });
  let calls = [], reply = "", cost = 0;
  try { calls = readFileSync(callsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { /* no calls */ }
  try { const out = JSON.parse(agent.stdout); reply = out.result ?? ""; cost = out.total_cost_usd ?? 0; } catch { reply = `(agent run failed: ${agent.stderr.slice(0, 300)})`; }
  const judge = claude(judgePrompt(scenario, calls, reply), { model: flag("judge-model", "sonnet"), cwd: workdir });
  let judged = { verdict: "ERROR", why: judge.stdout.slice(0, 200) || judge.stderr.slice(0, 200) };
  try {
    const parsed = JSON.parse(judge.stdout);
    const text = parsed.result ?? judge.stdout;
    const m = /\{.*\}/s.exec(text);
    if (m) judged = JSON.parse(m[0]);
  } catch { /* keep ERROR */ }
  try { const out = JSON.parse(judge.stdout); cost += out.total_cost_usd ?? 0; } catch { /* judge adds nothing countable */ }
  const mechanical = mechanicalVerdict(scenario, calls);
  // The manual score.py rule: a mechanical FAIL wins; anything else is the judge's word.
  const verdict = mechanical === "FAIL" ? "FAIL" : judged.verdict ?? "ERROR";
  process.stdout.write(JSON.stringify({ verdict, why: judged.why ?? "", calls, cost_usd: cost, reply: reply.slice(0, 2000), agent_stderr: agent.stderr.slice(0, 500) }) + "\n");
}

if (args[0] === "stub") stub(flag("surface"), flag("responses"), flag("log"));
else if (args[0] === "run") run();
else { process.stderr.write("usage: pm-replay.mjs run|stub …\n"); process.exit(2); }
