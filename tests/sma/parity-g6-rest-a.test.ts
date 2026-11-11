import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { renderThreadEvents, summarizeThreadEvents } from "../../packages/harness-core/src/trajectory";
import { progressJournal } from "../../src/rooms/writer/session-digest";
import { removeClaudeLaneLeftovers, stripClaudeLaneSettings } from "../../src/rooms/native-install/claude-lane-leftovers";
import { renewDisarm } from "../../src/rooms/policy/protections";
import { REARM_SINCE_KEY, runWorktreeJanitor } from "../../src/rooms/stability/server/worktree-janitor";
import { createFront } from "../../src/rooms/front/server/index";
import { usageSegment } from "../../src/rooms/usage/statusline-segment";
import { screenFor } from "../../src/rooms/cockpit/ui/registry";
import { walkWriterChain } from "../../src/rooms/writer/server/writer-hold";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { setConveyor } from "../../src/rooms/runs";
import { finalTaskIdsSince, workerHomeKey } from "../../src/rooms/storage";
import { hostContract } from "../../src/rooms/contracts";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { migrations, openDatabase, saveProjectSetting, loadProjectSettings, createRun, createTask, createAttempt, getAttempt, listStageReceipts, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { closeOwnerItem } from "../../src/rooms/owner-waiting";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

const item = (seq: number, data: Record<string, unknown>) => ({ seq, type: "item/completed", data: { item: data } });

const DAY = 86_400_000;
const fakeSweeps = { cleanupStickyLaneWorktrees: async () => [], cleanupFinishedAttemptEnvironments: async () => [] } as never;
/** The real janitor pass over a fake hub: every host call is recorded, one machine is connected. */
function janitorEnv() {
  const env = open();
  env.harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }]);
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const ctx = { bb: env.bb, db: env.db, log: (line: string) => { logs.push(line); }, isDisposed: () => false,
    host: { call: async (method: string, input: Record<string, unknown>) => { calls.push({ method, input }); return method === "removeWorkerHome" ? { removed: false } : { removed: [], kept: [] }; } } } as never;
  const pass = (now: number) => runWorktreeJanitor(ctx, fakeSweeps, now);
  return { ...env, calls, logs, pass };
}
const settingValue = (db: ReturnType<typeof openDatabase>, projectId: string, key: string) => {
  const row = db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").get(projectId, key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
};
const ownerItems = (db: ReturnType<typeof openDatabase>, like: string) => db.prepare("SELECT key, state, project_id AS projectId, what, why FROM lane_pilot_owner_item WHERE key LIKE ?").all(like) as Array<{ key: string; state: string; projectId: string | null; what: string; why: string }>;
/** A disarm opened through the real settings save, its term then moved to `until` (the save stamps the term from the clock). */
function disarm(db: ReturnType<typeof openDatabase>, projectId: string, key: string, from: unknown, to: unknown, until: number) {
  if (from !== undefined) saveProjectSetting(db, projectId, key, from);
  saveProjectSetting(db, projectId, key, to);
  const record = JSON.parse((db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id=? AND key=?").get(projectId, `protection.disarm.${key}`) as { value: string }).value);
  db.prepare("UPDATE lane_pilot_project_settings SET value=? WHERE project_id=? AND binding_id='' AND key=?").run(JSON.stringify({ ...record, at: until - 7 * DAY, until }), projectId, `protection.disarm.${key}`);
}

describe("parity g6 rest a", () => {
  it("[sma:m_ss_frame_summary] a delegation prints «label: task text»; the Tools line comes after Files, lists at most ten names with +N more, and never pushes Files out of the cut", () => {
    const events = [
      item(1, { type: "commandExecution", command: "npm test", exitCode: 0 }),
      item(2, { type: "commandExecution", command: "npx tsc", exitCode: 0 }),
      item(3, { type: "fileRead", path: "src/a.ts" }),
      item(4, { type: "delegation", label: "explore-agent", description: "map the room layout" }),
    ];
    const rendered = renderThreadEvents(events);
    expect(rendered).toContain("explore-agent: map the room layout");
    expect(renderThreadEvents([item(1, { type: "delegation", label: "only-label" }), item(2, { type: "delegation", summary: "only text" })])).toMatch(/delegation: only-label[\s\S]*delegation: only text/);
    const small = summarizeThreadEvents(events);
    expect(small).toContain("shell x2");
    expect(small.indexOf("Files:")).toBeLessThan(small.indexOf("Tools:"));
    const tools25 = Array.from({ length: 25 }, (_, n) => item(10 + n, { type: "mcpToolCall", server: "srv", tool: `tool_${n}` }));
    const files12 = (len: number) => Array.from({ length: 12 }, (_, n) => item(100 + n, { type: "fileChange", changes: [{ path: `pkg/${"d".repeat(len)}/file_${n}.ts` }] }));
    // Many tools: the line is capped at ten names and counts the rest.
    const capped = summarizeThreadEvents([...tools25, ...files12(5)]).split("\n").find((line) => line.startsWith("Tools:"))!;
    expect(capped.split(", ")).toHaveLength(10);
    expect(capped).toContain("+16 more");
    // Long names fill the 2000-character cut: Files is whole, the Tools line is what gives way.
    const longTools = Array.from({ length: 25 }, (_, n) => item(10 + n, { type: "mcpToolCall", server: "srv", tool: `tool_${n}_${"x".repeat(60)}` }));
    const digest = summarizeThreadEvents([...longTools, ...files12(60)]);
    expect(digest.length).toBeLessThanOrEqual(2000);
    expect(digest.endsWith("…")).toBe(true);                                  // the cut did happen, and it took the Tools line
    expect(digest.split("\n").find((line) => line.startsWith("Files:"))!.split(", ")).toHaveLength(12);
  });

  it("[sma:k_lib_workerprog] finishing a task whose thread returned 500 events writes PROGRESS.md with the not-shown line; with fewer events the file has none", async () => {
    for (const [count, cwd] of [[500, "/repo"], [3, "/repo"], [3, "/wt/a"]] as const) {
      const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
      const db = openDatabase(bb);
      const config: PrototypeConfig = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" };
      const task: TaskV2 = { schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: cwd, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [] };
      createRun(db, "run", "P", "cli", "/repo");
      createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
      createAttempt(db, { id: "a-t1", runId: "run", taskId: "t1" });
      transitionAttempt(db, "a-t1", "spawn_requested");
      transitionAttempt(db, "a-t1", "running", { threadId: "writer-t1" });
      const writes: Array<{ rootPath?: string; path: string; content: string }> = [];
      const events = Array.from({ length: count }, (_, n) => ({ seq: n, type: "item/completed", data: { item: { type: "toolCall", tool: "x" } } }));
      const { setJevForTests } = await import("@lane-pilot/jev");
      setJevForTests({ judge: async () => ({ by: "jev", decision: {} }) } as never);
      const { createWriterFinish } = await import("../../src/rooms/writer/server/finish");
      const ctx = {
        state: { disposed: false }, db, isDisposed: () => false, log: () => undefined, getThreadBounded: async () => ({ status: "idle" }), host: { call: async () => ({}) },
        bb: { storage: bb.storage, log: { warn() {}, error() {}, info() {} },
          sdk: { threads: { stop: async () => undefined, events: { list: async () => events }, get: async () => ({ status: "idle" }), output: async () => ({ text: "done" }) },
            files: { read: async () => ({ content: "note" }), write: async (args: { rootPath?: string; path: string; content: string }) => { writes.push(args); return {}; } },
            plugins: { callRpc: async ({ method }: { method: string }) => method === "files"
              ? { outcome: "available", files: [{ path: "note.txt", revision: "r1" }], initialPatches: [{ path: "note.txt", patch: "@@\n+note\n", truncated: false }] }
              : { outcome: "available", patches: { "note.txt": { outcome: "available", patch: { path: "note.txt", patch: "@@\n+note\n", truncated: false } } } } },
            environments: { list: async () => [{ id: "env-1" }] } } },
      };
      const finish = createWriterFinish(ctx as never, {
        validateWriterResult: async () => ({ status: "accepted", output: "done", produced: ["note.txt"], verification: [] }),
        persistWriterAcceptance: async () => ({ state: "passed" }),
        workspaceDirt: async () => ({ ok: true, snapshots: [] }), runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
      } as never);
      await finish.finishWriterAttempt({ projectId: "P", config, task, runId: "run", taskId: "t1", attemptId: "a-t1", pmThreadId: "pm", writerThreadId: "writer-t1", dirtBefore: [] }).catch(() => undefined);
      setJevForTests(null);
      const journal = writes.find((write) => write.path.endsWith("PROGRESS.md"));
      expect(journal, `PROGRESS.md written for ${count} events`).toBeDefined();
      // A worktree attempt's journal lands in the run's own folder, where the receipts are: the worktree goes with the attempt.
      expect([journal!.rootPath, journal!.path], `journal of an attempt in ${cwd}`).toEqual(["/repo", "/repo/.agents/runs/run/artifacts/t1/PROGRESS.md"]);
      if (count === 500) expect(journal!.content).toContain("calls after the first 500 thread events are not shown");
      else expect(journal!.content).not.toContain("are not shown");
    }
    expect(progressJournal({ attemptId: "a", taskId: "t", produced: [], events: [], truncated: true })).toContain("not shown");
  });

  it("[sma:k_rm_statusline] the person's line comes back only from the installer's record, restored exactly; without a record the key goes and the pulse command is only suggested, quoted; a dry run lists what is removed, written and suggested", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-rm-"));
    const pulse = join(home, ".claude-pulse", "it's here", "claude_status.py");
    const wrapped = JSON.stringify({ statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` } });
    const record = { type: "command", command: "node /opt/my-line.js --fancy", padding: 2 };
    const restored = stripClaudeLaneSettings(wrapped, home, { saved: record, pulse });
    expect(JSON.parse(restored.text).statusLine).toEqual(record);
    expect(restored.removed).toHaveLength(1);
    expect(restored.written[0]).toContain("my-line.js");
    expect(restored.suggested).toEqual([]);
    // A record that is itself the wrapper is not restored.
    expect(JSON.parse(stripClaudeLaneSettings(wrapped, home, { saved: { type: "command", command: `${home}/.agents/bin/lane-statusline` }, pulse: null }).text).statusLine).toBeUndefined();
    const none = stripClaudeLaneSettings(wrapped, home, { pulse });
    expect(JSON.parse(none.text).statusLine).toBeUndefined();
    expect(none.written).toEqual([]);
    expect(none.suggested[0]).toContain(JSON.stringify(`python3 '${pulse.replace(/'/g, "'\\''")}'`).slice(1, -1));
    // On a real home: the pulse script exists and no record does: the file is not written with a guess; the plan says what it suggests.
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude-pulse"), { recursive: true });
    writeFileSync(join(home, ".claude-pulse", "claude_status.py"), "x");
    writeFileSync(join(home, ".claude/settings.json"), wrapped);
    const dry = await removeClaudeLaneLeftovers({ home });
    expect(dry.settings.some((line) => line.startsWith("suggestion:") && line.includes("claude_status.py"))).toBe(true);
    expect(readFileSync(join(home, ".claude/settings.json"), "utf8")).toBe(wrapped);
    await removeClaudeLaneLeftovers({ home, apply: true });
    expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).statusLine).toBeUndefined();
    // With the installer's record on disk the dry run lists the write and the apply restores exactly that line.
    mkdirSync(join(home, ".agents/state"), { recursive: true });
    writeFileSync(join(home, ".agents/state/statusline.prev.json"), JSON.stringify(record));
    writeFileSync(join(home, ".claude/settings.json"), wrapped);
    const plan = await removeClaudeLaneLeftovers({ home });
    expect(plan.settings.some((line) => line.startsWith("write statusLine"))).toBe(true);
    await removeClaudeLaneLeftovers({ home, apply: true });
    expect(JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8")).statusLine).toEqual(record);
  });

  /** The launcher's Python, extracted from the source and run for a helper over a layer file. */
  function runMerge(layer: unknown, guardSettings: unknown, role = "helper") {
    const dir = mkdtempSync(join(tmpdir(), "sma-pl-"));
    mkdirSync(join(dir, "gdir/hooks"), { recursive: true });
    writeFileSync(join(dir, "gdir/hooks/guard_shell.py"), "x");
    writeFileSync(join(dir, "ok.py"), "x");
    mkdirSync(join(dir, "with space"), { recursive: true });
    writeFileSync(join(dir, "with space", "hook one.py"), "x");
    writeFileSync(join(dir, "gdir/settings.json"), JSON.stringify(guardSettings));
    writeFileSync(join(dir, "layer.json"), JSON.stringify(layer));
    const src = spawnSync("node", ["-e", `
      const fs=require('fs');const m=fs.readFileSync('src/rooms/native-agent/native-claude-host.ts','utf8').match(/const MERGE_SETTINGS_PY = (\\[[\\s\\S]*?\\])\\.join/)[1];
      fs.writeFileSync('${dir}/merge.py',eval(m).join('\\n'));
    `], { cwd: process.cwd(), encoding: "utf8" });
    expect(src.status).toBe(0);
    writeFileSync(join(dir, "show.sh"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then cat "$2"; fi; shift; done\n`);
    spawnSync("chmod", ["+x", join(dir, "show.sh")]);
    const ran = spawnSync("python3", [join(dir, "merge.py"), join(dir, "show.sh"), join(dir, "gdir/settings.json"), "-h", "--", "--settings", join(dir, "layer.json")], { encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: role } });
    return { dir, ran, merged: JSON.parse(ran.stdout || "{}") as { hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>; permissions?: { deny?: string[] }; [key: string]: unknown } };
  }
  const guardOf = (dir: string) => ({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 ${dir}/gdir/hooks/guard_shell.py` }] }] } });
  const commandsOf = (merged: ReturnType<typeof runMerge>["merged"], event = "PreToolUse") => (merged.hooks?.[event] ?? []).flatMap((group) => group.hooks.map((hook) => hook.command));

  it("[sma:m_pl_unreadable] a helper drops a hook whose program file is missing and says which hook of which event and why; paths with spaces, sh -c, bare names, $ and unparsable commands are kept; the guard's own hook is never touched", () => {
    const probe = mkdtempSync(join(tmpdir(), "sma-pl-probe-"));
    const dir = probe;
    const hooks = (commands: string[]) => ({ hooks: { PreToolUse: [{ matcher: "*", hooks: commands.map((command) => ({ type: "command", command })) }] } });
    // The dir is only known after runMerge creates it, so the layer uses paths under /nonexistent and a fixed existing file.
    const exists = join(process.cwd(), "package.json");
    const keep = [`python3 "${exists}"`, "sh -c '/definitely/missing/inside.sh'", "some-bare-command --flag", "python3 $HOME/missing.py", "python3 '/unterminated quote", "node -e '/nope'", `env FOO=bar ${exists}`, "~/.hooks-that-do-not-exist-keep-bare-tilde-no"];
    const drop = ["python3 /definitely/missing/hook.py", "/definitely/missing/direct.sh --x", "env FOO=bar python3 /definitely/missing/env.py", "bash -x /definitely/missing/b.sh"];
    const { ran, merged, dir: made } = runMerge(hooks([...drop, ...keep]), { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /definitely/missing/guard-own.py" }] }] } });
    void dir; void made;
    expect(ran.status).toBe(0);
    const kept = commandsOf(merged);
    for (const command of drop) expect(kept, command).not.toContain(command);
    for (const command of keep.slice(0, 7)) expect(kept, command).toContain(command);
    // the guard's own hook names a missing file too and stays: it is the launcher's own line.
    expect(kept).toContain("python3 /definitely/missing/guard-own.py");
    expect(ran.stderr).toContain("hook 1 of group 1 on event PreToolUse dropped from the settings layer of a helper, /definitely/missing/hook.py does not exist");
    expect(ran.stderr).toContain("python3 /definitely/missing/hook.py");
    expect(ran.stderr).not.toContain("inside.sh");
  });

  it("[sma:m_pl_unreadable] a script path with spaces is judged as one path: present it stays, absent it goes", () => {
    const first = runMerge({}, {});
    const present = join(first.dir, "with space", "hook one.py");
    const gone = join(first.dir, "with space", "gone.py");
    const second = runMerge({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 "${present}"` }, { type: "command", command: `python3 "${gone}"` }] }] } }, {});
    // runMerge makes a fresh dir: the paths above point into the first one, which still exists on disk.
    const kept = commandsOf(second.merged);
    expect(kept).toContain(`python3 "${present}"`);
    expect(kept).not.toContain(`python3 "${gone}"`);
    expect(second.ran.stderr).toContain(`${gone} does not exist`);
  });

  it("[sma:m_pl_unreadable] a failure inside the filter keeps the whole merged layer (core denies, denied servers, the guard), not the guard alone", () => {
    const layer = { permissions: { deny: ["Bash(rm -rf /)"] }, deniedMcpServers: [{ serverName: "bad" }], hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /definitely/missing/hook.py" }] }] } };
    // A guard file whose event value is not a list breaks the filter's own reading of the guard (inside its try), not the merge.
    const broken = runMerge(layer, { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /guard.py" }] }], Odd: { not: "a list" } } });
    expect(broken.ran.status).toBe(0);
    expect(broken.ran.stderr).toContain("hook filter skipped");
    expect(broken.ran.stderr).not.toContain("core settings layer unreadable");
    expect(broken.merged.permissions?.deny).toContain("Bash(rm -rf /)");
    expect(broken.merged.deniedMcpServers).toEqual([{ serverName: "bad" }]);
    expect(commandsOf(broken.merged)).toEqual(expect.arrayContaining(["python3 /definitely/missing/hook.py", "python3 /guard.py"]));
    // A PM keeps the layer whole as before: no filter at all.
    const pm = runMerge(layer, guardOf("/x"), "pm");
    expect(commandsOf(pm.merged)).toContain("python3 /definitely/missing/hook.py");
  });

  describe("[sma:k_lib_stpa] the daily pass re-arms an expired disarm", () => {
    it("re-arms to the level before the disarm, tells the owner with the project and the term in the key, and a second disarm of the same protection is not swallowed by the closed first one", async () => {
      const env = janitorEnv();
      const t0 = Date.now();
      await env.pass(t0);                                    // first pass: the marker is stored
      expect(await env.bb.storage.kv.get(REARM_SINCE_KEY)).toBe(t0);
      disarm(env.db, "p1", "plan_critique.mode", "gate", "off", t0 + DAY);
      const stored = JSON.parse((env.db.prepare("SELECT value FROM lane_pilot_project_settings WHERE project_id='p1' AND key='protection.disarm.plan_critique.mode'").get() as { value: string }).value);
      expect(stored.before).toBe("gate");                    // recorded at disarm time
      await env.pass(t0 + DAY - 1000);                       // term not over yet: nothing happens
      expect(settingValue(env.db, "p1", "plan_critique.mode")).toBe("off");
      await env.pass(t0 + 2 * DAY);
      expect(settingValue(env.db, "p1", "plan_critique.mode")).toBe("gate");       // not the lower "advisory"
      expect(settingValue(env.db, "p1", "protection.disarm.plan_critique.mode")).toBeUndefined();
      const first = ownerItems(env.db, "protection-rearm:p1:plan_critique.mode:%");
      expect(first).toHaveLength(1);
      expect(first[0]!.key).toBe(`protection-rearm:p1:plan_critique.mode:${t0 + DAY}`);
      expect(first[0]!.projectId).toBe("p1");
      closeOwnerItem(env.db, first[0]!.key, "owner");
      env.db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id='p1' AND key='plan_critique.mode'").run();
      disarm(env.db, "p1", "plan_critique.mode", undefined, "off", t0 + 3 * DAY);
      await env.pass(t0 + 4 * DAY);
      const both = ownerItems(env.db, "protection-rearm:p1:plan_critique.mode:%");
      expect(both).toHaveLength(2);
      expect(both.find((row) => row.key.endsWith(String(t0 + 3 * DAY)))!.state).toBe("open");
      // This disarm carried no earlier level (the row was absent before it): the level main writes today.
      expect(settingValue(env.db, "p1", "plan_critique.mode")).toBe("advisory");
      await env.harness.lifecycle.dispose();
    });

    it("never downgrades: an absent setting row is already at the default, only the disarm record ends and nothing is written", async () => {
      const env = janitorEnv();
      const t0 = Date.now();
      await env.pass(t0);
      disarm(env.db, "p2", "code_critique.mode", undefined, "off", t0 + DAY);
      env.db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id='p2' AND key='code_critique.mode'").run();   // the owner reset it to the default
      // A row written back by hand to another armed value is not touched either.
      disarm(env.db, "p3", "plan_fact.mode", undefined, "off", t0 + DAY);
      saveProjectSetting(env.db, "p3", "plan_fact.mode", "gate");
      disarm(env.db, "p3", "owner.words", undefined, "off", t0 + DAY);
      await env.pass(t0 + 2 * DAY);
      expect(settingValue(env.db, "p2", "code_critique.mode")).toBeUndefined();
      expect(settingValue(env.db, "p2", "protection.disarm.code_critique.mode")).toBeUndefined();
      expect(ownerItems(env.db, "protection-rearm:p2:%")).toHaveLength(0);
      expect(settingValue(env.db, "p3", "plan_fact.mode")).toBe("gate");
      expect(settingValue(env.db, "p3", "owner.words")).toBe("risky");
      await env.harness.lifecycle.dispose();
    });

    it("a disarm that had already expired when this version first ran is left as it is and listed once per project with both commands; a renewed term and protection.rearm=off are untouched", async () => {
      const env = janitorEnv();
      const t0 = Date.now();
      disarm(env.db, "p4", "plan_critique.mode", "gate", "off", t0 - 3 * DAY);
      disarm(env.db, "p4", "owner.words", "on", "off", t0 - 2 * DAY);
      await env.pass(t0);                                    // first pass: the marker is t0, both terms ended before it
      await env.pass(t0 + DAY);
      expect(settingValue(env.db, "p4", "plan_critique.mode")).toBe("off");
      expect(settingValue(env.db, "p4", "owner.words")).toBe("off");
      expect(settingValue(env.db, "p4", "protection.disarm.plan_critique.mode")).toBeDefined();
      const listed = ownerItems(env.db, "protection-stale:%");
      expect(listed).toHaveLength(1);
      expect(listed[0]!.projectId).toBe("p4");
      expect(listed[0]!.what).toContain("plan_critique.mode");
      expect(listed[0]!.what).toContain("owner.words");
      expect(listed[0]!.why).toContain("bb lane-pilot integrity p4 --rearm plan_critique.mode");
      expect(listed[0]!.why).toContain("bb lane-pilot integrity p4 --renew plan_critique.mode --days 30");
      // The command it names re-arms (owner at a terminal), and refuses a chat.
      const core = createCore(env.bb, env.db);
      registerCli(core, {} as Services, migrations);
      const refused = await env.harness.behavior.runCli(["integrity", "p4", "--rearm", "plan_critique.mode"], { threadId: "thr" });
      expect(refused.exitCode).toBe(1);
      expect(settingValue(env.db, "p4", "plan_critique.mode")).toBe("off");
      const done = await env.harness.behavior.runCli(["integrity", "p4", "--rearm", "plan_critique.mode"]);
      expect(done.exitCode).toBe(0);
      expect(settingValue(env.db, "p4", "plan_critique.mode")).toBe("gate");
      expect(settingValue(env.db, "p4", "protection.disarm.plan_critique.mode")).toBeUndefined();
      // Renewed term in the future: untouched at its old date and after.
      disarm(env.db, "p5", "code_critique.mode", "gate", "off", t0 + DAY);
      expect("record" in renewDisarm(env.db as never, "p5", "code_critique.mode", 30, "audit running", t0)).toBe(true);
      await env.pass(t0 + 2 * DAY);
      expect(settingValue(env.db, "p5", "code_critique.mode")).toBe("off");
      // protection.rearm=off: nothing is done at all.
      disarm(env.db, "p6", "plan_critique.mode", "gate", "off", t0 + 2 * DAY + 1000);
      saveProjectSetting(env.db, GLOBAL_SETTINGS_PROJECT_ID, "protection.rearm", "off");
      await env.pass(t0 + 5 * DAY);
      expect(settingValue(env.db, "p6", "plan_critique.mode")).toBe("off");
      expect(ownerItems(env.db, "protection-rearm:p6:%")).toHaveLength(0);
      await env.harness.lifecycle.dispose();
    });

    it("one project that throws is logged and does not stop the other projects or the host sweeps after it", async () => {
      const env = janitorEnv();
      const t0 = Date.now();
      await env.pass(t0);
      env.db.exec("CREATE TRIGGER lp_test_boom BEFORE INSERT ON lane_pilot_owner_item WHEN NEW.project_id='bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
      disarm(env.db, "bad", "plan_critique.mode", "gate", "off", t0 + DAY);
      disarm(env.db, "good", "plan_critique.mode", "gate", "off", t0 + DAY);
      const out = await env.pass(t0 + 2 * DAY);
      expect(env.logs.some((line) => line.includes("project bad failed") && line.includes("boom"))).toBe(true);
      expect(settingValue(env.db, "good", "plan_critique.mode")).toBe("gate");
      expect(env.calls.some((call) => call.method === "worktreeJanitor")).toBe(true);
      expect(out).toMatchObject({ removed: 0 });
      await env.harness.lifecycle.dispose();
    });
  });

  it("[sma:m_mc_poll] pollPeers gives each peer its own 5 s: a hung board call marks only its own line, the others are stored at once; an answer with no windows is answered:true — it resolved, only silence reads answered:false", async () => {
    vi.useFakeTimers();
    try {
      const { bb, harness, db } = open();
      harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }, { id: "h2", status: "connected" }, { id: "h3", status: "connected" }]);
      const api = createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never,
        { board: (id: string) => id === "h2" ? new Promise(() => undefined)
          : Promise.resolve(id === "h1" ? { at: new Date().toISOString(), windows: { five_hour: { utilization: 42, resetsAt: null } } } : { at: null, windows: {} }) }).front;
      const polling = api.pollPeers();
      await vi.advanceTimersByTimeAsync(100);
      const early = (await api.peers()).map((row) => row.hostId);
      expect(early).toEqual(expect.arrayContaining(["h1", "h3"]));      // the quick peers are stored while h2 still hangs
      expect(early).not.toContain("h2");
      await vi.advanceTimersByTimeAsync(5_000);
      const rows = await polling;
      expect(rows.find((row) => row.hostId === "h1")).toMatchObject({ answered: true, windows: { windows: { five_hour: { utilization: 42 } } } });
      expect(rows.find((row) => row.hostId === "h2")!.answered).toBe(false);
      // at:null says "answered, no subscription windows": the call resolved, so the peer answered — only a thrown or hung call is silence.
      expect(rows.find((row) => row.hostId === "h3")!.answered).toBe(true);
      await harness.lifecycle.dispose();
    } finally { vi.useRealTimers(); }
  });

  describe("[sma:m_hs_toggle] writer.models_off", () => {
    const deps = { breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true } as never;
    const members = [
      { providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash" },
      { providerId: "claude-code", model: "claude-haiku-5-5" },
    ];
    it("an entry may be a profile key, provider/model or a model id; a member off is skipped, never an unsupported provider", async () => {
      const now = Date.now();
      for (const entry of ["glm-flash", "opencode2/zai-coding-plan/glm-5.3-flash", "zai-coding-plan/glm-5.3-flash"]) {
        const off = await walkWriterChain(members, { hostId: "h", settings: { "writer.models_off": [entry] } }, deps, now);
        expect(off.holds[0]!.hold.reason, entry).toContain("writer_off:");
        expect(off.holds[0]!.hold.reason).not.toContain("core_unsupported");
        expect(off.free!.member.model).toBe("claude-haiku-5-5");
      }
      expect((await walkWriterChain(members, { hostId: "h", settings: {} }, deps, now)).free!.member.model).toBe("zai-coding-plan/glm-5.3-flash");
      const all = await walkWriterChain(members, { hostId: "h", settings: { "writer.models_off": ["glm-flash", "claude-haiku-5-5"] } }, deps, now);
      expect(all.free).toBeUndefined();
      expect(all.allOff).toBe(true);
      expect(all.allUnsupported).toBe(false);
      expect(all.wakeAt).toBe(now + 15 * 60_000);
      const { LIMIT } = await import("../../src/rooms/contracts/failure-class");
      expect(LIMIT.test(all.shortest!.hold.reason)).toBe(true);
    });

    it("through the real start: a chain whose every member is off waits (queued, re-check in 15 min), tells the owner once with the list and the command, sends no unsupported-provider notice, and starts by itself once the list is cleared, closing the item", async () => {
      const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
      const sent: string[] = [];
      harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
      harness.sdk.stub("threads.send", async (input: { input?: Array<{ text: string }> }) => { sent.push(input.input?.[0]?.text ?? ""); return undefined; });
      harness.sdk.stub("threads.context", async () => ({ usage: null }));
      harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
      harness.sdk.stub("threads.events.list", async () => []);
      harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
      const db = openDatabase(bb);
      const ctx = createCore(bb, db);
      const WS = "/ws";
      const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
      const task: TaskV2 = { schema_version: 2, id: "T1", title: "Task T1", risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"], owns_paths: ["T1/**", "a.txt"], never_touch: [], depends_on: [], objective: "Make T1", acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WS }] };
      createRun(db, "run1", "proj1", "bb", WS);
      setRunThread(db, "run1", "thr_pm");
      savePrototypeConfig(db, config);
      createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
      saveTaskPlan(db, "T1", "Plan for T1");
      createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
      const spawned: string[] = [];
      const services = {
        activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined, snapshot: () => [] }, ...noOptionalPlugins,
        runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
        runWriterPool: { acquire: async () => () => undefined },
        stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
        startAfterAcceptance: () => undefined, workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
        spawnWriterAttempt: async (input: { attemptId: string }) => {
          spawned.push(input.attemptId);
          setAttemptWorkspace(db, input.attemptId, { path: "/ws/wt", environmentId: null, decision: {} });
          transitionAttempt(db, input.attemptId, "spawn_requested");
          transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
          return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/ws/wt" };
        },
        finishWriterAttempt: async (input: { attemptId: string }) => { transitionAttempt(db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [] }; },
      } as unknown as Services;
      const { createWriterStart } = await import("../../src/rooms/writer/server/start");
      const { sweepWriterWakes } = await import("../../src/rooms/writer/server/writer-wake");
      Object.assign(services, createWriterStart(ctx, services));
      saveProjectSetting(db, "proj1", "writer.pick", "off");          // the project's own writer, no Jev pick
      saveProjectSetting(db, "proj1", "writer.models_off", ["p/wm", "pm", "zai-coding-plan/glm-5.3-flash", "opencode2/router9/ag/gemini-3.8-flash-high"]);   // the writer, its two default fallbacks and the PM
      services.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task, plan: "Plan for T1" });
      await vi.waitFor(() => expect(getAttempt(db, "T1-a1")?.reason ?? "").toContain("waiting_writer:"), { timeout: 5000 });
      const parked = getAttempt(db, "T1-a1")!;
      expect(parked.state).toBe("queued");
      expect(parked.reason).toContain("writer_off");
      expect(parked.reason).not.toContain("core_unsupported");
      expect(spawned).toEqual([]);
      const wake = (db.prepare("SELECT wake_at FROM lane_pilot_attempt WHERE id='T1-a1'").get() as { wake_at: number }).wake_at;
      expect(wake - Date.now()).toBeGreaterThan(14 * 60_000);
      expect(wake - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      const items = ownerItems(db, "writer-all-off:%");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ key: "writer-all-off:proj1", projectId: "proj1", state: "open" });
      expect(items[0]!.what).toContain("writer.models_off");
      expect(items[0]!.what).toContain("p/wm");
      expect(items[0]!.why).toContain("bb lane-pilot setting proj1 writer.models_off=");
      expect(sent.join("\n")).not.toContain("core_unsupported");
      expect(await bb.storage.kv.get("writer-unsupported:p")).toBeFalsy();
      expect(listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")?.reason ?? "").toContain("выключен");
      // The owner clears the list; the waker re-checks and the task starts by itself.
      saveProjectSetting(db, "proj1", "writer.models_off", []);
      await sweepWriterWakes(ctx, services as never, Date.now() + 16 * 60_000);
      await vi.waitFor(() => expect(spawned).toEqual(["T1-a1"]), { timeout: 5000 });
      expect(ownerItems(db, "writer-all-off:%")[0]!.state).toBe("closed");
      await harness.lifecycle.dispose();
    });
  });

  describe("[sma:k_lib_statusline] bb lane-pilot statusline", () => {
    const setupCli = (windows: unknown) => {
      const env = open();
      env.harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }]);
      registerCli(createCore(env.bb, env.db), { providerUsage: { windows: async () => windows } } as unknown as Services, migrations);
      return { ...env, run: (args: string[]) => env.harness.behavior.runCli(["statusline", ...args]) };
    };
    it("prints the segment of the reading for a known host, exits 1 with a message for an unknown one or none", async () => {
      const live = setupCli({ at: new Date().toISOString(), windows: { five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 18, resetsAt: null } } });
      const ok = await live.run(["h1"]);
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toBe("5h 42% - 7d 18%");
      const unknown = await live.run(["no-such-host"]);
      expect(unknown.exitCode).toBe(1);
      expect(String(unknown.stderr)).toContain("unknown host no-such-host");
      expect((await live.run([])).exitCode).toBe(1);
      await live.harness.lifecycle.dispose();
    });
    it("a stale mark comes only from the reading's own time: old time marks, a reading without a time gets no mark, no windows prints nothing", async () => {
      const old = setupCli({ at: new Date(Date.now() - 5 * 3_600_000).toISOString(), windows: { five_hour: { utilization: 10, resetsAt: null } } });
      expect((await old.run(["h1"])).stdout).toBe("⚠ 5h 10%");
      const untimed = setupCli({ at: null, windows: { five_hour: { utilization: 10, resetsAt: null } } });
      expect((await untimed.run(["h1"])).stdout).toBe("5h 10%");
      const none = setupCli({ at: null, windows: {} });
      expect((await none.run(["h1"])).stdout).toBe("");
      const now = Date.parse("2026-11-11T12:00:00Z");
      expect(usageSegment({}, "2026-11-11T11:59:00Z", now)).toBe("");
      expect(usageSegment(null, null, now)).toBe("");
      for (const env of [old, untimed, none]) await env.harness.lifecycle.dispose();
    });
  });

  it("[sma:k_lib_digest] cockpit_today with a front.actions that throws still returns kpi and feed from the other sources, partial:['actions'], and logs the cause with the source name", async () => {
    const { bb, db } = open();
    const { cockpitRpc } = await import("../../src/rooms/cockpit/server");
    createRun(db, "r1", "p");
    const logs: string[] = [];
    const api = cockpitRpc({ db, bb, log: (line: string) => logs.push(line), isDisposed: () => false } as never,
      { front: { actions: async () => { throw new Error("down"); } } as never });
    const out = await api.cockpit_today({ projectId: "p" }) as { kpi: { accepted: number }; feed: unknown[]; partial: string[] };
    expect(out.kpi.accepted).toBe(0);
    expect(out.partial).toEqual(["actions"]);
    expect(logs.some((line) => line.includes("actions") && line.includes("down"))).toBe(true);
  });

  it("[sma:m_sw_conv_settings] the sticky retry's ceiling is the stored writer.session_max_turns (1-10); an empty, null, zero, negative or non-numeric value means 5, not 1; the work graph answer carries the same ceiling", async () => {
    const { bb, db } = open();
    const { createWriterSticky } = await import("../../src/rooms/writer/server/sticky");
    const { SESSION_MAX_TURNS } = await import("../../src/rooms/contracts/failure-class");
    const sticky = createWriterSticky({ db, bb, log: () => undefined, isDisposed: () => false } as never, {} as never);
    createRun(db, "r1", "p");
    createTask(db, { id: "t1", runId: "r1", kind: "bb", contract: {} });
    const ids: string[] = [];
    for (let n = 1; n <= 12; n++) {
      const id = `a${n}`; ids.push(id);
      createAttempt(db, { id, runId: "r1", taskId: "t1" });
      db.prepare("UPDATE lane_pilot_attempt SET state='validation_failed', thread_id='thr1', reason='check failed' WHERE id=?").run(id);
    }
    const last = (turns: number) => ids[turns - 1]!;
    // 4 turns in the thread: a ceiling of 3 stops it, the default 5 does not; 5 turns stop at the default.
    const limitAt = (turns: number) => { db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr1' WHERE id IN (" + ids.slice(0, turns).map((id) => `'${id}'`).join(",") + ")").run(); db.prepare("UPDATE lane_pilot_attempt SET thread_id='other' WHERE id IN (" + ids.slice(turns).map((id) => `'${id}'`).join(",") + ")").run(); return sticky.sessionLimit(last(turns)); };
    saveProjectSetting(db, "p", "writer.session_max_turns", 3);
    expect(limitAt(3)).toBe("turn limit 3 reached");
    expect(limitAt(2)).toBeNull();
    for (const bad of ["", null, 0, -2, "abc", "  ", false]) {
      saveProjectSetting(db, "p", "writer.session_max_turns", bad);
      expect(limitAt(4), `stored ${JSON.stringify(bad)}`).toBeNull();
      expect(limitAt(5), `stored ${JSON.stringify(bad)}`).toBe(`turn limit ${SESSION_MAX_TURNS} reached`);
    }
    saveProjectSetting(db, "p", "writer.session_max_turns", "7");
    expect(limitAt(6)).toBeNull();
    expect(limitAt(7)).toBe("turn limit 7 reached");
    const { workGraphRpc } = await import("../../src/rooms/work-graph/server/rpc");
    const graphRpc = workGraphRpc({ bb, db } as never, { tokenCursorRow: (() => null) as never });
    for (const [stored, expected] of [[3, 3], ["", 5], [0, 5]] as const) {
      saveProjectSetting(db, "p", "writer.session_max_turns", stored);
      const graph = await graphRpc.work_graph_task({ runId: "r1", taskId: "t1" }) as { turnCeiling: number };
      expect(graph.turnCeiling).toBe(expected);
    }
  });

  describe("[sma:m_sw_rules] the Rules screen reads true values", () => {
    const rules = async (setup?: (env: ReturnType<typeof open>) => Promise<void> | void) => {
      const env = open();
      await setup?.(env);
      const { cockpitRpc } = await import("../../src/rooms/cockpit/server");
      const api = cockpitRpc({ db: env.db, bb: env.bb, log: () => undefined, isDisposed: () => false } as never, {} as never);
      return { env, out: await api.cockpit_rules({ projectId: "p" }) as { rules: Array<{ key: string; current: unknown; disarmed: boolean }>; switches: Array<{ key: string; kind: string; value: unknown }> } };
    };
    it("screenFor('rules') opens the rules screen, not the placeholder", () => {
      expect(screenFor("rules").id).toBe("rules");
      expect(screenFor("event/protection").id).toBe("rules");
    });
    it("with nothing set it shows the defaults the code applies: conveyor on, re-arm on, fallback as an enum value, each protection at its default", async () => {
      const { out } = await rules();
      expect(out.switches).toEqual([
        { key: "conveyor", kind: "flag", value: true },
        { key: "protection.rearm", kind: "flag", value: true },
        { key: "writer.fallback_on_provider_failure", kind: "enum", value: "immediate" },
      ]);
      const byKey = Object.fromEntries(out.rules.map((row) => [row.key, row]));
      expect(byKey["plan_critique.mode"]!.current).toBe("gate");
      expect(byKey["code_critique.mode"]!.current).toBe("advisory");     // the catalog default, not the protection's "armed" word
      expect(byKey["plan_fact.mode"]!.current).toBe("record");
      expect(byKey["owner.words"]!.current).toBe("risky");
      expect(byKey["plan_critique.mode"]!.disarmed).toBe(false);
      expect(byKey["code_critique.mode"]!.disarmed).toBe(true);
    });
    it("with the conveyor off, a stored value and re-arm off it shows them; the conveyor is read from its real state, not a setting", async () => {
      const { out, env } = await rules(async ({ bb, db }) => {
        await setConveyor(bb.storage.kv as never, false, "night");
        saveProjectSetting(db, "p", "plan_critique.mode", "off");
        saveProjectSetting(db, "p", "writer.fallback_on_provider_failure", "after_retry");
        saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "protection.rearm", "off");
        saveProjectSetting(db, "p", "conveyor", "on");              // a setting of that name changes nothing
      });
      expect(out.switches).toEqual([
        { key: "conveyor", kind: "flag", value: false },
        { key: "protection.rearm", kind: "flag", value: false },
        { key: "writer.fallback_on_provider_failure", kind: "enum", value: "after_retry" },
      ]);
      const plan = out.rules.find((row) => row.key === "plan_critique.mode")!;
      expect(plan).toMatchObject({ current: "off", disarmed: true });
      void env;
    });
  });

  describe("[sma:m_ac_codex_home] the throwaway codex home", () => {
    const attempt = (db: ReturnType<typeof openDatabase>, id: string, runId: string, taskId: string, state: string, endedAt: number) => {
      createAttempt(db, { id, runId, taskId });
      db.prepare("UPDATE lane_pilot_attempt SET state=?, updated_at=?, created_at=? WHERE id=?").run(state, endedAt, endedAt, id);
    };
    const seed = (db: ReturnType<typeof openDatabase>, now: number) => {
      for (const runId of ["rs", "rn"]) createRun(db, runId, runId === "rs" ? "strict" : "plain");
      for (const [id, runId] of [["T-done", "rs"], ["T-requeued", "rs"], ["T-fresh", "rs"], ["T-plain", "rn"]] as const) createTask(db, { id, runId, kind: "bb", contract: {} });
      attempt(db, "A-done", "rs", "T-done", "accepted", now - 3 * DAY);
      attempt(db, "A-rq1", "rs", "T-requeued", "blocked", now - 5 * DAY);       // an older final attempt …
      attempt(db, "A-rq2", "rs", "T-requeued", "running", now - 60_000);              // … but the task runs again now
      attempt(db, "A-fresh", "rs", "T-fresh", "accepted", now - 10 * 3_600_000);      // ended 10 hours ago: not yet, its thread may still be resumed
      attempt(db, "A-plain", "rn", "T-plain", "accepted", now - 3 * DAY);
    };
    it("the selection takes tasks whose NEWEST attempt is final and ended a day ago, with no open attempt, newest first with the limit", () => {
      const { db } = open();
      const now = Date.now();
      seed(db, now);
      const rows = finalTaskIdsSince(db, now - 30 * DAY, 300, now);
      expect(rows.map((row) => row.taskId).sort()).toEqual(["T-done", "T-plain"]);
      expect(rows.find((row) => row.taskId === "T-done")).toMatchObject({ projectId: "strict", keys: ["T-done", "A-done"] });
      createTask(db, { id: "T-older", runId: "rs", kind: "bb", contract: {} });
      attempt(db, "A-older", "rs", "T-older", "canceled", now - 9 * DAY);
      expect(finalTaskIdsSince(db, now - 30 * DAY, 2, now).map((row) => row.taskId).sort()).toEqual(["T-done", "T-plain"]);    // the older one is cut by the limit
      expect(finalTaskIdsSince(db, now - 30 * DAY, 3, now).map((row) => row.taskId)).toContain("T-older");
      expect(workerHomeKey(".")).toBeNull();
      expect(workerHomeKey("..")).toBeNull();
      expect(workerHomeKey("")).toBeNull();
      expect(workerHomeKey("a b/c")).toBe("a_b_c");
    });
    it("the janitor makes no host call for a home when worker.strict_user is off; with it on it removes only the quiet final task's homes, and a task id of a dot names no home", async () => {
      const env = janitorEnv();
      const now = Date.now();
      seed(env.db, now);
      createRun(env.db, "rd", "strict");
      createTask(env.db, { id: ".", runId: "rd", kind: "bb", contract: {} });
      attempt(env.db, "A-dot", "rd", ".", "accepted", now - 3 * DAY);
      await env.pass(now);
      expect(env.calls.filter((call) => call.method === "removeWorkerHome")).toEqual([]);      // strict_user unset everywhere
      saveProjectSetting(env.db, "strict", "worker.strict_user", "on");
      await env.pass(now);
      const keys = env.calls.filter((call) => call.method === "removeWorkerHome").map((call) => call.input.key);
      expect([...keys].sort()).toEqual(["A-done", "A-dot", "T-done"]);
      expect(keys).not.toContain("T-requeued");
      expect(keys).not.toContain("T-fresh");
      expect(keys).not.toContain("T-plain");
      expect(keys).not.toContain(".");
      await env.harness.lifecycle.dispose();
    });
    it("the end of an attempt removes nothing: a writer's question stop (judgment), a feedback turn or any other task-scope ending makes no host call", async () => {
      const calls: string[] = [];
      const core = { log: () => undefined, state: { disposed: false }, isDisposed: () => false, host: { call: async (method: string) => { calls.push(method); return {}; } } } as never;
      const { mountWriterTaskFinished } = await import("../../src/rooms/writer/server/attempt-reactions");
      const { emitAttemptFinished } = await import("../../src/rooms/writer/server/attempt-finished");
      mountWriterTaskFinished(core, {} as never, { noteAccepted: vi.fn() } as never);
      const base = { scope: "task" as const, projectId: "p", runId: "r", taskId: "t", attemptId: "a", pmThreadId: "pm", writerThreadId: "w", task: {} as never, config: { hostId: "h1" } as never, result: null };
      for (const [status, reason] of [["blocked", "verdict_block: question_unanswered: product decision"], ["blocked", "judgment: the writer asked a question"], ["canceled", null], ["accepted", null], ["validation_failed", "check failed"]] as const)
        await emitAttemptFinished(core, { ...base, status, reason });
      expect(calls).toEqual([]);
    });
    it("removeWorkerHome refuses a key of a dot, a double dot or an empty key (contract and handler) and removes only its own home, never following the auth.json link", async () => {
      const home = mkdtempSync(join(tmpdir(), "sma-ch-"));
      const root = join(home, ".lane-pilot/codex-homes");
      for (const name of ["task_x", "task_y"]) mkdirSync(join(root, name), { recursive: true });
      const source = join(home, "real-auth.json");
      writeFileSync(source, "{}");
      symlinkSync(source, join(root, "task_x", "auth.json"));
      const { removeWorkerHome } = await import("../../src/rooms/host-worker/handlers/machine");
      const schema = hostContract.removeWorkerHome.input;
      for (const bad of [".", "..", "", ".hidden", "a/b"]) expect(schema.safeParse({ requestedHostId: "h", key: bad }).success, JSON.stringify(bad)).toBe(false);
      expect(schema.safeParse({ requestedHostId: "h", key: "task_x" }).success).toBe(true);
      const oldHome = process.env.HOME;
      process.env.HOME = home;
      try {
        for (const bad of [".", "..", "", ".hidden"]) expect((await removeWorkerHome({ requestedHostId: "h", key: bad }, {} as never)).removed, JSON.stringify(bad)).toBe(false);
        expect(existsSync(join(root, "task_x"))).toBe(true);
        expect(existsSync(join(root, "task_y"))).toBe(true);
        const out = await removeWorkerHome({ requestedHostId: "h", key: "task_x" }, {} as never);
        expect(out.removed).toBe(true);
        expect(existsSync(join(root, "task_x"))).toBe(false);
        expect(existsSync(source)).toBe(true);
        expect(existsSync(join(root, "task_y"))).toBe(true);
        expect((await removeWorkerHome({ requestedHostId: "h", key: "task_x" }, {} as never)).removed).toBe(false);
      } finally { process.env.HOME = oldHome; }
    });
    it("the home is made under the attempt that started the thread, as before, one of the keys the sweep removes by", async () => {
      const { createBbShimEnv } = await import("../../src/rooms/native-agent/server/helper-bb-shim");
      const env = open();
      createRun(env.db, "run1", "strict");
      saveProjectSetting(env.db, "strict", "worker.strict_user", "on");
      const made: string[] = [];
      const host = { call: async (method: string, input: { key?: string }) => { if (method === "prepareWorkerHome") { made.push(input.key!); return { codexHome: `/h/${input.key}`, seeded: [] }; } return { dir: "/d", path: "/d/bin" }; } };
      const resolver = createBbShimEnv({ bb: env.bb, db: env.db, host } as never);
      const entries = await resolver({ threadId: "thr", hostId: "h1", experimental_vkPluginMetadata: { role: "writer", lanePilotRunId: "run1", lanePilotTaskId: "T-9", attemptId: "A-9" } }, "codex");
      expect(made).toEqual(["A-9"]);
      expect(entries.find((entry) => entry.name === "CODEX_HOME")?.value).toBe("/h/A-9");
      // A project without worker.strict_user gets no home and no host call for one.
      createRun(env.db, "run2", "plain");
      made.length = 0;
      const plain = await resolver({ threadId: "thr2", hostId: "h1", experimental_vkPluginMetadata: { role: "writer", lanePilotRunId: "run2", lanePilotTaskId: "T-8", attemptId: "A-8" } }, "codex");
      expect(made).toEqual([]);
      expect(plain.find((entry) => entry.name === "CODEX_HOME")).toBeUndefined();
    });
  });
});
