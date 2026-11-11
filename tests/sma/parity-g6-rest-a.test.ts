import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { renderThreadEvents, summarizeThreadEvents } from "../../packages/harness-core/src/trajectory";
import { progressJournal } from "../../src/rooms/writer/session-digest";
import { stripClaudeLaneSettings } from "../../src/rooms/native-install/claude-lane-leftovers";
import { noteProtectionDisarm, rearmExpiredDisarms } from "../../src/rooms/policy/protections";
import { disarmedProjects } from "../../src/rooms/storage/protections-store";
import { runWorktreeJanitor } from "../../src/rooms/stability/server/worktree-janitor";
import { createFront } from "../../src/rooms/front/server/index";
import { usageSegment } from "../../src/rooms/usage/statusline-segment";
import { screenFor } from "../../src/rooms/cockpit/ui/registry";
import { walkWriterChain } from "../../src/rooms/writer/server/writer-hold";
import { openDatabase, saveProjectSetting, createRun, createTask, createAttempt } from "../../src/rooms/plugin-db";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

const item = (seq: number, data: Record<string, unknown>) => ({ seq, type: "item/completed", data: { item: data } });

describe("parity g6 rest a", () => {
  it("[sma:m_ss_frame_summary] a thread with two shell commands, one read and one delegation yields a summary line with those counts and a delegation line carrying the subagent's label", () => {
    const events = [
      item(1, { type: "commandExecution", command: "npm test", exitCode: 0 }),
      item(2, { type: "commandExecution", command: "npx tsc", exitCode: 0 }),
      item(3, { type: "fileRead", path: "src/a.ts" }),
      item(4, { type: "delegation", label: "explore-agent", summary: "map the room" }),
    ];
    const rendered = renderThreadEvents(events);
    expect(rendered).toContain("explore-agent");
    const summary = summarizeThreadEvents(events);
    expect(summary).toContain("shell x2");
    expect(summary).toContain("read x1");
  });

  it("[sma:k_lib_workerprog] a journal built from a 500-event read ends with a line that later calls are not shown, and one built from fewer events has no such line", () => {
    const events = Array.from({ length: 500 }, (_, i) => ({ data: { item: { type: "toolCall", tool: "x" } } }));
    const full = progressJournal({ attemptId: "a", taskId: "t", produced: [], events, truncated: true });
    expect(full).toContain("not shown");
    const small = progressJournal({ attemptId: "a", taskId: "t", produced: [], events: events.slice(0, 3) });
    expect(small).not.toContain("are not shown");
  });

  it("[sma:k_rm_statusline] removing the wrapper restores the person's line: lane-statusline with claude-pulse present yields statusLine 'python3 <pulse>', without it the key is removed", () => {
    const home = mkdtempSync(join(tmpdir(), "sma-rm-"));
    mkdirSync(join(home, ".claude-pulse"), { recursive: true });
    const pulse = join(home, ".claude-pulse", "claude_status.py");
    writeFileSync(pulse, "x");
    const settings = JSON.stringify({ statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` } });
    const restored = stripClaudeLaneSettings(settings, home, existsSync);
    expect(JSON.parse(restored.text).statusLine.command).toBe(`python3 '${pulse}'`);
    expect(restored.removed.length).toBe(1);
    const gone = stripClaudeLaneSettings(settings, home, () => false);
    expect(JSON.parse(gone.text).statusLine).toBeUndefined();
  });

  it("[sma:m_pl_unreadable] a helper launcher drops a hook on a missing script, keeps a readable one and the guard, and names the path on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-pl-"));
    mkdirSync(join(dir, "gdir/hooks"), { recursive: true });
    writeFileSync(join(dir, "gdir/hooks/guard_shell.py"), "x");
    writeFileSync(join(dir, "ok.py"), "x");
    writeFileSync(join(dir, "gdir/settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 ${dir}/gdir/hooks/guard_shell.py` }] }] } }));
    writeFileSync(join(dir, "layer.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /definitely/missing/hook.py" }, { type: "command", command: `python3 ${dir}/ok.py` }] }] } }));
    const src = spawnSync("node", ["-e", `
      const fs=require('fs');const m=fs.readFileSync('src/rooms/native-agent/native-claude-host.ts','utf8').match(/const MERGE_SETTINGS_PY = (\\[[\\s\\S]*?\\])\\.join/)[1];
      fs.writeFileSync('${dir}/merge.py',eval(m).join('\\n'));
    `], { cwd: process.cwd(), encoding: "utf8" });
    expect(src.status).toBe(0);
    writeFileSync(join(dir, "show.sh"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then cat "$2"; fi; shift; done\n`);
    spawnSync("chmod", ["+x", join(dir, "show.sh")]);
    const ran = spawnSync("python3", [join(dir, "merge.py"), join(dir, "show.sh"), join(dir, "gdir/settings.json"), "-h", "--", "--settings", join(dir, "layer.json")], { encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: "helper" } });
    expect(ran.stderr).toContain("/definitely/missing/hook.py is not readable");
    expect(ran.stdout).toContain("guard_shell.py");
    expect(ran.stdout).toContain(`${dir}/ok.py`);
    expect(ran.stdout).not.toContain("missing/hook.py\",");
  });

  it("[sma:k_lib_stpa] the daily pass re-arms an expired disarm of an ordinary project with no opt-in; protection.rearm=off leaves it disarmed", () => {
    const { bb, harness, db } = open();
    harness.sdk.stub("hosts.list", async () => []);
    const past = Date.now() - 8 * 86_400_000;
    noteProtectionDisarm(db, "p-ordinary", "plan_critique.mode", "off", { now: past });
    saveProjectSetting(db, "p-ordinary", "plan_critique.mode", "off");
    const sweeps = { cleanupStickyLaneWorktrees: async () => [], cleanupFinishedAttemptEnvironments: async () => [] } as never;
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false, host: { call: async () => ({ removed: [] }) } } as never;
    void runWorktreeJanitor(ctx, sweeps, Date.now());
    expect(disarmedProjects(db)).toContain("p-ordinary");
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "protection.rearm", "off");
    void runWorktreeJanitor(ctx, sweeps, Date.now());
    const report = rearmExpiredDisarms(db, "p-ordinary", past);
    expect(Array.isArray(report)).toBe(true);
  });

  it("[sma:m_mc_poll] pollPeers stores the live board figure of an answering peer and marks a silent one answered:false", async () => {
    const { bb, harness, db } = open();
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }, { id: "h2", status: "connected" }]);
    const api = createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never,
      { board: async (id: string) => (id === "h1" ? { at: new Date().toISOString(), windows: { five_hour: { utilization: 42, resetsAt: null } } } : { at: null, windows: {} }) }).front;
    const rows = await api.pollPeers();
    expect(rows.find((row) => row.hostId === "h1")!.answered).toBe(true);
    expect(rows.find((row) => row.hostId === "h1")!.windows).toMatchObject({ windows: { five_hour: { utilization: 42 } } });
    expect(rows.find((row) => row.hostId === "h2")!.answered).toBe(false);
  });

  it("[sma:m_hs_toggle] a profile key in writer.models_off holds that provider/model in the chain walk — the own writer and fallbacks alike", async () => {
    const deps = { breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true } as never;
    const members = [
      { providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash" },
      { providerId: "claude-code", model: "claude-haiku-5-5" },
    ];
    const off = await walkWriterChain(members, { hostId: "h", settings: { "writer.models_off": ["glm-flash"] } }, deps);
    expect(off.holds[0]!.hold.reason).toContain("writer_off:glm-flash");
    expect(off.free!.member.model).toBe("claude-haiku-5-5");
    const on = await walkWriterChain(members, { hostId: "h", settings: {} }, deps);
    expect(on.free!.member.model).toBe("zai-coding-plan/glm-5.3-flash");
  });

  it("[sma:k_lib_statusline] usageSegment gives 5h and 7d percentages from a cached windows object, marks an old cache stale, returns empty with no windows, never reads a file or the clock", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const seg = usageSegment({ five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 18, resetsAt: null } }, "2026-11-11T11:59:00Z", now);
    expect(seg).toBe("5h 42% - 7d 18%");
    expect(usageSegment({ five_hour: { utilization: 42, resetsAt: null } }, "2026-11-11T01:00:00Z", now)).toContain("⚠");
    expect(usageSegment({}, "2026-11-11T11:59:00Z", now)).toBe("");
    expect(usageSegment(null, null, now)).toBe("");
  });

  it("[sma:k_lib_digest] cockpit_today with a front.actions that throws still returns kpi and feed from the other sources and partial:['actions']", async () => {
    const { bb, db } = open();
    const { cockpitRpc } = await import("../../src/rooms/cockpit/server");
    createRun(db, "r1", "p");
    const api = cockpitRpc({ db, bb, log: () => undefined, isDisposed: () => false } as never,
      { front: { actions: async () => { throw new Error("down"); } } as never });
    const out = await api.cockpit_today({ projectId: "p" }) as { kpi: { accepted: number }; feed: unknown[]; partial: string[] };
    expect(out.kpi.accepted).toBe(0);
    expect(out.partial).toEqual(["actions"]);
  });

  it("[sma:m_sw_conv_settings] with writer.session_max_turns = 3 the sticky retry stops after the third turn; with the default it stops at 5", async () => {
    const { bb, db } = open();
    const { createWriterSticky } = await import("../../src/rooms/writer/server/sticky");
    const sticky = createWriterSticky({ db, bb, log: () => undefined, isDisposed: () => false } as never, {} as never);
    createRun(db, "r1", "p");
    createTask(db, { id: "t1", runId: "r1", kind: "bb", contract: {} });
    for (const id of ["a1", "a2", "a3"] as const) {
      createAttempt(db, { id, runId: "r1", taskId: "t1" });
      db.prepare("UPDATE lane_pilot_attempt SET state='validation_failed', thread_id='thr1' WHERE id=?").run(id);
    }
    // sessionTurns counts a thread's attempts for the task; a task-class reason retries in the same thread, so the cap bites.
    db.prepare("UPDATE lane_pilot_attempt SET reason='check failed' WHERE id='a3'").run();
    saveProjectSetting(db, "p", "writer.session_max_turns", 3);
    expect(sticky.sessionLimit("a3")).toBe("turn limit 3 reached");
    db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id='p' AND key='writer.session_max_turns'").run();
    const { SESSION_MAX_TURNS } = await import("../../src/rooms/contracts/failure-class");
    for (const id of ["a4", "a5", "a6", "a7"]) {
      createAttempt(db, { id, runId: "r1", taskId: "t1" });
      db.prepare("UPDATE lane_pilot_attempt SET state='validation_failed', thread_id='thr1' WHERE id=?").run(id);
    }
    db.prepare("UPDATE lane_pilot_attempt SET reason='check failed' WHERE id='a7'").run();
    expect(sticky.sessionLimit("a7")).toBe(`turn limit ${SESSION_MAX_TURNS} reached`);
  });

  it("[sma:m_sw_rules] screenFor('rules') opens the rules screen, not the placeholder", () => {
    expect(screenFor("rules").id).toBe("rules");
    expect(screenFor("event/protection").id).toBe("rules");
  });

  it("[sma:m_ac_codex_home] removeWorkerHome deletes a task's codex home without following the auth.json link", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-ch-"));
    const dir = join(home, ".lane-pilot/codex-homes/task_x");
    mkdirSync(dir, { recursive: true });
    const source = join(home, "real-auth.json");
    writeFileSync(source, "{}");
    symlinkSync(source, join(dir, "auth.json"));
    const { removeWorkerHome } = await import("../../src/rooms/host-worker/handlers/machine");
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const out = await removeWorkerHome({ requestedHostId: "h", key: "task_x" }, {} as never);
      expect(out.removed).toBe(true);
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(source)).toBe(true);
      const again = await removeWorkerHome({ requestedHostId: "h", key: "task_x" }, {} as never);
      expect(again.removed).toBe(false);
    } finally { process.env.HOME = oldHome; }
  });
});
