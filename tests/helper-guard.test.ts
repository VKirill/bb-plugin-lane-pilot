import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv } from "./hook-env";
import { useGuardSync } from "./guard-pool";

const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const runGuard = useGuardSync(guard);

function invoke(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  return runGuard({
    input: JSON.stringify(payload),
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
    }, { LANE_PILOT_CHATS: "thr_test,thr_pm" });
    expect(chatRes.status).toBe(0);
  });

  // Audit d8 (docs/task-folder.md): the description said «its own chat» while the code allowed any .bb/chats/. Mutation that breaks it: the
  // prefix-only check again, or the env resolver putting another chat's id into LANE_PILOT_CHATS.
  it("[sma:wi_grant] denies a helper writing another chat's .bb/chats/<id>/, and any chat folder when its own is not known", () => {
    const write = (file: string, env: Record<string, string>) =>
      invoke({ agent_type: "errand", tool_name: "Write", tool_input: { file_path: file, content: "x" }, cwd: process.cwd() }, env);
    expect(write(".bb/chats/thr_pm/artifacts/r.md", { LANE_PILOT_CHATS: "thr_me,thr_pm" }).status).toBe(0);
    expect(write(".bb/chats/thr_other/artifacts/r.md", { LANE_PILOT_CHATS: "thr_me,thr_pm" }).status).toBe(2);
    expect(write(".bb/chats/thr_me_not/r.md", { LANE_PILOT_CHATS: "thr_me" }).status).toBe(2);
    expect(write(".bb/chats/thr_me/r.md", { BB_THREAD_ID: "thr_me" }).status).toBe(0);
    expect(write(".bb/chats/thr_me/r.md", {}).status).toBe(2);
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

  // Owner decision 2026-10-08: Env Catalog tools are not cut by role any more (audit 2026-10-08 S2 withdrawn); Env Catalog keeps a journal.
  describe("Env Catalog tools by role", () => {
    const call = (agent: string, tool: string, input: Record<string, unknown> = { name: "X_KEY" }, env: Record<string, string> = {}) =>
      invoke({ agent_type: agent, tool_name: tool, tool_input: input, cwd: process.cwd() }, env);

    it("every agent, the PM and a browser check included, calls every Env Catalog tool", () => {
      for (const agent of ["errand", "browser-qa", "lane-pilot-pm"]) {
        for (const tool of ["mcp__bb-bridge__env_get", "mcp__bb-bridge__env_set", "bb-bridge.env_delete", "mcp__bb-bridge__env_list"]) {
          expect(call(agent, tool, { name: "X" }).status, `${agent} ${tool}`).toBe(0);
        }
      }
      expect(call("dev-orchestrator", "mcp__bb-bridge__env_get", { name: "X" }, { LANE_PILOT_AGENT_TYPE: "lane-pilot-pm" }).status, "native PM").toBe(0);
    });
  });
});
