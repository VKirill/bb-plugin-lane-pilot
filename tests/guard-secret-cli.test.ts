import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { useGuardPool, type Verdict } from "./guard-pool";

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
  return res.status === 2 && /\[hub-guard\]/.test(res.stdout);
};

// One Python start costs about 50 ms of CPU and a role test starts it once per form (audit 2026-10-08 round 3, item 19): the cases
// go through one warm interpreter that forks the guard per case (tests/guard-pool.ts), each case still a clean run.
const runMany = useGuardPool(guard, payloadOf);
const isDenied = (verdict: Verdict) => verdict.status === 2 && /\[hub-guard\]/.test(verdict.stdout);

// Audit 2026-10-08 r2, N2, cut down by the owner decision of 2026-10-08: the shell is read as a shell would, but what it stops is only what breaks the
// hub by mistake (a plugin admin command of bb). Env Catalog and Lane Pilot's own settings, schedules and anamnesis are not fenced.
const ADMIN = "bb plugin remove lane-pilot";
const FORMS: Array<[string, string]> = [
  ["plain", ADMIN],
  ["config", "bb plugin config lane-pilot set x y"],
  ["token", "bb plugin token lane-pilot"],
  ["safe-mode", "bb plugin safe-mode on"],
  ["full path", "/Users/vechkasov/.bb-machines/x/npm/lib/node_modules/bb-app/host-daemon/dist/bb plugin remove lane-pilot"],
  ["BB_CLI", "$BB_CLI plugin remove lane-pilot"],
  ["braced BB_CLI", "${BB_CLI} plugin remove lane-pilot"],
  ["quoted BB_CLI", "\"$BB_CLI\" plugin remove lane-pilot"],
  ["env prefix", "FOO=1 bb plugin remove lane-pilot"],
  ["env command", "env FOO=1 bb plugin remove lane-pilot"],
  ["env -i", "env -i PATH=/usr/bin bb plugin remove lane-pilot"],
  ["sudo", "sudo -n bb plugin remove lane-pilot"],
  ["nohup", "nohup bb plugin remove lane-pilot"],
  ["timeout", "timeout 5 bb plugin remove lane-pilot"],
  ["command builtin", "command bb plugin remove lane-pilot"],
  ["exec", "exec bb plugin remove lane-pilot"],
  ["npx", "npx bb plugin remove lane-pilot"],
  ["pnpm dlx", "pnpm dlx bb plugin remove lane-pilot"],
  ["node script", "node /opt/bb-app/dist/bb plugin remove lane-pilot"],
  ["quoted words", "bb 'plugin' \"remove\" lane-pilot"],
  ["flag first", "bb --json plugin remove lane-pilot"],
  ["sh -c", "sh -c 'bb plugin remove lane-pilot'"],
  ["bash -lc", "bash -lc \"bb plugin remove lane-pilot\""],
  ["nested sh -c", "sh -c \"bash -c 'bb plugin remove lane-pilot'\""],
  ["eval", "eval 'bb plugin remove lane-pilot'"],
  ["after &&", "cd /tmp && bb plugin remove lane-pilot"],
  ["after pipe", "echo x | bb plugin remove lane-pilot"],
  ["subshell", "(bb plugin remove lane-pilot)"],
  ["command substitution", "echo $(bb plugin remove lane-pilot)"],
  ["xargs", "echo lane-pilot | xargs bb plugin remove"],
  ["find -exec", "find . -name x -exec bb plugin remove lane-pilot \\;"],
  ["piped into sh", "echo 'bb plugin remove lane-pilot' | sh"],
  ["ssh to the hub", "ssh ovh-main uptime"],
];

