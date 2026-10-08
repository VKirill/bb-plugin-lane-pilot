import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");

function run(command: string, agentType: string | null, env: Record<string, string> = {}, cwd = "/tmp") {
  const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType) payload.agent_type = agentType;
  return spawnSync("python3", [guard], { input: JSON.stringify(payload), encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) });
}
const denied = (command: string, agentType: string | null, env: Record<string, string> = {}, cwd = "/tmp") => {
  const res = run(command, agentType, env, cwd);
  return res.status === 2 && /\[env-guard\]/.test(res.stdout);
};

// Audit 2026-10-08 round 3, P0-2: the strict list for writers and helpers (the PM keeps reload/install/update from a plugin checkout).
const STRICT_ONLY: Array<[string, string]> = [
  ["plugin config", "bb plugin config lane-pilot set secrets.allow '*'"],
  ["plugin token", "bb plugin token lane-pilot"],
  ["plugin disable", "bb plugin disable lane-pilot"],
  ["plugin enable", "bb plugin enable lane-pilot"],
  ["plugin reload", "bb plugin reload lane-pilot"],
  ["plugin remove", "bb plugin remove lane-pilot"],
  ["plugin safe-mode", "bb plugin safe-mode on"],
  ["flag first", "bb --json plugin reload lane-pilot"],
  ["env wrapper", "env FOO=1 bb plugin token lane-pilot"],
  ["sh -c", "sh -c 'bb plugin disable lane-pilot'"],
  ["ssh to the hub by alias", "ssh ovh-main 'sqlite3 ~/.bb/plugins/env-catalog/data.db .dump'"],
  ["ssh to the hub by address", "ssh -i ~/.ssh/oracle_bb ubuntu@10.8.0.1 cat ~/.bb/master.key"],
  ["ssh to the hub public address", "ssh 54.37.129.153 ls"],
  ["scp from the hub", "scp ovh-main:~/.bb/plugins/env-catalog/data.db /tmp/x"],
  ["rsync from the hub", "rsync -a ubuntu@10.8.0.1:/home/ubuntu/.bb /tmp/bb"],
  ["ssh inside sh -c", "bash -c 'ssh vechkasov-ovh id'"],
];
const EVERYONE: Array<[string, string]> = [
  ["env-catalog get --raw", "bb env-catalog get OPENAI_API_KEY --raw"],
  ["env-catalog get --raw first", "bb env-catalog get --raw OPENAI_API_KEY"],
  ["env-catalog get --raw=true", "bb env-catalog get OPENAI_API_KEY --raw=true"],
  ["base64 into sh", "echo YmIgZW52LWNhdGFsb2cgc2V0IEEgQg== | base64 -d | sh"],
  ["base64 into bash", "base64 -d <<< 'YmI=' | bash"],
  ["base64 into /bin/sh", "echo x | base64 --decode | /bin/sh"],
  ["base64 into sudo bash", "base64 -d s.b64 | sudo bash"],
  ["sh over a decoded substitution", "sh -c \"$(echo YmI= | base64 -d)\""],
  ["eval of a decoded substitution", "eval \"$(echo YmI= | base64 -d)\""],
];

describe("shell guard, audit round 3 P0-2 deny list", () => {
  for (const role of ["writer", "pm-reader", "plan-critic", "code-critic"]) {
    for (const [name, command] of [...STRICT_ONLY, ...EVERYONE]) {
      it(`${role}: ${name}`, () => { expect(denied(command, role)).toBe(true); });
    }
  }

  for (const [name, command] of EVERYONE) {
    it(`PM: ${name}`, () => { expect(denied(command, "lane-pilot-pm")).toBe(true); });
  }

  it("the PM still ships its own plugin and reaches the hub", () => {
    const checkout = "/Users/x/plugins/bb-plugin-lane-pilot";
    expect(denied("bb plugin reload lane-pilot", "lane-pilot-pm", {}, checkout)).toBe(false);
    expect(denied("bb plugin config lane-pilot", "lane-pilot-pm")).toBe(false);
    expect(denied("ssh ovh-main uptime", "lane-pilot-pm")).toBe(false);
  });

  it("everyday commands stay open for a writer", () => {
    for (const command of [
      "bb plugin list", "bb plugin logs lane-pilot", "bb env-catalog list", "bb env-catalog get OPENAI_API_KEY",
      "bb threads list", "ssh vast nvidia-smi", "echo aGk= | base64 -d", "base64 -d f.b64 > out.txt", "echo hi | sha256sum", "git status",
    ]) expect(denied(command, "writer"), command).toBe(false);
  });
});
