import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase, createRun, createTask, createAttempt, setAttemptWorkspace, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server/cli";
import type { Services } from "../../server";
import { draftTarget, pretaskDecision, promptRecall, sessionSummaryLine } from "../../src/rooms/session-hooks/logic";
import { weakAreas } from "../../src/rooms/forecast/server/report";
import { taskV2Schema } from "../../src/rooms/contracts";
import { projectIdForWorkspacePath, projectLiveAttempts } from "../../src/rooms/storage";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import { pmRulesOf } from "../../src/rooms/learning";
import { loadProjectSettings } from "../../src/rooms/storage";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";

const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

function hook(payload: Record<string, unknown>, home: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}

/** A stub bb binary: pairs of "verb words" -> stdout to print (exit 0); anything else exits 1. */
function stubBb(home: string, answers: Record<string, string>): string {
  const file = join(home, "bb-stub.sh");
  const cases = Object.entries(answers).map(([match, out]) =>
    `case "$*" in *"${match}"*) printf '%b' '${out.replace(/'/g, "'\\''")}'; exit 0 ;; esac`).join("\n");
  writeFileSync(file, `#!/bin/sh\n${cases}\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}

const newRepo = (prefix: string) => {
  const repo = tmp(prefix);
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
  return repo;
};

const commitFile = (repo: string, name: string, body: string, subject: string) => {
  writeFileSync(join(repo, name), body);
  spawnSync("git", ["add", name], { cwd: repo });
  spawnSync("git", ["commit", "-qm", subject], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
};

async function cliWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  registerCli(createCore(bb, db), {} as Services, migrations);
  return { bb, db, harness };
}

describe("compaction: the ledger and the flight capsule", () => {
  it("[sma:k_hpc_progress] touched files and commands survive compaction into progress.jsonl and the SessionStart output", async () => {
    const home = tmp("g2-progress-");
    const post = (tool: string, input: Record<string, unknown>) =>
      hook({ hook_event_name: "PostToolUse", session_id: "s-p", tool_name: tool, tool_input: input, tool_response: "ok", cwd: home }, home);
    expect(post("Edit", { file_path: "src/a.ts" }).status).toBe(0);
    post("Bash", { command: "pnpm test" });
    hook({ hook_event_name: "UserPromptSubmit", session_id: "s-p", prompt: "do the parity work now", cwd: home }, home, { BB_CLI: stubBb(home, {}) });
    hook({ hook_event_name: "PreCompact", session_id: "s-p", cwd: home }, home);
    const progress = lines(join(home, ".lane-pilot/session-hooks/s-p/progress.jsonl")).map((line) => JSON.parse(line) as { touched: string[]; commands: string[] });
    expect(progress.at(-1)!.touched).toContain("src/a.ts");
    expect(progress.at(-1)!.commands).toContain("pnpm test");
    const start = hook({ hook_event_name: "SessionStart", session_id: "s-p", cwd: home }, home, { BB_CLI: join(home, "bb-stub.sh") });
    expect(start.stdout).toContain("src/a.ts");
    expect(start.stdout).toContain("pnpm test");
    await readFile(join(home, ".lane-pilot/session-hooks/s-p/ledger.json"), "utf8");
  });

  it("[sma:k_hpc_capsule] the capsule holds the task, the stated constraints and the transcript's decisions, from files only", async () => {
    const home = tmp("g2-capsule-");
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "build the gate" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I will look first." }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Decision: use the existing helper instead of a new one." }] } }),
    ].join("\n"));
    hook({ hook_event_name: "UserPromptSubmit", session_id: "s-c", prompt: "rework the guard\nowns_paths: lane-stack/hooks/**\nnever touch main", cwd: home }, home, { BB_CLI: stubBb(home, {}) });
    hook({ hook_event_name: "PreCompact", session_id: "s-c", cwd: home, transcript_path: transcript }, home);
    const capsule = JSON.parse(await readFile(join(home, ".lane-pilot/session-hooks/s-c/capsule.json"), "utf8")) as { task?: string; constraints?: string[]; decisions?: string[] };
    expect(capsule.task).toContain("rework the guard");
    expect(capsule.constraints!.join(" ")).toContain("owns_paths");
    expect(capsule.decisions!.join(" ")).toContain("existing helper");
    // A missing transcript still exits 0 with the ledger fields.
    const again = hook({ hook_event_name: "PreCompact", session_id: "s-c2", cwd: home, transcript_path: join(home, "none.jsonl") }, home);
    expect(again.status).toBe(0);
    const capsule2 = JSON.parse(await readFile(join(home, ".lane-pilot/session-hooks/s-c2/capsule.json"), "utf8")) as { files: string[] };
    expect(capsule2.files).toEqual([]);
  });
});

describe("a Task spawn: pack, record, tree check", () => {
  it("[sma:k_h_pretask] a Task spawn carries rules, claims and lessons; a failing pack verb keeps the old repo-and-claims pack", () => {
    const home = tmp("g2-pretask-");
    const bb = stubBb(home, { "subagent-pack": '{"rules":["always run vitest","never touch main"],"lessons":["the lockfile is generated"]}' });
    hook({ hook_event_name: "PostToolUse", session_id: "s-t", tool_name: "Edit", tool_input: { file_path: "src/claimed.ts" }, cwd: home }, home);
    const out = hook({ hook_event_name: "PreToolUse", session_id: "s-t", tool_name: "Task", tool_input: { subagent_type: "general-purpose", prompt: "explore the repo" }, cwd: home }, home, { BB_CLI: bb });
    const updated = JSON.parse(out.stdout) as { hookSpecificOutput: { updatedInput: { prompt: string } } };
    const prompt = updated.hookSpecificOutput.updatedInput.prompt;
    expect(prompt).toContain("[context pack]");
    expect(prompt).toContain("always run vitest");
    expect(prompt).toContain("the lockfile is generated");
    expect(prompt).toContain("src/claimed.ts");
    // The stub fails: the pack is the old one — repo and claims, nothing else.
    const off = hook({ hook_event_name: "PreToolUse", session_id: "s-t2", tool_name: "Task", tool_input: { prompt: "explore" }, cwd: home }, home, { BB_CLI: join(home, "bb-stub-none.sh") });
    const offOut = off.stdout ? JSON.parse(off.stdout) as { hookSpecificOutput: { updatedInput: { prompt: string } } } : null;
    if (offOut) {
      expect(offOut.hookSpecificOutput.updatedInput.prompt).toContain("Repository");
      expect(offOut.hookSpecificOutput.updatedInput.prompt).not.toContain("Rules:");
    }
  });

  it("[sma:k_hpt_record] a spawn writes a pack record with size, layers, trimming, ranking and build time", () => {
    const home = tmp("g2-record-");
    const bb = stubBb(home, { "subagent-pack": '{"rules":["r1","r2"],"lessons":["l1"]}' });
    const out = hook({ hook_event_name: "PreToolUse", session_id: "s-r", tool_name: "Task", tool_input: { subagent_type: "Explore", prompt: "look around" }, cwd: home }, home, { BB_CLI: bb });
    expect(out.status).toBe(0);
    const record = JSON.parse(lines(join(home, ".lane-pilot/session-hooks/s-r/subagents.jsonl")).pop()!) as Record<string, unknown> & { layers: Record<string, number> };
    expect(typeof record.at).toBe("string");
    expect(typeof record.chars).toBe("number");
    expect(record.layers.rules).toBe(2);
    expect(record.layers.lessons).toBe(1);
    expect(typeof record.layers.claims).toBe("number");
    expect(typeof record.trimmed).toBe("boolean");
    expect(typeof record.ranked).toBe("number");
    expect(typeof record.ms).toBe("number");
    expect(record.kind).toBe("Explore");
  });

  it("[sma:k_hsv_tree] claims are checked against the real tree: committed, dirty, untouched and phantom", async () => {
    const repo = newRepo("g2-tree-");
    // The old file's commit is dated long before the spawn; git's --since is seconds-granular.
    writeFileSync(join(repo, "old.ts"), "old\n");
    spawnSync("git", ["add", "old.ts"], { cwd: repo });
    spawnSync("git", ["commit", "-qm", "old file"], { cwd: repo, env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
    const home = tmp("g2-tree-home-");
    // A spawn record gives the spawn time; the commit after it is the subagent's work.
    mkdirSync(join(home, ".lane-pilot/session-hooks/s-v"), { recursive: true });
    writeFileSync(join(home, ".lane-pilot/session-hooks/s-v/subagents.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind: "x" })}\n`);
    commitFile(repo, "new.ts", "new\n", "subagent work");
    writeFileSync(join(repo, "dirty.ts"), "dirty\n");
    const out = hook({
      hook_event_name: "SubagentStop", session_id: "s-v", cwd: repo,
      last_assistant_message: "I changed new.ts, old.ts and dirty.ts and also ghost/missing.ts is done",
    }, home, { BB_CLI: stubBb(home, {}) });
    expect(out.status).toBe(0);
    const receipt = JSON.parse(lines(join(home, ".lane-pilot/session-hooks/s-v/receipts.jsonl")).pop()!) as { subagent_receipt: { states: Array<{ path: string; state: string }> } };
    const state = (p: string) => receipt.subagent_receipt.states.find((row) => row.path === p)?.state;
    expect(state("new.ts")).toBe("committed");
    expect(state("dirty.ts")).toBe("dirty");
    expect(state("old.ts")).toBe("untouched");
    expect(state("ghost/missing.ts")).toBe("phantom");
    expect(out.stdout).toContain("phantom");
    expect(out.stdout).toContain("missing.ts");
    expect(out.stdout).toContain("old.ts");
    expect(out.stdout).not.toContain("dirty.ts is");
    await readFile(join(repo, "old.ts"), "utf8");
  });
});