// The same forms Env Catalog and Lane Pilot's CLI used to meet the guard in: all of them are the owner's agents' to run now.
const OPEN: string[] = [
  "bb env-catalog set MY_KEY secret-value", "bb env-catalog delete MY_KEY", "bb env-catalog export --format json", "bb env-catalog get MY_KEY --raw",
  "bb env-catalog list --json", "bb env-catalog request MY_KEY --purpose 'deploy'", "$BB_CLI env-catalog set A B", "sh -c 'bb env-catalog set A B'",
  "bb plugin rpc call env-catalog env_delete --input '{\"name\":\"A\"}'",
  "bb plugin rpc call lane-pilot save_setting --input '{\"key\":\"secrets.allow\",\"value\":\"*\"}'", "bb plugin rpc call lane-pilot reset_project_settings --input-file x.json",
  "bb plugin rpc call lane-pilot schedule_upsert --input-file x.json", "bb plugin rpc call lane-pilot anamnesis --input-file x.json",
  "bb lane-pilot configure '{}'", "bb lane-pilot budget proj run.max_attempts=99",
  "bb lane-pilot schedule create '{\"name\":\"x\"}'", "bb lane-pilot schedule delete sch_1", "bb lane-pilot schedule run-now sch_1", "bb plugin run lane-pilot schedule create '{}'",
  "bb lane-pilot anamnesis confirm rec_1", "bb lane-pilot anamnesis forget --all --yes",
  "bb thread tell thr_x --message-file /tmp/m.md", "bb lane-pilot workflow-trigger proj wf '{}'", "bb lane-pilot health",
  "git commit -m 'docs: bb plugin remove is for the owner'", "grep -rn 'plugin remove' docs", "echo 'bb plugin remove lane-pilot' > /tmp/note.txt", "ls -la",
];

const ROLES: Array<[string, string | null, Record<string, string>]> = [
  ["errand helper", "errand", {}],
  ["specialist", "specialist:design-lead", {}],
  ["design-lead", "lane-stack:design-lead", {}],
  ["browser-qa", "browser-qa", {}],
  ["docs maintainer", "docs-maintainer", {}],
  ["writer", "writer", {}],
  ["sub-agent of a Lane Pilot session", "Explore", { LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }],
  ["a session with no agent_type", null, { LANE_PILOT_AGENT_TYPE: "writer" }],
];

describe("Lane Pilot agents cannot break the hub from a shell by mistake", () => {
  for (const [role, agentType, env] of ROLES) {
    it(`denies every form for ${role}`, async () => {
      const verdicts = await runMany(FORMS.map(([, command]) => ({ command, agentType, env })));
      const missed = FORMS.filter((_, index) => !isDenied(verdicts[index]!)).map(([name]) => name);
      expect(missed).toEqual([]);
    }, 60_000);
  }

  it("leaves Env Catalog, Lane Pilot's CLI and ordinary commands alone, for every role and for the PM", async () => {
    const cases = OPEN.flatMap((command) => [...ROLES, ["Lane Pilot PM", "lane-pilot-pm", {}] as [string, string | null, Record<string, string>]].map(([role, agentType, env]) => ({ role, command, agentType, env })));
    const verdicts = await runMany(cases);
    cases.forEach(({ role, command }, index) => {
      expect(`${role}: ${command}: ${/\[hub-guard\]/.test(verdicts[index]!.stdout)}`).toBe(`${role}: ${command}: false`);
    });
    // The PM's own allowlist of bb commands lets the same commands through, too.
    const pm = cases.map((row, index) => ({ row, verdict: verdicts[index]! })).filter(({ row }) => row.agentType === "lane-pilot-pm" && /^(bb|\$BB_CLI) /.test(row.command));
    expect(pm.filter(({ verdict }) => verdict.status === 2).map(({ row }) => row.command)).toEqual([]);
  });

  it("does not touch a session that is not a Lane Pilot agent", () => {
    expect(denied(ADMIN, null)).toBe(false);
    expect(denied(ADMIN, "Explore")).toBe(false);
    expect(denied(ADMIN, "frontend-developer")).toBe(false);
  });

  it("denies the same payload from a non-shell tool name spelled differently only through shell tools", () => {
    const res = spawnSync("python3", [guard], {
      input: JSON.stringify({ tool_name: "run_terminal_command", tool_input: { command: ADMIN }, agent_type: "errand", cwd: "/tmp" }),
      encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
    });
    expect(res.status).toBe(2);
    expect(res.stdout).toMatch(/\[hub-guard\]/);
  });
});
