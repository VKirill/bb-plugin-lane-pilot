import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const guard = process.env.GUARD_UNDER_TEST ?? join(process.cwd(), "lane-stack/hooks/guard_shell.py");

function run(agentType: string, toolName: string, toolInput: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_HOOK_CLIENT:"claude", ...extraEnv };
  if (!extraEnv.LANE_PILOT_AGENT_TYPE) delete env.LANE_PILOT_AGENT_TYPE;
  const result = spawnSync("python3", [guard], {
    input:JSON.stringify({ agent_type:agentType, tool_name:toolName, tool_input:toolInput, cwd:process.cwd() }),
    encoding:"utf8", env,
  });
  return { status:result.status, out:result.stdout };
}

const bash = (agentType: string, command: string, env: Record<string, string> = {}) => run(agentType, "Bash", { command }, env);
const NATIVE = { LANE_PILOT_AGENT_TYPE:"dev-orchestrator" };

describe("Lane Pilot PM: Lane Pilot merges, so the terminal run machinery is closed", () => {
  for (const command of ["wt-merge-main", "run-init demo", "cd /srv/app && wt-merge-main --run x"]) {
    it(`lane-pilot-pm: ${command} → deny`, () => {
      const result = bash("lane-pilot-pm", command);
      expect(result.status).toBe(2);
      expect(result.out).toContain("lane_pilot_dispatch_writer");
    });
    it(`native dev-orchestrator: ${command} → deny`, () => {
      expect(bash("dev-orchestrator", command, NATIVE).status).toBe(2);
    });
  }
  it("read-only run-validate stays available", () => {
    expect(bash("lane-pilot-pm", "run-validate --run-dir .agents/runs/x --phase pre-dispatch").status).toBe(0);
  });
  it("a terminal dev-orchestrator keeps its run machinery", () => {
    expect(bash("dev-orchestrator", "wt-merge-main").status).toBe(0);
  });
});

describe("Lane Pilot PM ships", () => {
  for (const command of ["git push origin main", "git push", "docker compose up -d --build", "sudo -n systemctl restart app", "npm run deploy"]) {
    it(`native dev-orchestrator: ${command} → allow`, () => {
      expect(bash("dev-orchestrator", command, NATIVE).status).toBe(0);
    });
  }
  it("force push stays blocked", () => {
    for (const command of ["git push --force origin main", "git push -f origin main", "git push -uf origin main", "git push origin +main"]) {
      expect(bash("dev-orchestrator", command, NATIVE).status, command).toBe(2);
    }
  });
  it("a commit message file (-F) next to a push is not a force push", () => {
    expect(bash("dev-orchestrator", "git commit -q -F msg.txt && git push origin main", NATIVE).status).toBe(0);
    expect(bash("dev-orchestrator", "git push --force-with-lease origin main", NATIVE).status).toBe(0);
  });
  it("a commit message that mentions forced pushes or the hook-skip flag is text, not a command", () => {
    const skip = "--no-" + "verify";
    expect(bash("dev-orchestrator", `git commit -m "guard: git push -uf and +main are caught; ${skip} in text is fine" && git push origin main`, NATIVE).status).toBe(0);
    expect(bash("writer", `git commit ${skip} -m "x"`).status).toBe(2);
  });
});

describe("a denied PM edit points where the PM can act", () => {
  const edit = { file_path:join(process.cwd(), "src/app.ts"), content:"x" };
  it("Lane Pilot PM is told to dispatch a writer, not a run supervisor it cannot spawn", () => {
    for (const [agentType, env] of [["lane-pilot-pm", {}], ["dev-orchestrator", NATIVE]] as const) {
      const result = run(agentType, "Write", edit, env);
      expect(result.status).toBe(2);
      expect(result.out).toContain("lane_pilot_dispatch_writer");
      expect(result.out).not.toContain("run supervisor");
    }
  });
  it("a terminal dev-orchestrator keeps the run-supervisor route", () => {
    const result = run("dev-orchestrator", "Write", edit);
    expect(result.status).toBe(2);
    expect(result.out).toContain("run supervisor");
  });

  it("denials for DELETE without WHERE, DROP/TRUNCATE, and malformed payload name a next step", () => {
    const del = bash("writer", "psql -c 'delete from users;'");
    expect(del.status).toBe(2);
    expect(del.out).toContain("WHERE");
    expect(del.out).toMatch(/Add a WHERE clause|scoping/);

    const drop = bash("writer", "psql -c 'DROP TABLE users'");
    expect(drop.status).toBe(2);
    expect(drop.out).toMatch(/Run schema changes through project migrations|explicit review/);

    const malformed = run("dev-orchestrator", "Bash", { command: "   " }, NATIVE);
    expect(malformed.status).toBe(2);
    expect(malformed.out).toContain("supply a command string in command");
  });
});

describe("destructive checks read commands, not text a heredoc hands to a program", () => {
  const skipFlag = "--no-" + "verify";
  it("a python heredoc that only mentions a push with the skip flag is allowed", () => {
    expect(bash("writer", `python3 - <<'EOF'\nprint("git push ${skipFlag} was blocked")\nEOF`).status).toBe(0);
  });
  it("a report written with cat that mentions DROP TABLE is allowed", () => {
    expect(bash("writer", "cat > report.md <<EOF\nThe guard blocks DROP TABLE users.\nEOF").status).toBe(0);
  });
  it("a heredoc piped into a shell is still checked", () => {
    expect(bash("writer", "cat <<EOF | bash\ngit push --force origin main\nEOF").status).toBe(2);
  });
  it("a heredoc fed to bash is still checked", () => {
    expect(bash("writer", `bash <<'EOF'\ngit commit ${skipFlag} -m x\nEOF`).status).toBe(2);
  });
  it("a plain command line is still checked", () => {
    expect(bash("writer", `git commit ${skipFlag} -m x`).status).toBe(2);
  });
});
