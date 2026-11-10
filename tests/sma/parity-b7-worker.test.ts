import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { hookEnv } from "../hook-env";
import { useGuardSync } from "../guard-pool";
import { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS, WRITER_DISALLOWED_TOOLS } from "../../src/rooms/native-agent/claude-guard-launch";
import { answerPermit, listPermitTickets } from "../../src/rooms/host-worker/host-handlers";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { createWriterState } from "../../src/rooms/writer/server/state";
import { createBacklog } from "../../src/rooms/backlog/server/scanner";
import { runSandboxedCommandOnHost } from "../../src/rooms/verification/sandbox";

const grants: string[][] = [];
vi.mock("../../src/rooms/verification/worker-user", async () => {
  const real = await vi.importActual<typeof import("../../src/rooms/verification/worker-user")>("../../src/rooms/verification/worker-user");
  return {
    ...real,
    workerReachable: async () => true,
    grantRunFolders: async (_user: string, dirs: readonly string[]) => { grants.push([...dirs]); return [...dirs]; },
    asWorker: (_user: string, program: string, args: readonly string[]) => ({ program, args: [...args] }),
  };
});

const guard = useGuardSync(join(process.cwd(), "lane-stack/hooks/guard_shell.py"));
const runGuard = (command: string, agentType: string, env: Record<string, string> = {}) => guard({
  input: JSON.stringify({ agent_type: agentType, tool_name: "Bash", tool_input: { command }, cwd: "/tmp", session_id: "sess_b7" }),
  env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
});

describe("worker boundaries", () => {
  it("[sma:wb_human_only] the writer's launch denies push, merge, tag and release as disabled tools, a PM's does not", () => {
    const base = { destDir: "/d", command: "/usr/bin/claude", settingsPath: "/d/settings.json", agentType: "writer" };
    const writer = claudeGuardLauncherScript({ ...base, role: "writer" });
    for (const denied of ["Bash(git push:*)", "Bash(git merge:*)", "Bash(git tag:*)", "Bash(gh release:*)"]) {
      expect(writer).toContain(denied);
      expect(WRITER_DISALLOWED_TOOLS).toContain(denied);
    }
    expect(writer).toContain(HELPER_DISALLOWED_TOOLS);
    const pm = claudeGuardLauncherScript({ ...base, role: "pm", agentType: "lane-pilot-pm" });
    for (const denied of ["git push:*", "git merge:*", "git tag:*", "gh release:*"]) expect(pm).not.toContain(denied);
    // And a provider without --disallowedTools meets the same boundary inside the guard itself.
    const home = mkdtempSync(join(tmpdir(), "b7-guard-"));
    const env = { HOME: home, LANE_PILOT_ROLE: "writer" };
    for (const command of ["git push origin main", "git merge feature", "git tag v1", "gh release create v1"]) {
      const verdict = runGuard(command, "writer", env);
      expect(verdict.stdout, command).toContain("deny");
    }
    expect(runGuard("git tag v1", "lane-pilot-pm", { HOME: home, LANE_PILOT_ROLE: "pm" }).stdout).not.toContain("deny");
  });

  it("[sma:wb_danger] a worker-only danger is named and turned into a permit ticket; the PM's net is untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "b7-danger-"));
    const verdict = runGuard("git reset --hard HEAD", "writer", { HOME: home, LANE_PILOT_ROLE: "writer" });
    expect(verdict.stdout).toContain("worker_reset_hard");
    expect(verdict.stdout).toContain("Permit ticket");
    const tickets = readdirSync(join(home, ".agents", "permits", "sess_b7")).filter((name) => name.endsWith(".ticket.json"));
    expect(tickets).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, ".agents", "permits", "sess_b7", tickets[0]!), "utf8"))).toMatchObject({ category: "worker_reset_hard" });
    const pm = runGuard("git reset --hard HEAD", "lane-pilot-pm", { HOME: home, LANE_PILOT_ROLE: "pm" });
    expect(pm.status).toBe(0);
    expect(pm.stdout).not.toContain("worker_reset_hard");
  });

  it("[sma:wb_ticket] a ticket left unanswered for ten minutes expires: no answer is written and it is not listed", async () => {
    const home = mkdtempSync(join(tmpdir(), "b7-ticket-"));
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const session = "sess_b7";
      mkdirSync(join(home, ".agents", "permits", session), { recursive: true });
      const ticket = "a1b2c3d4e5f60718";
      const stale = join(home, ".agents", "permits", session, `${ticket}.ticket.json`);
      writeFileSync(stale, JSON.stringify({ category: "worker_reset_hard", command: "git reset --hard", cwd: "/w", at: Date.now() / 1000 - 601 }));
      writeFileSync(join(home, ".agents", "permits", session, "ffffffffffffffff.ticket.json"), JSON.stringify({ category: "c", command: "x", cwd: "/w", at: Date.now() / 1000 }));
      const refused = await answerPermit({ requestedHostId: "h", session, ticket, decision: "allow", why: "ok" } as never, {} as never);
      expect(refused).toMatchObject({ written: false, expired: true });
      expect(existsSync(join(home, ".agents", "permits", session, `${ticket}.answer.json`))).toBe(false);
      const listed = await listPermitTickets({ requestedHostId: "h" } as never, {} as never);
      expect(listed.tickets.map((row) => row.ticket)).toEqual(["ffffffffffffffff"]);
    } finally { process.env.HOME = before; }
  });
});

