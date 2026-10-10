import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { useGuardSync } from "./guard-pool";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const runGuard = useGuardSync(guard);

function run(command: string, agentType: string | null, env: Record<string, string> = {}, cwd = "/tmp") {
  const payload: Record<string, unknown> = { tool_name: "Bash", tool_input: { command }, cwd };
  if (agentType) payload.agent_type = agentType;
  return runGuard({ input: JSON.stringify(payload), env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }) });
}
const denied = (command: string, agentType: string | null, env: Record<string, string> = {}, cwd = "/tmp") => {
  const res = run(command, agentType, env, cwd);
  return res.status === 2 && /\[hub-guard\]/.test(res.stdout);
};

// Audit 2026-10-08 round 3, P0-2, cut down by the owner decision of 2026-10-08 to what breaks the hub by mistake: bb plugin admin commands and ssh to the
// hub, for writers and helpers (the PM keeps reload/install/update from a plugin checkout). Env Catalog and Lane Pilot's CLI are open to everyone.
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
describe("shell guard, audit round 3 P0-2 deny list", () => {
  for (const role of ["writer", "pm-reader", "plan-critic", "code-critic"]) {
    for (const [name, command] of STRICT_ONLY) {
      it(`${role}: ${name}`, () => { expect(denied(command, role)).toBe(true); });
    }
  }

  it("the PM still ships its own plugin and reaches the hub", () => {
    const checkout = "/Users/x/plugins/bb-plugin-lane-pilot";
    expect(denied("bb plugin reload lane-pilot", "lane-pilot-pm", {}, checkout)).toBe(false);
    expect(denied("bb plugin config lane-pilot", "lane-pilot-pm")).toBe(false);
    expect(denied("ssh ovh-main uptime", "lane-pilot-pm")).toBe(false);
  });

  it("everyday commands stay open for a writer, Env Catalog and Lane Pilot's CLI included", () => {
    for (const command of [
      "bb plugin list", "bb plugin logs lane-pilot", "bb env-catalog list", "bb env-catalog get OPENAI_API_KEY", "bb env-catalog get OPENAI_API_KEY --raw",
      "bb env-catalog set A secret", "bb env-catalog delete A", "bb env-catalog export --format json",
      "bb plugin rpc call lane-pilot save_setting --input {}", "bb plugin rpc call env-catalog env_delete --input {}",
      "bb lane-pilot schedule create '{}'", "bb lane-pilot anamnesis confirm x", "bb lane-pilot configure '{}'",
      "bb threads list", "ssh vast nvidia-smi", "echo aGk= | base64 -d", "base64 -d f.b64 > out.txt", "echo hi | sha256sum", "git status",
    ]) expect(denied(command, "writer"), command).toBe(false);
  });
});
