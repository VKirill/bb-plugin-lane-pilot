import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase, createRun, createTask, createAttempt, setAttemptWorkspace, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server/cli";
import type { Services } from "../../server";
import { draftTarget, pretaskDecision, promptRecall, sessionSummaryLine } from "../../src/rooms/session-hooks/logic";
import { weakAreas } from "../../src/rooms/forecast/server/report";
import { taskV2Schema } from "../../src/rooms/contracts";
import { projectIdForWorkspacePath, projectLiveAttempts } from "../../src/rooms/storage";
import { listMemoryMisses, storeMemoryRecords } from "@lane-pilot/memory-core";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { adoptRuleProposal } from "../../src/rooms/self-repair/server/insights";
import { setRunSettingsScopes } from "../../src/rooms/storage";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";

// The recall and the pack must not reach the embedding API or the reranking model: the real modules are replaced by counters.
const calls = vi.hoisted(() => ({ embed: 0, rerank: 0 }));
vi.mock("../../src/rooms/memory/server/embeddings", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/rooms/memory/server/embeddings")>()), embedQuery: async () => { calls.embed += 1; } }));
vi.mock("../../src/rooms/memory/server/rerank", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../src/rooms/memory/server/rerank")>()), rerankRecords: async (records: unknown[]) => { calls.rerank += 1; return records; } }));

const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");
const GUARD = join(__dirname, "../../lane-stack/hooks/guard_shell.py");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);

function hook(payload: Record<string, unknown>, home: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}

const guard = (payload: Record<string, unknown>, env: Record<string, string>) =>
  spawnSync("python3", [GUARD], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: "writer", ...env } });

/** The hook as a child that does not block the test, for the calls that run side by side. */
const hookAsync = (payload: Record<string, unknown>, home: string) => new Promise<number | null>((done) => {
  const child = spawn(process.execPath, ["--experimental-strip-types", HOOK], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "ignore"] });
  child.on("close", done);
  child.stdin.end(JSON.stringify(payload));
});

/** A stub bb that writes each argument on its own line to bb-args.log, then answers like stubBb. */
function recordingBb(home: string, out: string): string {
  const file = join(home, "bb-record.sh");
  writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${join(home, "bb-args.log")}"; done\nprintf '%b' '${out.replace(/'/g, "'\\''")}'\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const BUDGET = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };

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

/** The real CLI on a scratch database; `threads` says who a calling thread id is (its project). */
async function cliWorld(threads: Record<string, string> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threads[threadId] ? { id: threadId, projectId: threads[threadId] } : null);
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

