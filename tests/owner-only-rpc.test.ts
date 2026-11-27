import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OWNER_ONLY_RPC } from "../src/rooms/contracts";
import { OWNER_ONLY_RPC as OWNER_ONLY_RPC_DIRECT } from "../src/rooms/contracts/owner-only-rpc";
import { hookEnv } from "./hook-env";
import { useGuardSync } from "./guard-pool";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const guardPy = readFileSync(guard, "utf8");
const runGuard = useGuardSync(guard);

const pySet = (name: string): string[] => {
  const match = new RegExp(`${name} = \\{([^}]*)\\}`).exec(guardPy);
  return match ? match[1]!.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
};

function run(command: string, agentType: string | null, env: Record<string, string> = {}) {
  const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd: process.cwd() };
  if (agentType) payload.agent_type = agentType;
  return runGuard({
    input: JSON.stringify(payload),
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
  });
}

const AGENT_SHELLS: Array<[string, string | null, Record<string, string>]> = [
  ["lane-pilot-pm", "lane-pilot-pm", {}],
  ["native dev-orchestrator", "dev-orchestrator", { LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator" }],
  ["terminal dev-orchestrator", "dev-orchestrator", {}],
  ["writer", "writer", {}],
  ["errand helper", "errand", {}],
  ["specialist", "specialist:design-lead", {}],
  ["subagent with LANE_PILOT_AGENT_TYPE", "Explore", { LANE_PILOT_AGENT_TYPE: "writer" }],
];

describe("owner-only RPC list", () => {
  it("matches _OWNER_ONLY_RPC in guard_shell.py and is exported from contracts", () => {
    expect(OWNER_ONLY_RPC).toEqual(OWNER_ONLY_RPC_DIRECT);
    expect(new Set(pySet("_OWNER_ONLY_RPC"))).toEqual(new Set(OWNER_ONLY_RPC));
  });

  it("denies specialist_autonomy_set and allows task_board in PM and non-PM shells", () => {
    for (const [label, agentType, env] of AGENT_SHELLS) {
      const denied = run("bb plugin rpc call lane-pilot specialist_autonomy_set '{}'", agentType, env);
      expect(denied.status, label).toBe(2);
      expect(denied.stdout, label).toContain("specialist_autonomy_set is the owner's alone; the owner uses the Lane Pilot page or a terminal");

      const allowed = run("bb plugin rpc call lane-pilot task_board '{}'", agentType, env);
      expect(allowed.status, label).toBe(0);
    }
  });

  it("denies every owner-only RPC across plugin id aliases and shell wrappers", () => {
    for (const method of OWNER_ONLY_RPC) {
      const forms = [
        `bb plugin rpc call lane-pilot ${method} '{}'`,
        `bb plugin rpc call bb-plugin-lane-pilot ${method} '{}'`,
        `bb --json plugin rpc call lane-pilot ${method} --input '{}'`,
        `$BB_CLI plugin rpc call lane-pilot ${method} '{}'`,
        `sh -c 'bb plugin rpc call lane-pilot ${method} "{}"'`,
        `env FOO=1 bb plugin rpc call lane-pilot ${method} '{}'`,
      ];
      for (const cmd of forms) {
        for (const [label, agentType, env] of [
          ["lane-pilot-pm", "lane-pilot-pm", {}],
          ["writer", "writer", {}],
          ["errand", "errand", {}],
        ] as Array<[string, string, Record<string, string>]>) {
          const res = run(cmd, agentType, env);
          expect(res.status, `${label}: ${cmd}`).toBe(2);
          expect(res.stdout, `${label}: ${cmd}`).toContain(`${method} is the owner's alone; the owner uses the Lane Pilot page or a terminal`);
        }
      }
    }
  });

  it("keeps safe companion methods (stop_all, charter_propose, brakes_get) open", () => {
    for (const method of ["stop_all", "charter_propose", "brakes_get"]) {
      for (const [label, agentType, env] of AGENT_SHELLS) {
        const res = run(`bb plugin rpc call lane-pilot ${method} '{}'`, agentType, env);
        expect(res.status, `${label}: ${method}`).toBe(0);
      }
    }
  });
});
