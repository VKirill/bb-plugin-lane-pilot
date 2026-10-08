import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");

function payloadOf(command: string, agentType: string | null) {
  const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd: "/tmp" };
  if (agentType) payload.agent_type = agentType;
  return JSON.stringify(payload);
}
function run(command: string, agentType: string | null, env: Record<string, string> = {}) {
  return spawnSync("python3", [guard], { input: payloadOf(command, agentType), encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) });
}
const denied = (command: string, agentType: string | null, env: Record<string, string> = {}) => {
  const res = run(command, agentType, env);
  return res.status === 2 && /\[env-guard\]/.test(res.stdout);
};

// One Python start costs about 30 ms, a role test starts it once per form (58 of them): run one after another they took 1.7 s idle
// and went past the 5 s limit of a test when the whole suite ran beside them (audit 2026-10-08 round 3, item 19). The cases are
// independent, so they run a few at a time, as asynchronous children; the limit stays what it was.
const POOL = 8;
type Verdict = { status: number | null; stdout: string };
async function runMany(cases: Array<{ command: string; agentType: string | null; env?: Record<string, string> }>): Promise<Verdict[]> {
  const results: Verdict[] = new Array(cases.length);
  let next = 0;
  const one = (index: number) => new Promise<void>((done) => {
    const { command, agentType, env = {} } = cases[index]!;
    const child = spawn("python3", [guard], { env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (status) => { results[index] = { status, stdout }; done(); });
    child.stdin.end(payloadOf(command, agentType));
  });
  await Promise.all(Array.from({ length: Math.min(POOL, cases.length) }, async () => { for (let index = next++; index < cases.length; index = next++) await one(index); }));
  return results;
}
const isDenied = (verdict: Verdict) => verdict.status === 2 && /\[env-guard\]/.test(verdict.stdout);

// Audit 2026-10-08 r2, N2: the tool-level cut of env_set / env_delete was bypassed by the bb CLI in a shell.
const FORMS: Array<[string, string]> = [
  ["plain set", "bb env-catalog set MY_KEY secret-value"],
  ["delete", "bb env-catalog delete MY_KEY"],
  ["export json", "bb env-catalog export --format json"],
  ["export", "bb env-catalog export"],
  ["import", "bb env-catalog import-machine-env"],
  ["set of a login", "bb env-catalog set SITE --kind login --user u --password p"],
  ["full path", "/Users/vechkasov/.bb-machines/x/npm/lib/node_modules/bb-app/host-daemon/dist/bb env-catalog set A B"],
  ["BB_CLI", "BB_CLI env-catalog set A B".replace("BB_CLI", "$BB_CLI")],
  ["braced BB_CLI", "${BB_CLI} env-catalog delete A"],
  ["quoted BB_CLI", "\"$BB_CLI\" env-catalog export"],
  ["env prefix", "FOO=1 bb env-catalog set A B"],
  ["env command", "env FOO=1 bb env-catalog set A B"],
  ["env -i", "env -i PATH=/usr/bin bb env-catalog delete A"],
  ["sudo", "sudo -n bb env-catalog set A B"],
  ["nohup", "nohup bb env-catalog set A B"],
  ["timeout", "timeout 5 bb env-catalog export"],
  ["command builtin", "command bb env-catalog set A B"],
  ["exec", "exec bb env-catalog set A B"],
  ["npx", "npx bb env-catalog set A B"],
  ["npx -y", "npx -y bb env-catalog export"],
  ["pnpm dlx", "pnpm dlx bb env-catalog delete A"],
  ["bunx", "bunx bb env-catalog set A B"],
  ["node script", "node /opt/bb-app/dist/bb env-catalog set A B"],
  ["quoted words", "bb 'env-catalog' \"set\" A B"],
  ["quoted executable", "\"bb\" env-catalog set A B"],
  ["escaped", "b\\b env-catalog set A B"],
  ["flag first", "bb --json env-catalog set A B"],
  ["sh -c", "sh -c 'bb env-catalog set A B'"],
  ["bash -lc", "bash -lc \"bb env-catalog export\""],
  ["nested sh -c", "sh -c \"bash -c 'bb env-catalog delete A'\""],
  ["eval", "eval 'bb env-catalog set A B'"],
  ["after &&", "cd /tmp && bb env-catalog set A B"],
  ["after pipe", "echo x | bb env-catalog set A B"],
  ["subshell", "(bb env-catalog set A B)"],
  ["command substitution", "echo $(bb env-catalog export)"],
  ["quoted substitution", "echo \"$(bb env-catalog export)\""],
  ["backticks", "echo `bb env-catalog export`"],
  ["xargs", "echo A | xargs bb env-catalog delete"],
  ["find -exec", "find . -name x -exec bb env-catalog delete A \\;"],
  ["piped into sh", "echo 'bb env-catalog set A B' | sh"],
  ["rpc env-catalog", "bb plugin rpc call env-catalog env_delete --input '{\"name\":\"A\"}'"],
  ["rpc env-catalog set", "$BB_CLI plugin rpc call env-catalog env_set --input-file x.json"],
  ["rpc save_setting", "bb plugin rpc call lane-pilot save_setting --input '{\"key\":\"secrets.allow\",\"value\":\"*\"}'"],
  ["rpc save_settings", "bb plugin rpc call lane-pilot save_settings --input-file x.json"],
  ["rpc reset", "npx bb plugin rpc call lane-pilot reset_project_settings --input-file x.json"],
  ["rpc plugin id", "bb plugin rpc call bb-plugin-lane-pilot save_setting --input-file x.json"],
  ["rpc after flags", "bb --json plugin rpc call lane-pilot save_setting --input-file x.json"],
  ["lane-pilot configure", "bb lane-pilot configure '{}'"],
  ["lane-pilot budget", "bb lane-pilot budget proj run.max_attempts=99"],
  ["schedule create", "bb lane-pilot schedule create '{\"name\":\"x\"}'"],
  ["schedule update", "bb lane-pilot schedule update sch_1 '{}'"],
  ["schedule delete", "bb lane-pilot schedule delete sch_1"],
  ["schedule pause", "bb lane-pilot schedule pause sch_1"],
  ["schedule resume", "bb --json lane-pilot schedule resume sch_1"],
  ["schedule run-now", "bb lane-pilot schedule run-now sch_1"],
  ["schedule dynamic", "bb lane-pilot schedule $SUB sch_1"],
  ["schedule plugin run", "bb plugin run lane-pilot schedule create '{}'"],
  ["schedule in sh -c", "sh -c 'bb lane-pilot schedule create {}'"],
  ["rpc schedule_upsert", "bb plugin rpc call lane-pilot schedule_upsert --input-file x.json"],
  ["rpc schedule_run_now", "bb plugin rpc call lane-pilot schedule_run_now --input '{\"id\":\"sch_1\"}'"],
  ["rpc schedule_delete plugin id", "bb plugin rpc call bb-plugin-lane-pilot schedule_delete --input '{}'"],
  ["rpc schedule_pause piped", "echo x | xargs bb plugin rpc call lane-pilot schedule_pause"],
  ["dynamic subcommand", "bb env-catalog $SUB A B"],
  ["dynamic executable", "$(which bb) env-catalog set A B"],
  ["variable executable", "$MYBB env-catalog set A B"],
];

const ROLES: Array<[string, string | null, Record<string, string>]> = [
  ["errand helper", "errand", {}],
  ["specialist", "specialist:design-lead", {}],
  ["design-lead", "lane-stack:design-lead", {}],
  ["browser-qa", "browser-qa", {}],
  ["docs maintainer", "docs-maintainer", {}],
  ["writer", "writer", {}],
  ["Lane Pilot PM", "lane-pilot-pm", {}],
  ["native PM", "dev-orchestrator", { LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }],
  ["sub-agent of a Lane Pilot session", "Explore", { LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }],
  ["a session with no agent_type", null, { LANE_PILOT_AGENT_TYPE: "writer" }],
];

describe("Lane Pilot agents cannot change the Env Catalog or Lane Pilot's settings from a shell", () => {
  for (const [role, agentType, env] of ROLES) {
    it(`denies every form for ${role}`, async () => {
      const verdicts = await runMany(FORMS.map(([, command]) => ({ command, agentType, env })));
      const missed = FORMS.filter((_, index) => !isDenied(verdicts[index]!)).map(([name]) => name);
      expect(missed).toEqual([]);
    }, 60_000);
  }

  it("leaves reading, requesting and ordinary commands alone", async () => {
    const allowed = [
      "bb env-catalog list --json",
      "bb env-catalog request MY_KEY --purpose 'deploy'",
      "bb env-catalog get MY_KEY",
      "bb thread tell thr_x --message-file /tmp/m.md",
      "bb plugin rpc call lane-pilot session_memory_search --input-file /tmp/q.json",
      "bb plugin rpc call lane-pilot get_screen --input-file /tmp/q.json",
      "bb lane-pilot workflow-trigger proj wf '{}'",
      "bb lane-pilot health",
      "bb lane-pilot schedule list --json",
      "bb lane-pilot schedule show sch_1",
      "bb lane-pilot schedule history sch_1",
      "bb plugin rpc call lane-pilot schedule_list --input '{}'",
      "bb plugin rpc call lane-pilot schedule_runs --input '{\"id\":\"sch_1\"}'",
      "bb plugin rpc call lane-pilot schedule_preview --input-file /tmp/d.json",
      "git commit -m 'docs: bb env-catalog set is for the owner'",
      "grep -rn 'env-catalog set' docs",
      "echo 'bb env-catalog set A B' > /tmp/note.txt",
      "ls -la",
    ];
    const cases = allowed.flatMap((command) => ROLES.filter(([, type]) => type === "errand" || type === "writer").map(([role, agentType, env]) => ({ role, command, agentType, env })));
    const verdicts = await runMany(cases);
    cases.forEach(({ role, command }, index) => {
      expect(`${role}: ${command}: ${/\[env-guard\]/.test(verdicts[index]!.stdout)}`).toBe(`${role}: ${command}: false`);
    });
  });

  it("does not touch a session that is not a Lane Pilot agent", () => {
    expect(denied("bb env-catalog set A B", null)).toBe(false);
    expect(denied("bb env-catalog set A B", "Explore")).toBe(false);
    expect(denied("bb plugin rpc call lane-pilot save_setting --input-file x.json", "frontend-developer")).toBe(false);
  });

  it("denies the same payload from a non-shell tool name spelled differently only through shell tools", () => {
    const res = spawnSync("python3", [guard], {
      input: JSON.stringify({ tool_name: "run_terminal_command", tool_input: { command: "bb env-catalog delete A" }, agent_type: "errand", cwd: "/tmp" }),
      encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/\[env-guard\]/);
  });
});