describe("the ledger of a session", () => {
  const prompt = (home: string, session: string, text: string) => hook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: text, cwd: home }, home, { BB_CLI: stubBb(home, {}) });
  const stateFile = (home: string, session: string, name: string) => join(home, ".lane-pilot/session-hooks", session, name);

  it("[sma:k_hpc_capsule] after seven prompts the capsule's task is the FIRST prompt, though the ledger keeps the last five", async () => {
    const home = tmp("g2-first-");
    for (let n = 1; n <= 7; n++) prompt(home, "s-7", `prompt number ${n} about the guard`);
    hook({ hook_event_name: "PreCompact", session_id: "s-7", cwd: home }, home);
    const capsule = JSON.parse(await readFile(stateFile(home, "s-7", "capsule.json"), "utf8")) as { task?: string; asks: string[] };
    expect(capsule.task).toBe("prompt number 1 about the guard");
    expect(capsule.asks).toHaveLength(5);
    expect(capsule.asks.at(-1)).toBe("prompt number 7 about the guard");
    // The first prompt is written once: an eighth prompt does not replace it.
    prompt(home, "s-7", "prompt number 8 about the guard");
    expect((JSON.parse(await readFile(stateFile(home, "s-7", "ledger.json"), "utf8")) as { first: string }).first).toBe("prompt number 1 about the guard");
  });

  it("[sma:k_hpc_progress] a secret in a prompt or a command is masked where it enters the ledger, and the session's files are 0600", async () => {
    const home = tmp("g2-secret-");
    const token = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");
    const bearer = "abcdefghijklmnopqrstuvwxyz0123";
    prompt(home, "s-x", `deploy with API_KEY=hunter2hunter2 and ${token} please`);
    hook({ hook_event_name: "PostToolUse", session_id: "s-x", tool_name: "Bash", tool_input: { command: `curl -H "Authorization: Bearer ${bearer}" ${token}` }, tool_response: "ok", cwd: home }, home);
    hook({ hook_event_name: "PreCompact", session_id: "s-x", cwd: home }, home);
    const start = hook({ hook_event_name: "SessionStart", session_id: "s-x", cwd: home }, home, { BB_CLI: stubBb(home, {}) });
    for (const name of ["ledger.json", "capsule.json", "progress.jsonl"]) {
      const text = await readFile(stateFile(home, "s-x", name), "utf8");
      expect(text, name).not.toContain("hunter2hunter2");
      expect(text, name).not.toContain(token);
      expect(text, name).not.toContain(bearer);
      expect(statSync(stateFile(home, "s-x", name)).mode & 0o777, name).toBe(0o600);
    }
    expect(start.stdout).not.toContain("hunter2hunter2");
    expect(start.stdout).not.toContain(token);
    expect(start.stdout).toContain("***");
  });

  it("[sma:k_hpc_progress] parallel tool calls never leave a torn ledger, and a ledger that does not parse is not overwritten", async () => {
    const home = tmp("g2-race-");
    const post = (n: number) => hookAsync({ hook_event_name: "PostToolUse", session_id: "s-r", tool_name: "Edit", tool_input: { file_path: `src/f${n}.ts` }, tool_response: "ok", cwd: home }, home);
    await Promise.all(Array.from({ length: 12 }, (_, n) => post(n)));
    const file = stateFile(home, "s-r", "ledger.json");
    const ledger = JSON.parse(readFileSync(file, "utf8")) as { files: string[] };
    expect(ledger.files.length).toBeGreaterThan(0);
    expect(readdirSync(join(home, ".lane-pilot/session-hooks/s-r")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // A read that fails to parse is followed by no write: the update is skipped, what was there stays.
    mkdirSync(join(home, ".lane-pilot/session-hooks/s-torn"), { recursive: true });
    const torn = stateFile(home, "s-torn", "ledger.json");
    writeFileSync(torn, '{"files":["src/kept.ts","src/al');
    hook({ hook_event_name: "PostToolUse", session_id: "s-torn", tool_name: "Edit", tool_input: { file_path: "src/new.ts" }, tool_response: "ok", cwd: home }, home);
    expect(readFileSync(torn, "utf8")).toBe('{"files":["src/kept.ts","src/al');
    // The prompt path obeys the same rule.
    prompt(home, "s-torn", "a prompt that must not wipe the ledger");
    expect(readFileSync(torn, "utf8")).toBe('{"files":["src/kept.ts","src/al');
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

  it("[sma:k_h_pretask] the pack lists the NEWEST 20 files the window claims, not the oldest", () => {
    const home = tmp("g2-newest-");
    for (let n = 1; n <= 25; n++) hook({ hook_event_name: "PostToolUse", session_id: "s-n", tool_name: "Edit", tool_input: { file_path: `src/f${String(n).padStart(2, "0")}.ts` }, tool_response: "ok", cwd: home }, home);
    const out = hook({ hook_event_name: "PreToolUse", session_id: "s-n", tool_name: "Task", tool_input: { prompt: "look around" }, cwd: home }, home, { BB_CLI: stubBb(home, {}) });
    const prompt = (JSON.parse(out.stdout) as { hookSpecificOutput: { updatedInput: { prompt: string } } }).hookSpecificOutput.updatedInput.prompt;
    expect(prompt).toContain("src/f25.ts");
    expect(prompt).toContain("src/f06.ts");
    expect(prompt).not.toContain("src/f05.ts");
    expect(prompt).not.toContain("src/f01.ts");
  });

  it("[sma:k_hpt_record] a bb that ignores SIGTERM is killed at the budget: the hook is back within seconds, with exit 0 and no output", () => {
    const home = tmp("g2-kill-");
    const file = join(home, "bb-deaf.sh");
    writeFileSync(file, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 0.1; done\n");
    chmodSync(file, 0o755);
    const started = Date.now();
    const asked = hook({ hook_event_name: "UserPromptSubmit", session_id: "s-k", prompt: "how does the guard work", cwd: home }, home, { BB_CLI: file });
    const task = hook({ hook_event_name: "PreToolUse", session_id: "s-k", tool_name: "Task", tool_input: { prompt: "look" }, cwd: home }, home, { BB_CLI: file });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(asked.status).toBe(0);
    expect(asked.stdout).toBe("");
    expect(task.status).toBe(0);
  }, 30_000);

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

describe("the tree check of a subagent's claims", () => {
  const stop = (repo: string, home: string, message: string, env: Record<string, string> = {}) => {
    const out = hook({ hook_event_name: "SubagentStop", session_id: "s-claim", cwd: repo, last_assistant_message: message }, home, { BB_CLI: stubBb(home, {}), ...env });
    const receipt = JSON.parse(lines(join(home, ".lane-pilot/session-hooks/s-claim/receipts.jsonl")).pop()!) as { subagent_receipt: { states: Array<{ path: string; state: string }> } };
    return { out, states: receipt.subagent_receipt.states };
  };

  it("[sma:k_hsv_tree] words with a dot are not paths; a path needs a folder, no «..», no leading «/» or «~», and stays inside the checkout", () => {
    const repo = newRepo("g2-claimed-");
    commitFile(repo, "README.md", "r\n", "readme");
    mkdirSync(join(repo, "src"));
    commitFile(repo, "src/real.ts", "x\n", "real");
    const outside = tmp("g2-claimed-outside-");
    writeFileSync(join(outside, "secret.txt"), "s\n");
    symlinkSync(outside, join(repo, "link"));
    const home = tmp("g2-claimed-home-");
    const { out, states } = stop(repo, home, [
      "I ran console.log and process.env, fixed Next.js and res.json handling,",
      "then touched a/../../b.ts, /etc/passwd.txt, ~/notes.txt, link/secret.txt, src/real.ts, src/ghost.ts, README.md and see https://example.com/page.js.",
    ].join(" "));
    expect(states.map((row) => row.path).sort()).toEqual(["README.md", "src/ghost.ts", "src/real.ts"]);
    const state = (path: string) => states.find((row) => row.path === path)?.state;
    expect(state("src/ghost.ts")).toBe("phantom");
    expect(state("src/real.ts")).toBe("untouched");
    expect(state("README.md")).toBe("untouched");
    for (const word of ["console.log", "process.env", "Next.js", "res.json", "b.ts", "passwd", "notes.txt", "secret.txt", "page.js"]) expect(out.stdout, word).not.toContain(word);
    // A bare name that is no file at the root is no claim either, even with a letter and an extension.
    expect(stop(repo, tmp("g2-claimed-home2-"), "see config.yaml").states).toEqual([]);
  });

  it("[sma:k_hsv_tree] the whole tree check has 5 s: the paths time did not reach are «unchecked», never phantoms", () => {
    const repo = newRepo("g2-slow-");
    const bin = tmp("g2-slow-bin-");
    writeFileSync(join(bin, "git"), "#!/bin/sh\nsleep 2\nexit 0\n");
    chmodSync(join(bin, "git"), 0o755);
    const home = tmp("g2-slow-home-");
    const started = Date.now();
    const { out, states } = stop(repo, home, Array.from({ length: 10 }, (_, n) => `dir/file${n}.ts`).join(" "), { PATH: `${bin}:${process.env.PATH}` });
    expect(Date.now() - started).toBeLessThan(9_000);
    const unchecked = states.filter((row) => row.state === "unchecked");
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked.length).toBeLessThan(10);
    expect(states.filter((row) => row.state === "phantom").length + unchecked.length).toBe(10);
    // The phantoms named are only the paths that were really checked.
    const phantomPart = /phantoms \(named but nowhere in the tree\): ([^;]*)/.exec(out.stdout)?.[1] ?? "";
    for (const row of unchecked) expect(phantomPart).not.toContain(row.path);
    expect(out.stdout).toContain("not checked in time");
  }, 30_000);
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

  it("[sma:k_hss_summary] a thread reaches only its own project; the starting session's own attempt and attempts that have not moved are not «claimed by another window»", async () => {
    const w = await cliWorld({ "thr-b": "proj-b", "thr-x": "proj-x" });
    const wsOwn = tmp("g2-ws-own-"), wsOther = tmp("g2-ws-other-"), wsOld = tmp("g2-ws-old-");
    createRun(w.db, "run-b", "proj-b", "bb", wsOwn);
    const attempt = (id: string, workspace: string, paths: string[], agoMs: number) => {
      createTask(w.db, { id: `t-${id}`, runId: "run-b", kind: "bb", contract: { owns_paths: paths } });
      createAttempt(w.db, { id: id, runId: "run-b", taskId: `t-${id}` });
      w.db.prepare("UPDATE lane_pilot_attempt SET state='running', workspace_path=?, updated_at=? WHERE id=?").run(workspace, Date.now() - agoMs, id);
    };
    attempt("a-own", wsOwn, ["src/own.ts"], 1_000);
    attempt("a-other", wsOther, ["src/other.ts"], 1_000);
    attempt("a-hours", wsOld, ["src/hours.ts"], 3 * 3_600_000);
    const brief = async (args: string[], threadId?: string) => w.harness.behavior.runCli(["session-brief", "--json", ...args], threadId ? { threadId } : {});
    const own = JSON.parse((await brief(["--cwd", wsOwn], "thr-b")).stdout!) as { foreign: Array<{ taskId: string }>; live: number; stale: number };
    expect(own.foreign.map((row) => row.taskId)).toEqual(["t-a-other"]);
    expect(own.live).toBe(2);
    expect(own.stale).toBe(1);
    // A folder inside the session's own worktree is still its own.
    mkdirSync(join(wsOwn, "sub"));
    expect((JSON.parse((await brief(["--cwd", join(wsOwn, "sub")], "thr-b")).stdout!) as { foreign: Array<{ taskId: string }> }).foreign.map((row) => row.taskId)).toEqual(["t-a-other"]);
    // A thread of another project: --project and --cwd that name proj-b are refused, naming the reason.
    for (const args of [["--project", "proj-b"], ["--cwd", wsOwn]]) {
      const refused = await brief(args, "thr-x");
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toMatch(/refused: session-brief from a thread reaches only that thread's own project \(proj-x\), not proj-b/);
      expect(refused.stdout ?? "").not.toContain("src/other.ts");
    }
    // The owner at a terminal (no thread) reaches any project with either flag; a thread that is not found has no project to speak for.
    expect((JSON.parse((await brief(["--project", "proj-b"])).stdout!) as { live: number }).live).toBe(2);
    expect((JSON.parse((await brief(["--cwd", wsOwn])).stdout!) as { live: number }).live).toBe(2);
    const unknown = await brief(["--cwd", wsOwn], "thr-nobody");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("project of this thread is unknown");
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
    // A brief that says nothing and no capsule: the hook stays silent. No settings file stands in for the guard: a lane session gets the
    // guard from a generated settings file the hook never reads, so the line «guard_shell.py is not registered» must not exist.
    const home2 = tmp("g2-start-empty-");
    const bb2 = stubBb(home2, { "session-brief": "{}" });
    const quiet = hook({ hook_event_name: "SessionStart", session_id: "s-e", cwd: home2 }, home2, { BB_CLI: bb2 });
    expect(quiet.stdout).toBe("");
    expect(quiet.stdout).not.toContain("not registered");
    // What the environment really says is off is still said.
    const off = hook({ hook_event_name: "SessionStart", session_id: "s-e2", cwd: home2 }, home2, { BB_CLI: bb2, LANE_STALL_CHECK: "0" });
    const offText = (JSON.parse(off.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(offText).toBe("Protections switched off: LANE_STALL_CHECK");
    expect(offText).not.toContain("guard_shell.py");
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

  it("[sma:k_hss_digest] one head file per repository (worktrees share it), the newest 200 kept, and a file that is no sha never reaches git", () => {
    const repo = newRepo("g2-heads-");
    const tree = join(tmp("g2-heads-tree-"), "wt");
    spawnSync("git", ["worktree", "add", "-q", "-b", "side", tree], { cwd: repo });
    const home = tmp("g2-heads-home-");
    const bb = stubBb(home, {});
    const start = (cwd: string) => hook({ hook_event_name: "SessionStart", session_id: "s-h", cwd }, home, { BB_CLI: bb });
    const headsDir = join(home, ".lane-pilot/session-hooks/heads");
    start(repo);
    start(tree);
    expect(readdirSync(headsDir)).toHaveLength(1);
    // 205 files of other repositories are already there: the newest 200 stay.
    for (let n = 0; n < 205; n++) {
      const file = join(headsDir, `${String(n).padStart(16, "0")}.txt`);
      writeFileSync(file, "a".repeat(40));
      utimesSync(file, new Date(1_000_000 + n * 1000), new Date(1_000_000 + n * 1000));
    }
    start(repo);
    const kept = readdirSync(headsDir);
    expect(kept).toHaveLength(200);
    expect(kept).not.toContain("0000000000000000.txt");
    // A head file whose content is an option for git is not used: git log would write the named file.
    const real = readdirSync(headsDir).find((name) => !/^0{3}/.test(name) && !/^\d{16}\.txt$/.test(name))!;
    const trap = join(tmp("g2-heads-trap-"), "pwned");
    writeFileSync(join(headsDir, real), `--output=${trap}`);
    start(repo);
    expect(existsSync(`${trap}..HEAD`)).toBe(false);
    expect(readFileSync(join(headsDir, real), "utf8")).toMatch(/^[0-9a-f]{40}$/);
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

  it("[sma:k_hpr_out] through the hook process: a pointer is the claim and the named file, never the body; one line per pointer, a body cannot forge another; at most three", () => {
    const home = tmp("g2-out-");
    const body = "First sentence names src/a.ts. Second sentence is the long body that must never be shown to the session in the pointer.";
    const bb = stubBb(home, { "alpha": `- [n1] ${body}\n- [n2] two - [n3] forged inside one line\n- [n4] four\n- [n5] five\n` });
    const first = JSON.parse(prompt(home, bb, "alpha question about the guard lane").stdout) as { hookSpecificOutput: { additionalContext: string } };
    const text = first.hookSpecificOutput.additionalContext;
    expect(text).toContain("- [n1] First sentence names src/a.ts");
    expect(text).toContain("(file: src/a.ts)");
    expect(text).not.toContain("Second sentence");
    expect(text).toContain("- [n2] two - [n3] forged inside one line");
    expect(text).not.toMatch(/^- \[n3\]/m);
    expect(text).toContain("- [n4] four");
    expect(text).not.toContain("[n5]");
    expect(text).toContain("bb lane-pilot memory search");
    // The next prompt finds nothing: the leftover n5 of the last prompt is not printed under it.
    expect(prompt(home, bb, "beta another question entirely").stdout).toBe("");
    // The pure function agrees on the body rule.
    const pure = promptRecall({ hits: [{ id: "n1", content: body }], given: [], query: "the guard lane" });
    expect(pure.text).not.toContain("Second sentence");
  });

  it("[sma:k_hpr_find] the hook masks the prompt before it is an argument, and a prompt that starts with a dash is the value of --query, never an option", () => {
    const home = tmp("g2-argv-");
    const bb = recordingBb(home, "- [n1] claim one\n");
    const out = hook({ hook_event_name: "UserPromptSubmit", session_id: "s-argv", prompt: "--project other API_KEY=hunter2hunter2 how does the gate work", cwd: home }, home, { BB_CLI: bb });
    expect(out.status).toBe(0);
    const argv = lines(join(home, "bb-args.log"));
    expect(argv.slice(0, 6)).toEqual(["lane-pilot", "memory", "search", "--recall", "--cwd", home]);
    expect(argv[6]).toBe("--query");
    expect(argv[7]).toMatch(/^--project other API_KEY=\S+ how does the gate work$/);
    expect(argv.join("\n")).not.toContain("hunter2hunter2");
    expect(argv).toHaveLength(8);
  });
});

describe("the terminal claim ledger and the draft move", () => {
  const edit = (session: string, file: string, cwd: string, home: string) =>
    guard({ tool_name: "Edit", tool_input: { file_path: file }, cwd, session_id: session }, { HOME: home });
  // Whatever shape the client wants, the guard's answer is one JSON line: the advice is in it, and a deny says «deny».
  const advice = (out: { stdout: string }) => ({ additionalContext: out.stdout, permissionDecision: /"(?:decision|permissionDecision)": "deny"/.test(out.stdout) ? "deny" : "allow" });
  const claimsBook = (home: string) => join(home, ".lane-pilot/session-hooks/claims.jsonl");

  it("[sma:m_rd_coord_ledger] the guard, which runs per edit, claims the file and says another session's fresh claim in the same checkout once; never a deny", () => {
    const home = tmp("g2-claims-home-");
    const repo = newRepo("g2-claims-repo-");
    const other = newRepo("g2-claims-other-");
    expect(advice(edit("sess-A", "src/x.ts", repo, home)).additionalContext).not.toContain("[claims]");
    const b = advice(edit("sess-B", "src/x.ts", repo, home));
    expect(b.additionalContext).toContain("[claims]");
    expect(b.additionalContext).toContain("sess-A (writer)");
    expect(b.permissionDecision).not.toBe("deny");
    // Once per session and file: B heard it and hears nothing more; A, who edited before B came, hears of B at its next edit, once; nobody writes a second claim.
    expect(advice(edit("sess-B", "src/x.ts", repo, home)).additionalContext).not.toContain("[claims]");
    expect(advice(edit("sess-A", "src/x.ts", repo, home)).additionalContext).toContain("sess-B (writer)");
    expect(advice(edit("sess-A", "src/x.ts", repo, home)).additionalContext).not.toContain("[claims]");
    expect(lines(claimsBook(home)).map((line) => (JSON.parse(line) as { session: string }).session)).toEqual(["sess-A", "sess-B"]);
    // The same relative path in ANOTHER repository is another file.
    expect(advice(edit("sess-C", "src/x.ts", other, home)).additionalContext).not.toContain("[claims]");
    // A worktree of the same repository is another checkout: nothing there overwrites this one (a merge settles it), and a Pilot writer in its own worktree is not told to leave its file.
    const tree = join(tmp("g2-claims-tree-"), "wt");
    spawnSync("git", ["worktree", "add", "-q", "-b", "side", tree], { cwd: repo });
    expect(advice(edit("sess-D", "src/x.ts", tree, home)).additionalContext).not.toContain("[claims]");
    // A file nobody claimed gets no advice; a claim past 30 minutes says nothing.
    expect(advice(edit("sess-A", "src/free.ts", repo, home)).additionalContext).not.toContain("[claims]");
    const rows = lines(claimsBook(home)).map((line) => JSON.parse(line) as Record<string, unknown>);
    rows.push({ session: "sess-old", role: "writer", cwd: repo, path: "src/y.ts", at: Date.now() - 60 * 60_000 });
    writeFileSync(claimsBook(home), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    expect(advice(edit("sess-E", "src/y.ts", repo, home)).additionalContext).not.toContain("[claims]");
  });

  it("[sma:m_rd_coord_ledger] the claim book past 256 KB keeps its newest 2000 lines; the guard reads only its tail; the node hook no longer claims", () => {
    const home = tmp("g2-claims-trim-");
    const repo = newRepo("g2-claims-trim-repo-");
    mkdirSync(join(home, ".lane-pilot/session-hooks"), { recursive: true });
    const filler = Array.from({ length: 6000 }, (_, n) => JSON.stringify({ session: `old-${n}`, role: "", cwd: repo, path: `src/old${n}.ts`, at: Date.now() - 3 * 3_600_000, pad: "x".repeat(40) })).join("\n");
    writeFileSync(claimsBook(home), `${filler}\n`);
    expect(statSync(claimsBook(home)).size).toBeGreaterThan(256 * 1024);
    edit("sess-T", "src/new.ts", repo, home);
    const kept = lines(claimsBook(home));
    expect(kept).toHaveLength(2000);
    expect(JSON.parse(kept.at(-1)!)).toMatchObject({ session: "sess-T", path: "src/new.ts" });
    // The dead branch of the node hook is gone: an Edit through it neither claims nor speaks.
    const home2 = tmp("g2-claims-node-");
    hook({ hook_event_name: "PreToolUse", session_id: "n-1", tool_name: "Edit", tool_input: { file_path: "src/x.ts" }, cwd: home2 }, home2);
    const second = hook({ hook_event_name: "PreToolUse", session_id: "n-2", tool_name: "Edit", tool_input: { file_path: "src/x.ts" }, cwd: home2 }, home2);
    expect(second.stdout).not.toContain("[claims]");
    expect(existsSync(claimsBook(home2))).toBe(false);
  });

  // Some sixty hook processes one after another: 18 s on a loaded machine (the full run), 5 s alone.
  it("[sma:m_draft_move] two SessionEnd events with work leave two distinct draft files; an empty farewell leaves none; two projects named alike stay apart; 50 are kept", { timeout: 90_000 }, () => {
    const repo = newRepo("g2-draft-");
    const home = tmp("g2-draft-home-");
    const end = { hook_event_name: "SessionEnd", session_id: "s-end2", cwd: repo, files: ["src/a.ts"] };
    hook(end, home);
    hook(end, home);
    const slug = (cwd: string) => `${cwd.split("/").pop()}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
    const dir = join(home, ".lane-pilot", "drafts", slug(repo));
    const names = readdirSync(dir).sort();
    expect(names).toEqual(["farewell-s-end2-2.md", "farewell-s-end2.md"]);
    expect(readFileSync(join(dir, names[1]), "utf8")).toContain("Farewell lesson draft");
    // draftTarget skips taken names, never an existing file.
    expect(draftTarget([], "a.md")).toBe("a.md");
    expect(draftTarget(["a.md", "a-2.md"], "a.md")).toBe("a-3.md");
    // A session that did nothing leaves no file in the drafts.
    const quiet = newRepo("g2-draft-quiet-");
    hook({ hook_event_name: "SessionEnd", session_id: "s-nothing", cwd: quiet }, home);
    expect(existsSync(join(home, ".lane-pilot", "drafts", slug(quiet)))).toBe(false);
    // Two folders with the same name are two slugs.
    const twin = join(tmp("g2-draft-twin-"), repo.split("/").pop()!);
    mkdirSync(twin);
    hook({ ...end, cwd: twin, session_id: "s-twin" }, home);
    expect(slug(twin)).not.toBe(slug(repo));
    expect(readdirSync(join(home, ".lane-pilot", "drafts", slug(twin)))).toEqual(["farewell-s-twin.md"]);
    // Each slug keeps its newest 50.
    for (let n = 0; n < 55; n++) {
      hook({ ...end, session_id: `s-many-${String(n).padStart(2, "0")}` }, home);
      const file = join(dir, `farewell-s-many-${String(n).padStart(2, "0")}.md`);
      if (existsSync(file)) utimesSync(file, new Date(Date.now() + n * 1000), new Date(Date.now() + n * 1000));
    }
    const left = readdirSync(dir);
    expect(left).toHaveLength(50);
    expect(left).toContain("farewell-s-many-54.md");
    expect(left).not.toContain("farewell-s-many-00.md");
  });
});

describe("the pack layers reach only confirmed material", () => {
  /** A project with an observed note (fresh and old), a confirmed note, another project's confirmed note, an accepted always-rule, and the rule of a sibling section. */
  async function seededWorld() {
    const w = await cliWorld({ "thr-p": "proj-p", "thr-q": "proj-q" });
    const put = (projectId: string, content: string, extra: { trust?: "confirmed" | "observed"; now?: number } = {}) =>
      storeMemoryRecords(w.db as never, { projectId, audience: "subagent", sourceSha256: sha(content), trust: extra.trust ?? "confirmed", ...(extra.now ? { now: extra.now } : {}), entries: [{ kind: "note", content, concepts: ["gate"] }], ...BUDGET }).insertedIds[0]!;
    const ids = {
      confirmed: put("proj-p", "The vitest gate runs before every merge of this project."),
      observedFresh: put("proj-p", "The vitest gate was seen to run in a minute by one session.", { trust: "observed" }),
      observedOld: put("proj-p", "The vitest gate seems to need the cache folder cleared by hand.", { trust: "observed", now: Date.now() - 48 * 3_600_000 }),
      foreign: put("proj-q", "The vitest gate of the other project is a secret recipe."),
    };
    const rule = (text: string, scope?: string[]) => {
      upsertLessonProposal(w.db as never, "proj-p", { rule: text, evidence: "e", audience: "both", always: true, ...(scope ? { scope } : {}) });
      const made = upsertLessonProposal(w.db as never, "proj-p", { rule: text, evidence: "e2", audience: "both", always: true, ...(scope ? { scope } : {}) });
      return adoptRuleProposal(w.db as never, "proj-p", made.id)?.id;
    };
    const ruleId = rule("Always run the vitest gate before a merge.");
    const siblingId = rule("Always bless the vitest gate in the docs section only.", ["section:docs"]);
    return { w, ids, ruleId, siblingId };
  }

  it("[sma:k_h_pretask] the verb's layers are the accepted always-rules of the caller's sections and CONFIRMED notes of its own project; off by default", async () => {
    const { w, ids, ruleId, siblingId } = await seededWorld();
    expect(ruleId).toBeTruthy();
    expect(siblingId).toBeTruthy();
    const pack = async (args: string[] = [], threadId?: string) => w.harness.behavior.runCli(["subagent-pack", "vitest gate merge", ...args], threadId ? { threadId } : {});
    expect(JSON.parse((await pack(["--project", "proj-p"])).stdout!)).toEqual({ rules: [], lessons: [] });
    saveProjectSetting(w.db, "proj-p", "hook.subagent_pack", "on");
    const on = JSON.parse((await pack(["--project", "proj-p"])).stdout!) as { rules: string[]; lessons: string[] };
    expect(on.rules).toEqual(["Always run the vitest gate before a merge."]);
    expect(on.lessons).toEqual(["The vitest gate runs before every merge of this project."]);
    const text = JSON.stringify(on);
    for (const leak of ["seen to run", "cleared by hand", "secret recipe", "docs section"]) expect(text, leak).not.toContain(leak);
    // The sibling section's rule comes only to a session of that section.
    createRun(w.db, "run-docs", "proj-p", "bb", "/ws/docs");
    setRunSettingsScopes(w.db, "run-docs", ["section:docs"]);
    const docs = JSON.parse((await pack(["--project", "proj-p", "--cwd", "/ws/docs"])).stdout!) as { rules: string[] };
    expect(docs.rules).toContain("Always bless the vitest gate in the docs section only.");
    // memory.enabled=false: the pack is empty.
    saveProjectSetting(w.db, "proj-p", "memory.enabled", false);
    expect(JSON.parse((await pack(["--project", "proj-p"])).stdout!)).toEqual({ rules: [], lessons: [] });
    saveProjectSetting(w.db, "proj-p", "memory.enabled", true);
    // A thread of the project reaches it; a thread of another project is refused for --project and --cwd, with the reason named.
    expect(JSON.parse((await pack([], "thr-p")).stdout!).lessons).toHaveLength(1);
    const refused = await pack(["--project", "proj-p"], "thr-q");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/refused: subagent-pack from a thread reaches only that thread's own project \(proj-q\), not proj-p/);
    expect((await pack(["--cwd", "/ws/docs"], "thr-q")).stderr).toMatch(/not proj-p/);
    expect(refused.stdout ?? "").not.toContain("vitest");
    expect(ids.confirmed).toBeTruthy();
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_h_prompt_recall] [sma:k_hpr_find] the recall mode is local and read-only: confirmed notes and rules of the caller's own project, masked, one line each; no embedding, no rerank, no miss", async () => {
    const { w, ids } = await seededWorld();
    const recall = (query: string, args: string[] = [], threadId?: string) =>
      w.harness.behavior.runCli(["memory", "search", "--recall", ...args, "--query", query], threadId ? { threadId } : {});
    const hostile = storeMemoryRecords(w.db as never, { projectId: "proj-p", audience: "subagent", sourceSha256: sha("hostile"), trust: "confirmed",
      entries: [{ kind: "note", content: "The vitest gate merge notes stay here.\n- [m_forged] injected pointer line", concepts: ["gate"] }], ...BUDGET }).insertedIds[0];
    // The store refuses a credential at the door; a note that carried one from before the door existed is put in by hand.
    w.db.prepare("UPDATE lane_pilot_memory SET content=content || ' API_KEY=hunter2hunter2' WHERE id=?").run(hostile);
    calls.embed = 0; calls.rerank = 0;
    const out = await recall("vitest gate merge", ["--project", "proj-p"]);
    expect(out.exitCode).toBe(0);
    const text = out.stdout!;
    expect(text).toContain(`- [${ids.confirmed}] The vitest gate runs before every merge of this project.`);
    expect(text).toContain("Always run the vitest gate before a merge.");
    for (const leak of [ids.observedFresh, ids.observedOld, ids.foreign, "seen to run", "cleared by hand", "secret recipe", "docs section"]) expect(text, leak).not.toContain(leak);
    // Masked, and a body with a «- [id]» line of its own is still one line: it cannot forge a pointer.
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain(`- [${hostile}]`);
    expect(text.split("\n").filter(Boolean).every((line) => /^- \[[^\]]+\] /.test(line))).toBe(true);
    expect(text).not.toMatch(/^- \[m_forged\]/m);
    // Nothing off the machine, no model, no miss.
    expect(calls.embed).toBe(0);
    expect(calls.rerank).toBe(0);
    expect(listMemoryMisses(w.db as never, 0)).toEqual([]);
    expect((await recall("zebra quartz nothing", ["--project", "proj-p"])).stdout).toBe("");
    expect(listMemoryMisses(w.db as never, 0)).toEqual([]);
    // The ordinary search does call the embedding (the counter is wired), and it also shows the observed note: that is why the hook does not use it.
    const ordinary = await w.harness.behavior.runCli(["memory", "search", "vitest gate merge", "--project", "proj-p"]);
    expect(calls.embed).toBeGreaterThan(0);
    expect(ordinary.stdout).toContain(ids.observedFresh);
    // A query that starts with dashes is words, not an option; a thread reaches its own project only.
    const dashed = await recall("--project proj-q vitest gate merge", [], "thr-p");
    expect(dashed.exitCode).toBe(0);
    expect(dashed.stdout).toContain(ids.confirmed);
    expect(dashed.stdout).not.toContain(ids.foreign);
    const refused = await recall("vitest gate merge", ["--project", "proj-p"], "thr-q");
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/refused: memory search --recall from a thread reaches only that thread's own project \(proj-q\), not proj-p/);
    // On by default; the project setting hook.prompt_recall=off silences it; memory.enabled=false too.
    saveProjectSetting(w.db, "proj-p", "hook.prompt_recall", "off");
    const off = await recall("vitest gate merge", ["--project", "proj-p"]);
    expect(off).toMatchObject({ exitCode: 0, stdout: "" });
    saveProjectSetting(w.db, "proj-p", "hook.prompt_recall", "on");
    expect((await recall("vitest gate merge", ["--project", "proj-p"])).stdout).toContain(ids.confirmed);
    saveProjectSetting(w.db, "proj-p", "memory.enabled", false);
    expect((await recall("vitest gate merge", ["--project", "proj-p"])).stdout).toBe("");
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
