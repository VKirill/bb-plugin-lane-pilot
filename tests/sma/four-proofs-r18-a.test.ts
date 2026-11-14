// Region 18 (Claude Code session hooks), batch a: the four proofs for nodes n1402 … n1431. The hooks are run as the programs they are:
// the real session hook (src/rooms/session-hooks/cli.ts) takes a real hook input on stdin and answers with an exit code, stdout and files.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripClaudeLaneSettings } from "../../src/rooms/native-install/claude-lane-leftovers";
import { usageSegment } from "../../src/rooms/usage/statusline-segment";
import { pmRulesPromptBlock } from "../../src/rooms/learning/pm-rules";
import { ruleTokens } from "../../src/rooms/learning";
import { upsertLessonProposal } from "../../packages/run-insights/src";
import { adoptRuleProposal } from "../../src/rooms/self-repair/server/insights";
import { database } from "../learning/helpers";

const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** The real hook program on one hook input. */
function hook(payload: Record<string, unknown> | string, home: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home, ...env },
  });
}

/** A stand-in `bb`: a verb whose words match prints its answer and exits 0; anything else exits 1. */
function stubBb(home: string, answers: Record<string, string>): string {
  const file = join(home, "bb-stub.sh");
  const cases = Object.entries(answers).map(([match, out]) => `case "$*" in *"${match}"*) printf '%b' '${out.replace(/'/g, "'\\''")}'; exit 0 ;; esac`).join("\n");
  writeFileSync(file, `#!/bin/sh\n${cases}\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}

const context = (stdout: string): string => (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;

describe("[region 18 batch a] the session hooks as programs", () => {
  it("[sma:k_h_failopen] a payload that is not JSON, an empty one and a hook body that throws all end with exit zero and nothing on stdout", () => {
    const home = tmp("r18-failopen-");
    for (const input of ["not-json", "", "{\"hook_event_name\":", "[1,2", "null"]) {
      const ran = hook(input, home);
      expect(ran.status, `input «${input}»`).toBe(0);
      expect(ran.stdout, `input «${input}»`).toBe("");
    }
    // A cwd that is not a folder and a transcript that is not there: the event still answers and exits zero.
    const odd = hook({ hook_event_name: "PreCompact", session_id: "fo1", cwd: "/no/such/folder", transcript_path: "/no/such/transcript.jsonl", asks: ["keep this"] }, home);
    expect(odd.status).toBe(0);
    expect((JSON.parse(readFileSync(join(home, ".lane-pilot/session-hooks/fo1/capsule.json"), "utf8")) as { asks: string[] }).asks).toEqual(["keep this"]);
  });

  it("[sma:k_hse_farewell] a SessionEnd draft names the first touched file, the session's own files in order", () => {
    const home = tmp("r18-farewell-");
    const ran = hook({ hook_event_name: "SessionEnd", session_id: "fw1", cwd: home, files: ["a/first.ts", "b/second.ts"] }, home);
    expect(ran.status).toBe(0);
    const draft = readFileSync(join(home, ".lane-pilot/session-hooks/fw1/farewell.md"), "utf8");
    expect(draft).toContain("This session changed: a/first.ts, b/second.ts.\n");
    expect(draft).toContain("What should the next window know?");
  });

  it("[sma:k_hsl_render] the segment is the windows of the cache and nothing else: 5h, 7d, opus, 1d in that order, joined by « - », marked when the reading is older than two hours", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const windows = { five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 18, resetsAt: null }, seven_day_opus: { utilization: 5, resetsAt: null }, one_day: { utilization: 2.6, resetsAt: null } };
    expect(usageSegment(windows, "2026-11-11T11:30:00Z", now)).toBe("5h 42% - 7d 18% - opus 5% - 1d 3%");
    expect(usageSegment({ seven_day: { utilization: 18, resetsAt: null } }, "2026-11-11T11:30:00Z", now)).toBe("7d 18%");
    expect(usageSegment(windows, "2026-11-11T09:00:00Z", now)).toBe("⚠ 5h 42% - 7d 18% - opus 5% - 1d 3%");
    expect(usageSegment({ monthly: { utilization: 61, resetsAt: null } }, null, now)).toBe("monthly 61%");
    expect(usageSegment({}, null, now)).toBe("");
    expect(usageSegment(null, null, now)).toBe("");
  });

  it("[sma:k_hsl_wrap] the cleaner takes only the old lane-statusline off and puts the person's saved line back exactly; a line of the person's own stays as it is", () => {
    const home = "/home/person";
    const mine = { type: "command", command: "node /opt/my-line.js --fancy", padding: 2 };
    const wrapped = JSON.stringify({ model: "opus", statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` } }, null, 2);
    const restored = stripClaudeLaneSettings(wrapped, home, { saved: mine });
    expect(JSON.parse(restored.text)).toEqual({ model: "opus", statusLine: mine });
    expect(restored.removed).toEqual([`${home}/.agents/bin/lane-statusline`]);
    expect(restored.written).toHaveLength(1);
    // The person's own line (no lane-statusline in it) is not touched: the text comes back byte for byte.
    const own = JSON.stringify({ statusLine: mine }, null, 2);
    const untouched = stripClaudeLaneSettings(own, home, { saved: { type: "command", command: "other" } });
    expect(untouched.text).toBe(own);
    expect(untouched.removed).toEqual([]);
    // A record that is the wrapper itself is no person's line: the key goes and nothing is written.
    const noRecord = stripClaudeLaneSettings(wrapped, home, { saved: { type: "command", command: `${home}/.agents/bin/lane-statusline` } });
    expect(JSON.parse(noRecord.text).statusLine).toBeUndefined();
    expect(noRecord.written).toEqual([]);
  });

  it("[sma:k_hss_preact] the PM's starting prompt carries the project's accepted rules before its first act: the section of the run counts, a rule beyond the budget is counted as hidden", () => {
    const db = database();
    const adopt = (rule: string, scope?: string[]) => {
      const made = upsertLessonProposal(db, "proj_1", { rule, evidence: "e", audience: "pm", always: false }, Date.now() - 40 * 86_400_000);
      const row = adoptRuleProposal(db, "proj_1", made.id, Date.now() - 10 * 86_400_000);
      if (scope) db.prepare("UPDATE lane_pilot_rule_proposal SET scope_json=? WHERE id=?").run(JSON.stringify(scope), made.id);
      return row;
    };
    adopt("Run the vitest gate before every merge into main.");
    adopt("Quote the clients section's contract wording when you plan.", ["section:clients"]);
    const clients = pmRulesPromptBlock(db, "proj_1", ["section:clients"], 1600);
    expect(clients).toContain("Rules the owner taught in this project");
    expect(clients).toContain("- Run the vitest gate before every merge into main.");
    expect(clients).toContain("- Quote the clients section's contract wording when you plan.");
    const plain = pmRulesPromptBlock(db, "proj_1", [], 1600);
    expect(plain).toContain("- Run the vitest gate before every merge into main.");
    expect(plain).not.toContain("clients section");
    const head = "Rules the owner taught in this project (they came from his corrections; follow them in planning, task contracts, reviews, merges, deploys and in what you ask him):";
    const tight = pmRulesPromptBlock(db, "proj_1", ["section:clients"], ruleTokens(head) + ruleTokens("Run the vitest gate before every merge into main.") + 1);
    expect(tight.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
    expect(tight).toContain("(1 more rule did not fit here");
  });

  it("[sma:k_hss_memline] [sma:k_hss_out] a session start names the MEMORY.md budget as the only line, and asks to merge near the limit; a project without MEMORY.md says nothing", () => {
    const home = tmp("r18-memline-");
    const bb = stubBb(home, {});
    const project = (lines: number) => {
      const cwd = tmp("r18-memproj-");
      writeFileSync(join(cwd, "MEMORY.md"), `${Array.from({ length: lines - 1 }, (_, i) => `line ${i}`).join("\n")}\n`);
      return cwd;
    };
    const quiet = hook({ hook_event_name: "SessionStart", session_id: "m0", cwd: tmp("r18-nomem-") }, home, { BB_CLI: bb });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
    const mid = hook({ hook_event_name: "SessionStart", session_id: "m1", cwd: project(100) }, home, { BB_CLI: bb });
    expect(context(mid.stdout)).toBe("MEMORY.md: 100/200 lines");
    const full = hook({ hook_event_name: "SessionStart", session_id: "m2", cwd: project(180) }, home, { BB_CLI: bb });
    expect(context(full.stdout)).toBe("MEMORY.md: 180/200 lines — near the limit: merge or trim entries");
    expect((JSON.parse(full.stdout) as { hookSpecificOutput: { hookEventName: string } }).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("[sma:k_hss_restore] after a compaction the capsule is the first thing in the context; a plain start puts the coordination briefing first", () => {
    const home = tmp("r18-restore-");
    const bb = stubBb(home, { "session-brief": '{"summary":"Work in this project: 2 live, 1 stale.","foreign":[],"weak":[]}' });
    expect(hook({ hook_event_name: "PreCompact", session_id: "rs1", cwd: home, asks: ["keep the contract"], files: ["src/a.ts"] }, home).status).toBe(0);
    const compact = context(hook({ hook_event_name: "SessionStart", source: "compact", session_id: "rs1", cwd: home }, home, { BB_CLI: bb }).stdout);
    expect(compact.startsWith("Capsule restored after compaction:")).toBe(true);
    expect(compact).toContain("keep the contract");
    expect(compact.indexOf("Work in this project")).toBeGreaterThan(compact.indexOf("Capsule restored"));
    const startup = context(hook({ hook_event_name: "SessionStart", source: "startup", session_id: "rs1", cwd: home }, home, { BB_CLI: bb }).stdout);
    expect(startup.startsWith("Work in this project: 2 live, 1 stale.")).toBe(true);
    expect(startup).toContain("Capsule restored after compaction:");
    expect(startup.indexOf("Work in this project")).toBeLessThan(startup.indexOf("Capsule restored"));
  });

  it("[sma:k_h_session_start] a start names the model change, the protections that are off and the briefing, in this order and nothing else; a repeated model says nothing", () => {
    const home = tmp("r18-start-");
    const bb = stubBb(home, { "session-brief": '{"summary":"Work in this project: 1 live, 0 stale.","foreign":[],"weak":[]}' });
    const start = (model: string, env: Record<string, string> = {}) => hook({ hook_event_name: "SessionStart", session_id: "ss1", cwd: home, model }, home, { BB_CLI: bb, ...env });
    expect(context(start("claude-a").stdout)).toBe("Work in this project: 1 live, 0 stale.");
    expect(context(start("claude-a").stdout)).toBe("Work in this project: 1 live, 0 stale.");
    expect(context(start("claude-b", { LANE_COORD: "0" }).stdout)).toBe([
      "Work in this project: 1 live, 0 stale.",
      "Model change: this session ran on claude-a, now on claude-b; earlier receipts of this window were made by the other model.",
      "Protections switched off: LANE_COORD",
    ].join("\n\n"));
  });

  it("[sma:k_h_prompt_recall] a prompt of three words or more yields pointers, at most three, each on its own line; the fourth note is left out", () => {
    const home = tmp("r18-recall-");
    const bb = stubBb(home, { "memory search": "- [a1] alpha claim\n- [a2] beta claim\n- [a3] gamma claim\n- [a4] delta claim\n" });
    const ran = hook({ hook_event_name: "UserPromptSubmit", session_id: "rc1", prompt: "how does the gate work", cwd: home }, home, { BB_CLI: bb });
    const lines = context(ran.stdout).split("\n").filter((line) => line.startsWith("- ["));
    expect(lines).toEqual(["- [a1] alpha claim", "- [a2] beta claim", "- [a3] gamma claim"]);
    const short = hook({ hook_event_name: "UserPromptSubmit", session_id: "rc2", prompt: "two words", cwd: home }, home, { BB_CLI: bb });
    expect(short.stdout).toBe("");
  });

  it("[sma:k_h_precompact] a PreCompact input writes the flight capsule before the trim: asks, files and claims each in its own field, and a progress line", () => {
    const home = tmp("r18-precompact-");
    const ran = hook({ hook_event_name: "PreCompact", session_id: "pc1", cwd: home, asks: ["keep the contract"], files: ["src/touched.ts"], claims: ["src/claimed.ts"] }, home);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("");
    const dir = join(home, ".lane-pilot/session-hooks/pc1");
    const capsule = JSON.parse(readFileSync(join(dir, "capsule.json"), "utf8")) as Record<string, unknown>;
    expect(capsule.asks).toEqual(["keep the contract"]);
    expect(capsule.files).toEqual(["src/touched.ts"]);
    expect(capsule.claims).toEqual(["src/claimed.ts"]);
    expect(capsule.trigger).toBe("precompact");
    expect(existsSync(join(dir, "progress.jsonl"))).toBe(true);
    const progress = JSON.parse(readFileSync(join(dir, "progress.jsonl"), "utf8").trim()) as { session: string; files: number; asks: number; touched: string[] };
    expect(progress).toMatchObject({ session: "pc1", files: 1, asks: 1, touched: ["src/touched.ts"] });
  });
});

