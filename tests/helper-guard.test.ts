import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");

function invoke(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  return spawnSync("python3", [guard], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
  });
}

describe("Helper role guard checks", () => {
  it("denies an errand-role session writing .gitignore via Edit/Write or shell redirection", () => {
    const editRes = invoke({
      agent_type: "errand",
      tool_name: "Write",
      tool_input: { file_path: ".gitignore", content: "node_modules\n" },
      cwd: process.cwd(),
    });
    expect(editRes.status).toBe(2);
    expect(editRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);

    const bashRes = invoke({
      agent_type: "errand",
      tool_name: "Bash",
      tool_input: { command: "printf x >> .gitignore" },
      cwd: process.cwd(),
    });
    expect(bashRes.status).toBe(2);
    expect(bashRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);
  });

  it("denies an errand-role session running git commit or git push", () => {
    const commitRes = invoke({
      agent_type: "errand",
      tool_name: "Bash",
      tool_input: { command: "git commit -m 'test'" },
      cwd: process.cwd(),
    });
    expect(commitRes.status).toBe(2);
    expect(commitRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);

    const pushRes = invoke({
      agent_type: "errand",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      cwd: process.cwd(),
    });
    expect(pushRes.status).toBe(2);
    expect(pushRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);
  });

  it("allows errand-role session writes to /tmp and its chat folder", () => {
    const tmpRes = invoke({
      agent_type: "errand",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/scratch.txt", content: "ok" },
      cwd: process.cwd(),
    });
    expect(tmpRes.status).toBe(0);

    const chatRes = invoke({
      agent_type: "errand",
      tool_name: "Write",
      tool_input: { file_path: ".bb/chats/thr_test/notes/note.md", content: "notes" },
      cwd: process.cwd(),
    });
    expect(chatRes.status).toBe(0);
  });

  it("specialist can write .agents/ files but not product files", () => {
    const specialistAgentsRes = invoke({
      agent_type: "specialist:design-lead",
      tool_name: "Write",
      tool_input: { file_path: ".agents/design/x.md", content: "# Design" },
      cwd: process.cwd(),
    });
    expect(specialistAgentsRes.status).toBe(0);

    const specialistProductRes = invoke({
      agent_type: "specialist:design-lead",
      tool_name: "Write",
      tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
      cwd: process.cwd(),
    });
    expect(specialistProductRes.status).toBe(2);
    expect(specialistProductRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);

    const errandAgentsRes = invoke({
      agent_type: "errand",
      tool_name: "Write",
      tool_input: { file_path: ".agents/design/x.md", content: "# Design" },
      cwd: process.cwd(),
    });
    expect(errandAgentsRes.status).toBe(2);
    expect(errandAgentsRes.stdout).toMatch(/\[helper-guard\] Helpers do not change the repository/);
  });

  it("writer sessions remain unaffected", () => {
    const writerRes = invoke({
      agent_type: "writer",
      tool_name: "Write",
      tool_input: { file_path: "src/index.ts", content: "export const x = 1;" },
      cwd: process.cwd(),
    });
    expect(writerRes.status).toBe(0);

    const writerGitRes = invoke({
      agent_type: "writer",
      tool_name: "Bash",
      tool_input: { command: "git status" },
      cwd: process.cwd(),
    });
    expect(writerGitRes.status).toBe(0);
  });
});
