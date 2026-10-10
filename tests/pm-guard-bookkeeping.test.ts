import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { useGuardSync } from "./guard-pool";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const runGuard = useGuardSync(guard);
const cwd = await mkdtemp(join(tmpdir(), "lp-pm-guard-bookkeeping-"));

function invoke(tool: string, input: Record<string, unknown>) {
  return runGuard({
    input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: tool, tool_input: input, cwd }),
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
  });
}

const shell = (command: string) => invoke("Bash", { command });

it("PM guard denies writing .agents/PROGRESS.md and .agents/CHANGELOG.md with a message naming .agents/decisions/ and .agents/plans/", () => {
  for (const path of [".agents/PROGRESS.md", "PROGRESS.md", ".agents/CHANGELOG.md", "CHANGELOG.md"]) {
    const write = invoke("Write", { file_path: path });
    expect(write.status, `${path}: ${write.stdout}${write.stderr}`).toBe(2);
    const writeOut = JSON.parse(write.stdout);
    expect(writeOut.decision).toBe("block");
    expect(writeOut.reason).toContain(".agents/decisions/");
    expect(writeOut.reason).toContain(".agents/plans/");

    const edit = invoke("Edit", { file_path: path });
    expect(edit.status, `${path}: ${edit.stdout}${edit.stderr}`).toBe(2);
    const editOut = JSON.parse(edit.stdout);
    expect(editOut.decision).toBe("block");
    expect(editOut.reason).toContain(".agents/decisions/");
    expect(editOut.reason).toContain(".agents/plans/");

    const redirect = shell(`echo '# test' > ${path}`);
    expect(redirect.status, `${path}: ${redirect.stdout}${redirect.stderr}`).toBe(2);
    const redirectOut = JSON.parse(redirect.stdout);
    expect(redirectOut.decision).toBe("block");
    expect(redirectOut.reason).toContain(".agents/decisions/");
    expect(redirectOut.reason).toContain(".agents/plans/");
  }
});
