import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeNativeHookSession } from "../../src/rooms/native-agent/native-session-hooks";
import {
  codeMapDrift,
  pretaskDecision,
  runStreams,
  sessionEndDraft,
  sessionStartText,
  stallObserve,
  stallStateOf,
  STREAMS,
  type ToolCtx,
} from "../../src/rooms/session-hooks/logic";
import { reflexLinesOf, taskFileCards } from "../../src/rooms/writer/server/writer-knowledge";
import { persistTaskFolder } from "../../src/rooms/verification/git-integrate";
import { readRateLimitSnapshot, snapshotAsBoardWindows, windowHold, RATE_LIMIT_PREFIX } from "../../src/rooms/stability/server/rate-limit-watch";

const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");

function guard(payload: Record<string, unknown>, env: Record<string, string> = {}) {
  const ran = spawnSync("python3", [GUARD], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: ran.status, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
}

function hook(payload: Record<string, unknown>, home: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], {
    input: JSON.stringify(payload), encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

const bashPayload = (command: string, cwd: string, extra: Record<string, unknown> = {}) =>
  ({ tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess-test", ...extra });

const ctx: ToolCtx = { tool: "bash", sid: "s", cwd: "/tmp", command: "true", path: "", denials: {} };

describe("the ordered check streams of one tool call", () => {
  it("[sma:k_h_pre] one guard process runs the advice streams in order, times each into perf.jsonl, and skips non-required streams past the budget", () => {
    const repo = mkdtempSync(join(tmpdir(), "sma-pre-"));
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    writeFileSync(join(repo, "REFLEXES.md"), "- WHEN git reset → check the airbag ref first\n");
    const home = mkdtempSync(join(tmpdir(), "sma-pre-home-"));
    const out = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(out.stdout.indexOf("git-airbag")).toBeLessThan(out.stdout.indexOf("[reflex]"));
    const perf = readFileSync(join(home, ".lane-pilot/session-hooks/sess-test/perf.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { stream: string });
    expect(perf.map((row) => row.stream)).toEqual(["deps", "git_airbag", "reflexes", "file_card", "spend"]);
    const limited = guard(bashPayload("git reset --hard", repo), { LANE_PILOT_ROLE: "writer", HOME: home, LANE_STREAM_BUDGET_SEC: "0" });
    expect(limited.code).toBe(0);
    const rows = readFileSync(join(home, ".lane-pilot/session-hooks/sess-test/perf.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { stream: string; error?: string });
    const lastRun = rows.slice(-5);
    expect(lastRun.filter((row) => row.error === "skipped: soft budget spent").map((row) => row.stream)).toEqual(["git_airbag", "reflexes", "file_card", "spend"]);
    expect(lastRun[0]).toMatchObject({ stream: "deps" });
    expect(lastRun[0]!.error).toBeUndefined();
  });

  it("[sma:k_hp_merge] a deny from a stream without deny rights is downgraded to a warning and never counted", () => {
    const result = runStreams(ctx, () => 0, { reflexes: () => ({ deny: "stop it", advice: null }) });
    expect(result.deny).toBeNull();
    expect(result.advice).toEqual(["[downgraded] stop it"]);
    expect(result.denials.reflexes).toBeUndefined();
    const hard = runStreams(ctx, () => 0, { hard_rules: () => ({ deny: "real deny", advice: null }) });
    expect(hard.deny).toBe("real deny");
    expect(hard.denials.hard_rules).toBe(1);
  });
});

describe("reflexes reach the task folder", () => {
  it("[sma:k_hs_reflex] [sma:k_lib_reflex] adopted WHEN -> act rules reach REFLEXES.md, plain rules do not, and the guard fires the matching act", async () => {
    const rules = ["WHEN prisma migrate -> run it on a copy first", "always write tests first"];
    expect(reflexLinesOf(rules)).toEqual(["- WHEN prisma migrate -> run it on a copy first"]);
    const written: Record<string, string> = {};
    await persistTaskFolder({ taskId: "t-1", reflexes: reflexLinesOf(rules), writeFile: async (rel, content) => { written[rel] = content; } });
    expect(Object.keys(written).some((rel) => rel.endsWith("REFLEXES.md"))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "sma-reflex-prod-"));
    mkdirSync(join(dir, ".agents/plans/items/t-1"), { recursive: true });
    writeFileSync(join(dir, ".agents/plans/items/t-1/REFLEXES.md"), Object.values(written)[0]!);
    const home = mkdtempSync(join(tmpdir(), "sma-reflex-prod-home-"));
    const out = guard(bashPayload("npx prisma migrate dev", dir), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(out.stdout).toContain("run it on a copy first");
  });
});

describe("stall detection and the one-nudge rule", () => {
  it("[sma:k_hst_detect] ping-pong between two calls and a read-only run give advice and do not block", () => {
    let state = stallStateOf({});
    const feed = (tool: string, input: unknown, response: unknown) => {
      const out = stallObserve(state, tool, input, response);
      state = out.state;
      return out.hint;
    };
    let hint = "";
    for (let i = 0; i < 3; i++) {
      hint = feed("bash", { command: "aa" }, `result A at 1${i}:00`) || hint;
      hint = feed("bash", { command: "bb" }, `result B at 1${i}:00`) || hint;
    }
    expect(hint).toContain("alternating between two calls");
    state = stallStateOf({});
    let mono = "";
    for (let i = 0; i < 8; i++) mono = feed("read", { file_path: `/f${i}.ts` }, `content-${i}`) || mono;
    expect(mono).toContain("read-only calls in a row");
    // A Bash between reads resets the run.
    state = stallStateOf({});
    for (let i = 0; i < 4; i++) feed("read", { file_path: `/r${i}` }, `x${i}`);
    feed("bash", { command: "make" }, "ok");
    mono = "";
    for (let i = 4; i < 8; i++) mono = feed("read", { file_path: `/r${i}` }, `x${i}`) || mono;
    expect(mono).toBe("");
  });

  it("[sma:k_hst_nudge] one nudge per pattern per session; a second pattern still gets its own", () => {
    let state = stallStateOf({});
    const hints: string[] = [];
    for (let i = 0; i < 5; i++) {
      const out = stallObserve(state, "read", { file_path: "/same" }, "identical");
      state = out.state;
      hints.push(out.hint);
    }
    expect(hints[2]).toContain("already been returned 3 times");
    expect(hints[3]).toBe("");
    expect(hints[4]).toBe("");
    // A Bash in between ends the read-only run, so the second pattern's third hit gets its own nudge.
    state = stallObserve(state, "bash", { command: "make" }, "ok").state;
    state = stallObserve(state, "read", { file_path: "/other" }, "different-result").state;
    state = stallObserve(state, "read", { file_path: "/other" }, "different-result").state;
    const third = stallObserve(state, "read", { file_path: "/other" }, "different-result").hint;
    expect(third).toContain("already been returned 3 times");
  });
});

describe("the session's own record", () => {
  it("[sma:k_hse_farewell] a SessionEnd with no files in its payload still names the files PostToolUse journaled, and registers as a native hook event", async () => {
    const home = mkdtempSync(join(tmpdir(), "sma-farewell-"));
    for (const file of ["/w/a.ts", "/w/b.ts"]) {
      const out = hook({ hook_event_name: "PostToolUse", session_id: "s-end", tool_name: "Edit", tool_input: { file_path: file }, tool_response: "ok" }, home);
      expect(out.status).toBe(0);
    }
    hook({ hook_event_name: "SubagentStop", session_id: "s-end", claimed: ["/w/missing.ts"], changed: [] }, home);
    const end = hook({ hook_event_name: "SessionEnd", session_id: "s-end" }, home);
    expect(end.status).toBe(0);
    const farewell = readFileSync(join(home, ".lane-pilot/session-hooks/s-end/farewell.md"), "utf8");
    expect(farewell).toContain("/w/a.ts");
    expect(farewell).toContain("/w/b.ts");
    expect(farewell).toContain("Subagents: 1");
    expect(farewell).toContain("/w/missing.ts");
    const dest = join(mkdtempSync(join(tmpdir(), "sma-farewell-hooks-")), "launch");
    const result = await materializeNativeHookSession({ destDir: dest });
    const settings = JSON.parse(await readFile(result.settingsPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(settings.hooks.SessionEnd?.[0]?.hooks[0]?.command).toContain("session-hook.mjs");
  });

  it("[sma:k_wd_c2] the farewell draft merges the subagent receipts with their unverified paths", () => {
    const draft = sessionEndDraft({ files: ["a.ts"], at: "t", subagents: { count: 2, missing: ["/x.ts"] } });
    expect(draft).toContain("Subagents: 2");
    expect(draft).toContain("/x.ts");
    expect(sessionEndDraft({ files: [], at: "t" })).not.toContain("Subagents");
  });

  it("[sma:k_wp_drift] a stale code map is named at session start; a fresh one adds nothing", () => {
    expect(codeMapDrift("aaa", "bbb", 3)).toBe(3);
    expect(codeMapDrift("aaa", "aaa", 0)).toBe(0);
    const text = sessionStartText({ codeMapBehind: 3 });
    expect(text).toContain("Code map is 3 commits behind HEAD");
    expect(sessionStartText({ codeMapBehind: 0 })).toBeNull();
    const repo = mkdtempSync(join(tmpdir(), "sma-drift-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "one", "--allow-empty"], { cwd: repo, env });
    const first = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    spawnSync("git", ["commit", "-qm", "two", "--allow-empty"], { cwd: repo, env });
    mkdirSync(join(repo, ".gitnexus"));
    writeFileSync(join(repo, ".gitnexus/meta.json"), JSON.stringify({ lastCommit: first }));
    const home = mkdtempSync(join(tmpdir(), "sma-drift-home-"));
    const out = hook({ hook_event_name: "SessionStart", session_id: "s-drift", cwd: repo }, home);
    expect(out.stdout).toContain("Code map is 1 commits behind HEAD");
  });
});

describe("knowledge at the act and the spend marks", () => {
  it("[sma:k_hs_context] an Edit of a file with a stored card returns it at most twice; an uncatalogued file gets nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-card-"));
    writeFileSync(join(dir, "FILECARDS.md"), "- src/a.ts -> this file is generated; edit the template\n");
    const home = mkdtempSync(join(tmpdir(), "sma-card-home-"));
    const edit = () => guard({ tool_name: "Edit", tool_input: { file_path: "src/a.ts" }, cwd: dir, session_id: "sess-test" }, { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(edit().stdout).toContain("[file-card] this file is generated");
    expect(edit().stdout).toContain("[file-card]");
    expect(edit().stdout).not.toContain("[file-card]");
    const other = guard({ tool_name: "Edit", tool_input: { file_path: "src/b.ts" }, cwd: dir, session_id: "sess-test" }, { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(other.stdout).not.toContain("[file-card]");
    // The task folder carries the cards from the confirmed memory notes of the task's paths.
    const written: Record<string, string> = {};
    await persistTaskFolder({ taskId: "t-2", filecards: ["src/a.ts -> generated"], writeFile: async (rel, content) => { written[rel] = content; } });
    expect(Object.keys(written).some((rel) => rel.endsWith("FILECARDS.md"))).toBe(true);
    void taskFileCards;
  });

  it("[sma:k_hs_spend] a window at 72 warns once, at 92 warns once more, never the same twice; a Task is denied only past a human-set cap", () => {
    const home = mkdtempSync(join(tmpdir(), "sma-spend-home-"));
    mkdirSync(join(home, ".lane-pilot"), { recursive: true });
    const snap = (pct: number, byHuman: boolean) => writeFileSync(join(home, ".lane-pilot/usage-snapshot.json"), JSON.stringify({
      at: new Date().toISOString(), windows: [{ label: "five-hour", usedPercent: pct, resetsAt: "2026-11-12T00:00:00Z" }], skipPercent: 90, skipSetByHuman: byHuman,
    }));
    snap(72, false);
    const once = guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home });
    expect(once.stdout).toContain("[spend] five-hour is at 72%");
    expect(guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home }).stdout).not.toContain("[spend]");
    snap(92, false);
    expect(guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home }).stdout).toContain("at 92%");
    expect(guard(bashPayload("npm test", home), { LANE_PILOT_ROLE: "writer", HOME: home }).stdout).not.toContain("[spend]");
    // The Task cap is the person's: unset (skipSetByHuman false) allows; set and past it denies with the reset time.
    const allow = hook({ hook_event_name: "PreToolUse", session_id: "s-cap", tool_name: "Task", tool_input: { subagent_type: "Explore", prompt: "look" } }, home);
    expect(allow.stdout).not.toContain("spend-cap");
    snap(95, true);
    const denied = hook({ hook_event_name: "PreToolUse", session_id: "s-cap", tool_name: "Task", tool_input: { subagent_type: "Explore", prompt: "look" } }, home);
    expect(denied.stdout).toContain("spend-cap");
    expect(denied.stdout).toContain("2026-11-12T00:00:00Z");
    expect(pretaskDecision({ role: "", kind: "Explore", background: false, spawned: 0, usage: { skipSetByHuman: true, skipPercent: 90, percent: 95, atMs: Date.now() - 20 * 60_000 } }).deny).toBeUndefined();
  });
});

describe("the live window facts", () => {
  it("[sma:k_h_statusline] a stored rateLimits event with a blocked window and a future reset holds until the reset and fills the board fallback", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => void store.set(key, value) };
    await kv.set(`${RATE_LIMIT_PREFIX}claude-code`, { at: Date.now(), status: "blocked", windows: [{ label: "five-hour", status: "blocked", resetsAtMs: Date.now() + 3_600_000 }] });
    const snap = await readRateLimitSnapshot(kv, "claude-code");
    expect(snap?.windows[0]?.status).toBe("blocked");
    expect(windowHold(snap, Date.now())).toContain("five-hour");
    expect(windowHold(snap, Date.now() + 4_000_000)).toBeNull();
    expect(windowHold(null, Date.now())).toBeNull();
    const board = snapshotAsBoardWindows(snap);
    expect(board.windows["five-hour"]?.utilization).toBe(100);
    expect(snapshotAsBoardWindows(null).at).toBeNull();
  });
});