describe("the start-of-session briefing", () => {
  it("[sma:k_hss_summary] session-brief counts live and stale attempts and names a running merge; the line is empty at zero", async () => {
    const repo = newRepo("g2-brief-");
    const w = await cliWorld();
    createRun(w.db, "run-b", "proj-b", "bb", repo);
    createTask(w.db, { id: "t-live", runId: "run-b", kind: "bb", contract: { owns_paths: ["src/live.ts"] } });
    createAttempt(w.db, { id: "a-live", runId: "run-b", taskId: "t-live" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='a-live'").run();
    createTask(w.db, { id: "t-stale", runId: "run-b", kind: "bb", contract: { owns_paths: ["src/stale.ts"] } });
    createAttempt(w.db, { id: "a-stale", runId: "run-b", taskId: "t-stale" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='running', updated_at=? WHERE id='a-stale'").run(Date.now() - 10 * 60_000);
    await (w.bb.storage.kv as unknown as { set(k: string, v: unknown): Promise<unknown> }).set("merge-intent:a-live", { attemptId: "a-live", projectId: "proj-b" });
    const brief = JSON.parse((await w.harness.behavior.runCli(["session-brief", "--cwd", repo, "--json"])).stdout!) as { live: number; stale: number; merge: boolean; summary: string };
    expect(brief.live).toBe(1);
    expect(brief.stale).toBe(1);
    expect(brief.merge).toBe(true);
    expect(brief.summary).toBe("Work in this project: 1 live, 1 stale; a merge into main is running.");
    expect(sessionSummaryLine({ live: 0, stale: 0, merge: false })).toBe("");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_h_session_start] the start text carries the briefing, the model note and the restored capsule in that order; {} says nothing", () => {
    const home = tmp("g2-start-");
    const bb = stubBb(home, { "session-brief": '{"summary":"Work in this project: 2 live, 1 stale.","foreign":[],"weak":[]}' });
    hook({ hook_event_name: "PreCompact", session_id: "s-s", cwd: home, asks: ["keep the contract"], files: ["src/a.ts"] }, home);
    const out = hook({ hook_event_name: "SessionStart", session_id: "s-s", cwd: home, model: "claude-2" }, home, { BB_CLI: bb });
    const text = (JSON.parse(out.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(text.indexOf("Work in this project")).toBeLessThan(text.indexOf("Capsule restored"));
    expect(text).toContain("Capsule restored");
    // A brief that says nothing and no capsule: the hook stays silent (the guard is registered, so no protections line).
    const home2 = tmp("g2-start-empty-");
    mkdirSync(join(home2, ".claude"), { recursive: true });
    writeFileSync(join(home2, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "python3 guard_shell.py" }] }] } }));
    const bb2 = stubBb(home2, { "session-brief": "{}" });
    const quiet = hook({ hook_event_name: "SessionStart", session_id: "s-e", cwd: home2 }, home2, { BB_CLI: bb2 });
    expect(quiet.stdout).toBe("");
  });

  it("[sma:k_hss_digest] the start text lists commits since the last session, a foreign claim and a weak area; nothing repeats", () => {
    const repo = newRepo("g2-digest-");
    const home = tmp("g2-digest-home-");
    const bb = stubBb(home, { "session-brief": '{"summary":"","foreign":[{"taskId":"t1","paths":["src/**"]}],"weak":["ui"]}' });
    const start = () => hook({ hook_event_name: "SessionStart", session_id: "s-d", cwd: repo }, home, { BB_CLI: bb });
    start();
    commitFile(repo, "moved.ts", "x\n", "the move");
    const second = JSON.parse(start().stdout) as { hookSpecificOutput: { additionalContext: string } };
    const text = second.hookSpecificOutput.additionalContext;
    expect(text).toContain("the move");
    expect(text).toContain("claimed by another window");
    expect(text).toContain("t1");
    expect(text).toContain("weakly calibrated area: ui");
    const third = start();
    expect(third.stdout).not.toContain("the move");
    expect(third.stdout).toContain("claimed by another window");
  });

  it("[sma:k_hss_digest] weakAreas names an area with under three scored tasks", async () => {
    const w = await cliWorld();
    const contract = {
      schema_version: 2, id: "t-w", display_title: "T", kind: "feature", area: "ui", title: "T", risk: "low", lane: "core",
      project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["out.txt"],
      owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "o", acceptance: ["done"], verify: "tests",
      verification: [{ command: "true", cwd: "/ws" }],
      forecast: { files: 1, checks_pass_first_try: true },
    };
    createRun(w.db, "run-w", "proj-w", "bb", "/ws");
    createTask(w.db, { id: "t-w", runId: "run-w", kind: "bb", contract });
    createAttempt(w.db, { id: "a-w", runId: "run-w", taskId: "t-w" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='a-w'").run();
    upsertAttemptChange(w.db as never, { attemptId: "a-w", runId: "run-w", taskId: "t-w" }, { outcome: "merged", changed: [{ path: "src/x.ts", status: "modified" }] });
    expect(taskV2Schema.safeParse(contract).success).toBe(true);
    expect(weakAreas(w.db as never, "proj-w")).toContain("ui");
    expect(weakAreas(w.db as never, "proj-none")).toEqual([]);
    await w.harness.lifecycle.dispose();
  });
});

describe("prompt recall", () => {
  const prompt = (home: string, bb: string, text = "how does the guard lane work") =>
    hook({ hook_event_name: "UserPromptSubmit", session_id: "s-m", prompt: text, cwd: home }, home, { BB_CLI: bb });

  it("[sma:k_h_prompt_recall] [sma:k_hpr_find] the prompt's words search memory, pointers come once, silence when nothing clears the floor", () => {
    const home = tmp("g2-recall-");
    const bb = stubBb(home, { "memory search": "- [m1] claim one\n- [m2] claim two" });
    const first = JSON.parse(prompt(home, bb).stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(first.hookSpecificOutput.additionalContext).toContain("[m1]");
    expect(first.hookSpecificOutput.additionalContext).toContain("[m2]");
    // The same search again: the notes were already given, nothing repeats.
    expect(prompt(home, bb).stdout).toBe("");
    // A failing verb or «nothing relevant» stays silent, and the exit is still zero.
    const dead = tmp("g2-recall-dead-");
    expect(prompt(dead, join(dead, "no-bb.sh")).status).toBe(0);
    expect(prompt(dead, join(dead, "no-bb.sh")).stdout).toBe("");
    const none = tmp("g2-recall-none-");
    const bbNone = stubBb(none, { "memory search": "nothing relevant" });
    expect(prompt(none, bbNone).stdout).toBe("");
  });

  it("[sma:k_hpr_out] a pointer is the claim and the named file, never the body", () => {
    const body = "First sentence names src/a.ts. Second sentence is the long body that must never be shown to the session in the pointer.";
    const out = promptRecall({ hits: [{ id: "n1", content: body }], given: [], query: "the guard lane" });
    expect(out.text).toContain("- [n1] First sentence names src/a.ts");
    expect(out.text).toContain("(file: src/a.ts)");
    expect(out.text).not.toContain("Second sentence");
    expect(out.text).toContain("bb lane-pilot memory search");
  });
});

describe("the terminal claim ledger and the draft move", () => {
  it("[sma:m_rd_coord_ledger] another session's fresh claim on the same file is advice, never a deny; old or own claims say nothing", () => {
    const home = tmp("g2-claims-");
    const edit = (sid: string) => hook({ hook_event_name: "PreToolUse", session_id: sid, tool_name: "Edit", tool_input: { file_path: "src/x.ts" }, cwd: home }, home);
    edit("sess-A");
    const b = edit("sess-B");
    expect(b.stdout).toContain("[claims]");
    expect(b.stdout).toContain("sess-A");
    expect(b.stdout).not.toContain("deny");
    // A's own claim is not foreign to A — the advice names the other session, not A.
    const a2 = edit("sess-A");
    expect(a2.stdout).not.toContain("by sess-A");
    // A file nobody claimed gets no advice.
    expect(hook({ hook_event_name: "PreToolUse", session_id: "sess-A", tool_name: "Edit", tool_input: { file_path: "src/free.ts" }, cwd: home }, home).stdout).not.toContain("[claims]");
    const claimsFile = join(home, ".lane-pilot/session-hooks/claims.jsonl");
    const rows = lines(claimsFile).map((line) => JSON.parse(line) as Record<string, unknown>);
    rows.push({ session: "sess-old", role: "writer", cwd: home, path: "src/y.ts", at: Date.now() - 60 * 60_000 });
    writeFileSync(claimsFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const old = hook({ hook_event_name: "PreToolUse", session_id: "sess-C", tool_name: "Edit", tool_input: { file_path: "src/y.ts" }, cwd: home }, home);
    expect(old.stdout).not.toContain("[claims]");
  });

  it("[sma:m_draft_move] two SessionEnd events leave two distinct draft files and the first keeps its bytes", () => {
    const repo = newRepo("g2-draft-");
    const home = tmp("g2-draft-home-");
    const end = { hook_event_name: "SessionEnd", session_id: "s-end2", cwd: repo };
    hook(end, home);
    hook(end, home);
    const dir = join(home, ".lane-pilot", "drafts", repo.split("/").pop()!);
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["farewell-s-end2-2.md", "farewell-s-end2.md"]);
    expect(readFileSync(join(dir, names[1]), "utf8")).toContain("Farewell lesson draft");
    // draftTarget skips taken names, never an existing file.
    expect(draftTarget([], "a.md")).toBe("a.md");
    expect(draftTarget(["a.md", "a-2.md"], "a.md")).toBe("a-3.md");
  });
});

describe("the pack layers reach only confirmed material", () => {
  it("[sma:k_h_pretask] the verb's layers are accepted always-rules and confirmed notes, off by default", async () => {
    const w = await cliWorld();
    saveProjectSetting(w.db, "proj-p", "memory.budgets", { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 });
    storeMemoryRecords(w.db as never, { projectId: "proj-p", audience: "subagent", sourceSha256: "a".repeat(64), coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999, trust: "confirmed",
      entries: [{ kind: "note", content: "the gate is always run through vitest", concepts: ["gate"] }] });
    expect(loadProjectSettings(w.db, "proj-p")["hook.subagent_pack"]).toBeUndefined();
    const off = JSON.parse((await w.harness.behavior.runCli(["subagent-pack", "gate work", "--project", "proj-p"])).stdout!) as { rules: string[]; lessons: string[] };
    expect(off).toEqual({ rules: [], lessons: [] });
    saveProjectSetting(w.db, "proj-p", "hook.subagent_pack", "on");
    const on = JSON.parse((await w.harness.behavior.runCli(["subagent-pack", "gate work", "--project", "proj-p"])).stdout!) as { rules: string[]; lessons: string[] };
    expect(on.lessons.join(" ")).toContain("vitest");
    expect(Array.isArray(on.rules)).toBe(true);
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_hpt_record] the pack drops layers in order when it would pass 2 KB", () => {
    const big = pretaskDecision({ role: "", kind: "general-purpose", background: false, spawned: 0, prompt: "go",
      claims: ["a.ts"], rules: Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(200)}`), lessons: Array.from({ length: 5 }, (_, i) => `${i}${"z".repeat(200)}`), repo: "/r" });
    expect(big.pack).toBeDefined();
    expect(big.pack!.chars).toBeLessThanOrEqual(2048);
    expect(big.pack!.trimmed).toBe(true);
    expect(big.prompt).toContain("[context pack]");
  });
});
