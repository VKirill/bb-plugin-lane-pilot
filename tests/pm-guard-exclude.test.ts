import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { hookEnv } from "./hook-env";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const cwd = await mkdtemp(join(tmpdir(), "lp-pm-guard-exclude-"));

function invoke(tool: string, input: Record<string, unknown>) {
  return spawnSync("python3", [guard], {
    input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: tool, tool_input: input, cwd }),
    encoding: "utf8",
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
  });
}

const shell = (command: string) => invoke("Bash", { command });

it("lets the PM write the repository-local git exclude, in the main repo and a worktree", () => {
  for (const command of [
    "tee .git/info/exclude",
    "echo x >> .git/info/exclude",
    "printf x >> .git/info/exclude",
    "echo x >> .git/worktrees/wt1/info/exclude",
  ]) {
    const result = shell(command);
    expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(0);
  }
  const write = invoke("Write", { file_path: ".git/info/exclude" });
  expect(write.status, write.stdout + write.stderr).toBe(0);
});

it("keeps every other .git path denied", () => {
  for (const command of ["echo x > .git/config", "tee .git/HEAD", "echo x >> .git/description"]) {
    const result = shell(command);
    expect(result.status, `${command}\n${result.stdout}${result.stderr}`).toBe(2);
    expect(result.stdout, command).toContain('"decision": "block"');
  }
});

it("points a denied product-file edit at a writer task, not a pasted command or an errand", () => {
  const result = shell("printf x >> .gitignore");
  expect(result.status, result.stdout + result.stderr).toBe(2);
  const reason = JSON.parse(result.stdout).reason as string;
  expect(reason).toContain(
    "Send this edit as a lane_pilot_dispatch_writer task (a one-line change is a fine task); "
    + "never hand the owner a command to paste and never route a repository edit through an errand.",
  );
});
