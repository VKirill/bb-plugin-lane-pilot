import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import { SESSION_HOOK_SOURCE } from "../../src/rooms/native-install/session-hook-source";
import {
  STREAMS,
  buildCapsule,
  capsuleRestored,
  failOpen,
  hookOutput,
  injectPack,
  memoryBudgetLine,
  promptRecall,
  reflexAdvice,
  runStreams,
  stallHint,
  stallObserve,
  subagentVerify,
  subagentVerifyText,
  type ToolCtx,
} from "../../src/rooms/session-hooks/logic";

const ctx: ToolCtx = { tool: "bash", sid: "s", cwd: "/tmp", command: "true", path: "", denials: {} };

describe("session hooks that match the SMA card", () => {
  it("[sma:k_h_failopen] a thrown hook body is swallowed and a garbage payload still exits zero", () => {
    expect(() => failOpen(() => { throw new Error("boom"); })).not.toThrow();
    const home = mkdtempSync(join(tmpdir(), "lp-session-hooks-"));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/rooms/session-hooks/cli.ts"], {
      input: "not-json", encoding: "utf8", env: { ...process.env, HOME: home },
    });
    expect(result.status).toBe(0);
  });

  it("[sma:k_hss_memline] the memory line names the 200-line budget and asks to merge near the limit", () => {
    expect(memoryBudgetLine(10)).toBe("MEMORY.md: 10/200 lines");
    expect(memoryBudgetLine(180)).toContain("merge or trim");
    expect(memoryBudgetLine(0)).toBeNull();
  });

  it("[sma:k_hss_restore] [sma:m_pl_compact] [sma:k_h_precompact] [sma:k_lib_flight] the capsule is assembled before trim and restored first", async () => {
    const capsule = buildCapsule({ asks: ["keep the contract"], files: ["src/a.ts"], claims: ["src/a.ts"], trigger: "precompact" });
    expect(capsule.asks).toEqual(["keep the contract"]);
    expect(capsuleRestored(capsule).startsWith("Capsule restored after compaction:")).toBe(true);
    const home = mkdtempSync(join(tmpdir(), "lp-session-hooks-"));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/rooms/session-hooks/cli.ts"], {
      input: JSON.stringify({ hook_event_name: "PreCompact", session_id: "s1", asks: ["keep the contract"], files: ["src/a.ts"], claims: ["src/a.ts"] }),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.status).toBe(0);
    const saved = JSON.parse(await readFile(join(home, ".lane-pilot/session-hooks/s1/capsule.json"), "utf8")) as { asks: string[] };
    expect(saved.asks).toEqual(["keep the contract"]);
  });

  it("[sma:k_hss_out] nothing is written when there is nothing to say", () => {
    expect(hookOutput("SessionStart", null)).toBeNull();
    expect(hookOutput("SessionStart", "hi")).toMatchObject({ hookSpecificOutput: { additionalContext: "hi" } });
  });

  it("[sma:k_hpr_seen] a note already shown in this session does not come back", () => {
    const first = promptRecall({ hits: [{ id: "note-1", content: "body" }], given: [] });
    expect(first.text).toContain("note-1");
    expect(promptRecall({ hits: [{ id: "note-1", content: "body" }], given: first.given }).text).toBeNull();
  });

  it("[sma:k_h_subagent_verify] [sma:k_hsv_extract] a claimed write the tree does not have is the tree's decision", () => {
    const checked = subagentVerify({ claimed: ["/missing.ts", "/present.ts"], changed: [], exists: (path) => path === "/present.ts" });
    expect(checked.missing).toEqual(["/missing.ts"]);
    expect(subagentVerifyText(checked.missing)).toContain("the tree does not have them");
  });

  it("[sma:k_hsv_receipt] one subagent stop writes one receipt", async () => {
    const home = mkdtempSync(join(tmpdir(), "lp-session-hooks-"));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/rooms/session-hooks/cli.ts"], {
      input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s2", claimed: [], changed: [] }),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(result.status).toBe(0);
    const lines = (await readFile(join(home, ".lane-pilot/session-hooks/s2/receipts.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("subagent_receipt");
  });

  it("[sma:k_hpt_inject] the pack goes through updatedInput, and a refusal falls back with a degradation record", () => {
    expect(injectPack("pack", true)).toEqual({ updatedInput: { prompt: "pack" } });
    expect(injectPack("pack", false).degradation).toContain("updatedInput refused");
    expect(injectPack("pack", false).additionalContext).toBe("pack");
  });

  it("[sma:k_h_stall] [sma:k_lib_stall] four stall rules give advice and do not block", () => {
    expect(stallHint("bash", 2, true)).toContain("the same failing call twice");
    expect(stallHint("read", 3, false)).toContain("already been returned 3 times");
    expect(stallHint("edit", 3, false)).toContain("targeted edit");
    expect(stallHint("bash", 3, false)).toContain("Change the hypothesis");
    expect(stallHint("bash", 1, false)).toBe("");
    const observed = stallObserve({}, "bash", { command: "fail" }, { exit_code: 1 });
    expect(observed.hint).toBe("");
    expect("deny" in observed).toBe(false);
  });

  it("[sma:k_hst_record] a fingerprint past the window drops the oldest event", () => {
    const counts = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`seed-${i}`, 1]));
    const observed = stallObserve(counts, "bash", { command: "new-event" }, "ok");
    expect(Object.keys(observed.counts)).toHaveLength(300);
    expect(observed.counts["seed-0"]).toBeUndefined();
    expect(observed.fingerprint).toBeTruthy();
  });

  it("[sma:k_hp_run] a stream that throws is recorded and the call still finishes", () => {
    const result = runStreams(ctx, () => 0, { hard_rules: () => { throw new Error("boom"); } });
    expect(result.perf[0]).toMatchObject({ stream: "hard_rules", error: "boom" });
    expect(result.deny).toBeNull();
    expect(result.perf.map((row) => row.stream)).toEqual([...STREAMS]);
  });

  it("[sma:k_hp_budget] a stream past the soft budget is skipped", () => {
    let tick = 0;
    const result = runStreams(ctx, () => tick++ === 0 ? 0 : 10_000);
    expect(result.perf.filter((row) => row.error === "skipped: soft budget spent").length).toBeGreaterThan(0);
    expect(result.perf[0]!.stream).toBe("hard_rules");
  });

  it("[sma:k_hp_perf] each stream records its own time", () => {
    const result = runStreams(ctx, Date.now);
    expect(result.perf).toHaveLength(STREAMS.length);
    for (const row of result.perf) expect(row.ms).toBeGreaterThanOrEqual(0);
  });

  it("a WHEN lesson fires before the act", () => {
    expect(reflexAdvice(["WHEN lockfile → do not edit it"], "edit lockfile")).toBe("[reflex] do not edit it");
    expect(reflexAdvice(["WHEN lockfile → do not edit it"], "edit readme")).toBeNull();
  });

  it("a native session keeps the guard first and registers a bundled hook that exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-session-hooks-"));
    const dest = join(root, "native-launchers", "id");
    const result = await materializeNativeHookSession({
      destDir: dest,
      moduleUrl: pathToFileURL(join(root, "dist", "host.js")).href,
    });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
        PostToolUse: Array<{ hooks: Array<{ command: string }> }>;
        Stop?: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    expect(settings.hooks.PreToolUse[0]!.hooks[0]!.command).toContain("guard_shell.py");
    expect(settings.hooks.PreToolUse.find((group) => group.matcher === "*")!.hooks.map((hook) => hook.command).join()).not.toContain("session-hook.mjs");
    const command = settings.hooks.SessionStart[0]!.hooks[0]!.command;
    expect(command).toMatch(/^node '/);
    expect(command).not.toContain("experimental-strip-types");
    expect(command).not.toContain("session-hooks/cli.ts");
    const hookPath = command.slice(6, -1);
    expect(hookPath.startsWith(dest)).toBe(true);
    expect(existsSync(hookPath)).toBe(true);
    expect(await readFile(hookPath, "utf8")).toBe(SESSION_HOOK_SOURCE);
    expect(settings.hooks.PostToolUse[0]!.hooks[0]!.command).toBe(command);
    expect(settings.hooks.Stop).toBeUndefined();
    const run = spawnSync(process.execPath, [hookPath], { input: "not-json", encoding: "utf8" });
    expect(run.status).toBe(0);
  });

  it("keeps a project Stop hook and appends the session hook to a project SessionStart", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-session-hooks-"));
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({
      hooks: {
        Stop: [{ matcher: "*", hooks: [{ type: "command", command: "echo project-stop" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo project-start" }] }],
      },
    }));
    writeFileSync(join(cwd, ".claude/settings.local.json"), JSON.stringify({
      hooks: { Stop: [{ matcher: "end", hooks: [{ type: "command", command: "echo overlay-stop" }] }] },
    }));
    const result = await materializeNativeHookSession({ cwd, destDir: join(root, "session") });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }>; SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(settings.hooks.Stop.map((group) => group.hooks[0]!.command)).toEqual(["echo project-stop", "echo overlay-stop"]);
    expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toBe("echo project-start");
    expect(settings.hooks.SessionStart.at(-1)!.hooks[0]!.command).toContain("session-hook.mjs");
  });

  it("the string the plugin writes is an esbuild of the session cli", () => {
    const esbuild = join(process.cwd(), "node_modules/esbuild/bin/esbuild");
    const built = spawnSync(esbuild, [
      join(process.cwd(), "src/rooms/session-hooks/cli.ts"),
      "--bundle", "--platform=node", "--format=esm",
    ], { encoding: "utf8" });
    expect(built.status).toBe(0);
    expect(SESSION_HOOK_SOURCE).toBe(built.stdout);
  });

  it("a bundled host module with no checkout registers a session hook that exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "lp-session-built-"));
    const outfile = join(root, "dist", "host.mjs");
    mkdirSync(join(root, "dist"), { recursive: true });
    const esbuild = join(process.cwd(), "node_modules/esbuild/bin/esbuild");
    const built = spawnSync(esbuild, [
      join(process.cwd(), "src/rooms/native-agent/native-session-hooks.ts"),
      "--bundle", "--platform=node", "--format=esm",
      `--outfile=${outfile}`,
      "--external:@lane-pilot/kit",
    ], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"));
    const host = await import(pathToFileURL(outfile).href) as typeof import("../../src/rooms/native-agent/native-session-hooks");
    const dest = join(root, "native-launchers", "id");
    const result = await host.materializeNativeHookSession({ destDir: dest, moduleUrl: pathToFileURL(outfile).href });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.SessionStart[0]!.hooks[0]!.command;
    const hookPath = command.match(/^node '([^']+)'$/)?.[1];
    expect(hookPath && existsSync(hookPath)).toBe(true);
    expect(hookPath!.startsWith(join(root, "dist"))).toBe(false);
    const run = spawnSync(process.execPath, [hookPath!], { input: "{\"hook_event_name\":\"PreCompact\",\"session_id\":\"built\",\"asks\":[\"keep\"]}", encoding: "utf8", env: { ...process.env, HOME: root } });
    expect(run.status).toBe(0);
    expect(await readFile(join(root, ".lane-pilot/session-hooks/built/capsule.json"), "utf8")).toContain("keep");
  });
});