describe("strict worker", () => {
  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
    "[sma:wi_clone] a strict-worker check runs in a standalone clone, never the linked worktree",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "b7-repo-"));
      execSync("git init -q && git config user.email t@t && git config user.name t && echo base > tracked.txt && git add -A && git commit -qm init", { cwd: repo });
      writeFileSync(join(repo, "tracked.txt"), "changed\n");
      writeFileSync(join(repo, "untracked.txt"), "loose\n");
      const result = await runSandboxedCommandOnHost({
        requestedHostId: "h", workspacePath: repo, cwd: repo, backend: "linux-bubblewrap", asUser: "lp-worker",
        command: "test -d .git && test ! -f .git && cat tracked.txt untracked.txt && pwd",
      } as never);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("changed");
      expect(result.stdout).toContain("loose");
      // The command ran inside the clone (a .git directory of its own, checked by the command itself), outside the
      // owner's repository; the clone is removed after the run.
      expect(result.cwd.startsWith(repo)).toBe(false);
      expect(result.stdout.trim().endsWith(result.cwd)).toBe(true);
      expect(existsSync(result.cwd)).toBe(false);
      expect(grants.flat().some((dir) => dir === repo || dir.startsWith(`${repo}/`))).toBe(false);
    },
  );
});

describe("daemon tick", () => {
  it("[sma:dt_stopped_spend] a fresh writer state seeds the run budget from known spend", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "R", "P");
    createTask(db, { id: "T", runId: "R", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "R", taskId: "T" });
    db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr_w' WHERE id='a1'").run();
    db.prepare("INSERT INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES ('thr_w','P','x',0,'{}','{\"total\":5000}','','', '', 0)").run();
    const state = createWriterState({ bb, db, log: () => undefined, isDisposed: () => false } as never);
    expect(state.runBudgetFor("R", {}).snapshot().tokens).toBe(5000);
    // A later writer result moves the same budget up from the seeded spend, never from zero.
    state.runBudgetFor("R", {}).noteTokens("thr_w", 5200);
    expect(state.runBudgetFor("R", {}).snapshot().tokens).toBe(5200);
    await harness.lifecycle.dispose();
  });

  it("[sma:dt_intake] with backlog.auto_issue on, the scan sends the first issuable item to the PM chat itself; off keeps the offer", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const sent: string[] = [];
    harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return undefined; });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm" }));
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" });
    createRun(db, "run_cli", "P", "cli", "/repo");
    setRunThread(db, "run_cli", "thr_pm");
    const meta = (id: string) => `__lp_todo__ .agents/todos/items/${id}/meta.yaml\nid: ${id}\ntitle: Item ${id}\nstatus: ready\npriority: high\nestimate: 3\n`;
    const host = { call: async () => ({ exitCode: 0, stdout: meta("t-01") + meta("t-02"), stderr: "" }) };
    const api = createBacklog({ db, bb, host, log: () => undefined, isDisposed: () => false } as never).backlog;
    const now = Date.now();
    saveProjectSetting(db, "P", "backlog.auto_issue", "on");
    expect((await api.scan(now))[0]!.offered).toBe("t-01");
    expect(sent).toHaveLength(1);
    expect(db.prepare("SELECT todo_id FROM lane_pilot_backlog_issue WHERE project_id='P'").all()).toEqual([{ todo_id: "t-01" }]);
    // The daily cap still holds: a second scan the same day sends nothing.
    expect((await api.scan(now + 3_600_000))[0]!.offered).toBeNull();
    saveProjectSetting(db, "P", "backlog.auto_issue", "off");
    expect((await api.scan(now + 25 * 3_600_000))[0]!.offered).toBe("t-02");
    expect(sent).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});
