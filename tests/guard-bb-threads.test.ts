import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const guard = process.env.GUARD_UNDER_TEST ?? join(process.cwd(), "lane-stack/hooks/guard_shell.py");

const cases: Array<[string, boolean]> = [
  ["bb status", true],
  ["bb guide commands thread", true],
  ["bb thread show thr_abc --json", true],
  ["bb thread output thr_abc", true],
  ["bb thread log thr_abc --limit 5", true],
  ["bb thread search 'wt-main'", true],
  ["bb thread wait thr_abc --status idle", true],
  ["bb thread tell thr_abc 'snapshot fixed, restart the writer'", true],
  ["bb thread tell thr_abc --message-file /tmp/msg.md", true],
  ["bb thread queue create thr_abc 'hello'", true],
  ["bb thread queue list thr_abc", true],
  ["/home/ubuntu/.bb-machines/x/npm/lib/node_modules/bb-app/host-daemon/dist/bb thread tell thr_abc hi", true],
  ["\"$BB_CLI\" thread tell thr_abc hi", true],
  ["bb thread spawn --project p --prompt x", false],
  ["bb thread archive thr_abc", false],
  ["bb thread update thr_abc --title x", false],
  ["bb thread fork thr_abc", false],
  ["bb thread queue delete thr_abc qmsg_1", false],
  ["bb plugin reload lane-pilot", false],
  ["bb memory add x", false],
  ["bb", false],
];

function allowed(agentType: string, command: string): number | null {
  return spawnSync("python3", [guard], {
    input:JSON.stringify({ agent_type:agentType, tool_name:"Bash", tool_input:{ command }, cwd:process.cwd() }),
    encoding:"utf8",
    env:{ ...process.env, AGENT_HOOK_CLIENT:"claude" },
  }).status;
}

describe("PM agents read and message BB threads", () => {
  for (const agentType of ["lane-pilot-pm", "dev-orchestrator"]) {
    for (const [command, ok] of cases) {
      it(`${agentType}: ${command} → ${ok ? "allow" : "deny"}`, () => {
        expect(allowed(agentType, command)).toBe(ok ? 0 : 2);
      });
    }
  }
});

describe("PM agents run project scripts by path", () => {
  for (const agentType of ["lane-pilot-pm", "dev-orchestrator"]) {
    it(`${agentType}: ./scripts/deploy.sh is judged like bash scripts/deploy.sh`, () => {
      expect(allowed(agentType, "cd /srv/app && ./scripts/deploy.sh --base abc")).toBe(0);
      expect(allowed(agentType, "bash scripts/deploy.sh --base abc")).toBe(0);
    });
  }
});
