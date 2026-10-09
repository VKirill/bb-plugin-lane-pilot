import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";

// Plugin shipping (`bb plugin reload/install/update`) is judged by the checkout folder name; pin a
// temp bb-plugin-lane-pilot cwd so the result does not depend on what this clone directory is called.
const guardHome = mkdtempSync(join(tmpdir(), "lane-pilot-guard-"));
const pluginCheckout = join(guardHome, "bb-plugin-lane-pilot");
mkdirSync(pluginCheckout, { recursive: true });
afterAll(() => rmSync(guardHome, { recursive: true, force: true }));

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
  ["bb thread update thr_abc --title x", false],
  ["bb thread fork thr_abc", false],
  ["bb thread queue delete thr_abc qmsg_1", false],
  ["bb memory add x", false],
  ["bb", false],
];

function allowed(agentType: string, command: string): number | null {
  return spawnSync("python3", [guard], {
    input:JSON.stringify({ agent_type:agentType, tool_name:"Bash", tool_input:{ command }, cwd:process.cwd() }),
    encoding:"utf8",
    env: hookEnv({ AGENT_HOOK_CLIENT:"claude" }),
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
    it(`${agentType}: env PATH=… wrappers unwrap like sudo`, () => {
      expect(allowed(agentType, "sudo -n env PATH=/usr/bin:/bin ./scripts/deploy.sh --base abc")).toBe(0);
      expect(allowed(agentType, "env PATH=/usr/bin:/bin ./scripts/deploy.sh")).toBe(0);
    });
  }
});

describe("dev-orchestrator env wrappers still judge the inner command", () => {
  it("does not launder npm ci through env", () => {
    expect(allowed("dev-orchestrator", "env npm ci")).toBe(2);
  });
  it("CLI orchestrator still denies node scripts", () => {
    expect(allowed("dev-orchestrator", "node scripts/collect-release-evidence.mjs")).toBe(2);
  });
});

function allowedNative(command: string, cwd: string = process.cwd()): number | null {
  return spawnSync("python3", [guard], {
    input: JSON.stringify({
      agent_type: "lane-stack:dev-orchestrator",
      tool_name: "Bash",
      tool_input: { command },
      cwd,
    }),
    encoding: "utf8",
    env: hookEnv({
      AGENT_HOOK_CLIENT: "claude",
      LANE_PILOT_AGENT_TYPE: "lane-stack:dev-orchestrator",
    }),
  }).status;
}

function allowedIn(cwd: string, command: string): number | null {
  return spawnSync("python3", [guard], {
    input:JSON.stringify({ agent_type:"dev-orchestrator", tool_name:"Bash", tool_input:{ command }, cwd }),
    encoding:"utf8",
    env: hookEnv({ AGENT_HOOK_CLIENT:"claude", LANE_PILOT_AGENT_TYPE:"lane-stack:dev-orchestrator" }),
  }).status;
}

describe("BB native PM can run project node scripts", () => {
  it("allows node scripts/*.mjs", () => {
    expect(allowedNative("node scripts/collect-release-evidence.mjs migration --receipt /tmp/r.json")).toBe(0);
  });
  it("allows sudo -n node --env-file=.env scripts/…", () => {
    expect(allowedNative("sudo -n node --env-file=.env scripts/collect-release-evidence.mjs")).toBe(0);
  });
  // The owner's PM ships plugins itself (2026-10-03): BB reads and plugin reload/install pass; thread control stays closed.
  it("reads BB state and reloads plugins, but does not start or archive threads", () => {
    for (const command of ["bb plugin list", "bb plugin logs project-folders", "bb environment providers", "bb memory catalog --scope all"]) {
      expect(allowedNative(command)).toBe(0);
      expect(allowed("lane-pilot-pm", command)).toBe(0);
    }
    // Shipping a plugin only from that plugin's checkout (pinned temp dir named bb-plugin-lane-pilot); a product checkout may not.
    for (const command of ["bb plugin reload lane-pilot", "bb plugin install ./dist", "bb plugin update project-folders"]) {
      expect(allowedNative(command, pluginCheckout)).toBe(0);
      expect(allowedIn("/srv/apps/selfystudio", command)).toBe(2);
    }
    for (const command of ["bb thread create --prompt x", "bb plugin rpc call x y"]) expect(allowedNative(command)).toBe(2);
  });
  // Owner decision 2026-10-08: Env Catalog and Lane Pilot's own CLI and RPC are the PM's to use.
  it("lets the PM use Env Catalog and Lane Pilot's CLI and RPC", () => {
    for (const command of ["bb env-catalog get SECRET", "bb env-catalog set A B", "bb env-catalog delete A", "bb env-catalog export", "bb lane-pilot schedule create '{}'",
      "bb lane-pilot anamnesis confirm rec_1", "bb plugin rpc call lane-pilot save_setting --input '{}'", "bb plugin rpc call env-catalog env_get --input '{}'", "bb plugin run lane-pilot configure '{}'"]) {
      expect(allowedNative(command), command).toBe(0);
      expect(allowed("lane-pilot-pm", command), command).toBe(0);
    }
  });
  it("keeps the terminal orchestrator's bb allowlist as it was", () => {
    expect(allowed("dev-orchestrator", "bb plugin reload lane-pilot")).toBe(2);
  });
});

// 2026-10-09: the owner asked the PM to stop a stuck writer thread and the guard refused. Stopping, archiving, unarchiving and cancelling
// a plan are open to the Lane Pilot PM; starting a thread and changing settings are not. The terminal orchestrator's list is unchanged.
describe("the Lane Pilot PM stops, archives and cancels threads and reads settings, and nothing more", () => {
  const allowedForPm = [
    "bb thread stop thr_abc",
    "bb thread archive thr_abc",
    "bb thread unarchive thr_abc --json",
    "bb thread cancel-plan thr_abc",
    "bb settings show",
    "bb settings show --json",
    "bb settings usage",
    "bb settings version",
  ];
  const refusedForPm = [
    "bb thread new --project p --prompt x",
    "bb thread stop thr_abc && bb thread new --prompt x",
    "bb settings general set theme dark",
    "bb settings general update x 1",
    "bb settings set theme dark",
  ];
  for (const command of allowedForPm) {
    it(`lane-pilot-pm and the native PM allow: ${command}`, () => {
      expect(allowed("lane-pilot-pm", command), command).toBe(0);
      expect(allowedNative(command), command).toBe(0);
    });
  }
  for (const command of refusedForPm) {
    it(`lane-pilot-pm and the native PM refuse: ${command}`, () => {
      expect(allowed("lane-pilot-pm", command), command).toBe(2);
      expect(allowedNative(command), command).toBe(2);
    });
  }
  it("the terminal orchestrator still cannot stop, archive or read settings", () => {
    expect(allowed("dev-orchestrator", "bb thread archive thr_abc")).toBe(2);
    expect(allowed("dev-orchestrator", "bb thread stop thr_abc")).toBe(2);
    expect(allowed("dev-orchestrator", "bb settings show")).toBe(2);
  });
});
