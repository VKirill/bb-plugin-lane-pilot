// What the region scene sma_r18.py cannot ask in Python: the real session hook program (src/rooms/session-hooks/cli.ts) on real hook inputs, and the
// TypeScript checks the hooks' cards name, run for real on scratch folders and a scratch database (no model, no hub write, no network).
// Prints one JSON line of observed values. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt, createRun, createTask, saveProjectSetting, transitionAttempt } from "../../../src/rooms/storage";
import { createStability } from "../../../src/rooms/stability/server/stability";
import { createTaskReconcile } from "../../../src/rooms/runs/server/task-reconcile";
import { listOpenWorktrees, listUnmovedLiveAttempts, registerWorktree } from "../../../src/rooms/storage";
import { findUnownedChanges } from "../../../src/rooms/contracts/ownership";
import { gitOwnershipChangedPaths } from "../../../src/rooms/verification/git-ownership";
import { reconcileWorktreeRegistry } from "../../../src/rooms/stability/server/worktree-janitor";
import { calibrate } from "../../../src/rooms/forecast/logic";
import { weakAreas } from "../../../src/rooms/forecast/server/report";
import { noteProtectionDisarm, rearmExpiredDisarms } from "../../../src/rooms/policy/protections";
import { missCurriculum } from "../../../src/rooms/tools/server/self-improve";
import { recordMemoryMiss, searchMemoryRecords, storeMemoryRecordsKeepingOverflow } from "../../../packages/memory-core/src";
import { upsertLessonProposal } from "../../../packages/run-insights/src";
import { adoptRuleProposal } from "../../../src/rooms/self-repair/server/insights";
import { pmRulesPromptBlock } from "../../../src/rooms/learning/pm-rules";
import { stripClaudeLaneSettings } from "../../../src/rooms/native-install/claude-lane-leftovers";
import { usageSegment } from "../../../src/rooms/usage/statusline-segment";
import { upsertAttemptChange } from "../../../src/rooms/rollback/store";
import { mountRateLimitWatch, RATE_LIMIT_PREFIX } from "../../../src/rooms/stability/server/rate-limit-watch";
import type { Services } from "../../../server";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const HOOK = join(ROOT, "src/rooms/session-hooks/cli.ts");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

function hook(payload: Record<string, unknown> | string, home: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...process.env, HOME: home, ...env } });
}
function stubBb(home: string, answers: Record<string, string>): string {
  const file = join(home, "bb-stub.sh");
  const cases = Object.entries(answers).map(([match, out]) => `case "$*" in *"${match}"*) printf '%b' '${out.replace(/'/g, "'\\''")}'; exit 0 ;; esac`).join("\n");
  writeFileSync(file, `#!/bin/sh\n${cases}\nexit 1\n`);
  chmodSync(file, 0o755);
  return file;
}
function recordingBb(home: string, out: string): string {
  const file = join(home, "bb-record.sh");
  writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${join(home, "bb-args.log")}"; done\nprintf '%b' '${out.replace(/'/g, "'\\''")}'\nexit 0\n`);
  chmodSync(file, 0o755);
  return file;
}
const ctxText = (stdout: string): string => { try { return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext; } catch { return ""; } };
const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });

async function main() {
  const out: Record<string, unknown> = {};

  // n1402: garbage on stdin, an empty input, a cut-off JSON and a cwd that is no folder: exit zero, nothing on stdout.
  const failHome = tmp("r18-fail-");
  out.n1402 = ["not-json", "", "{\"hook_event_name\":", "[1,2", "null"].map((input) => { const ran = hook(input, failHome); return [ran.status, ran.stdout]; });

  // n1403: an attempt whose writer loop is gone and that has not moved past the idle limit is taken back by the periodic pass.
  {
    const { db, bb } = open();
    createRun(db, "run", "proj", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_host_id='h1' WHERE id='run'").run();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a1'").run(Date.now() - 10 * 60_000);
    const asked: string[][] = [];
    const services = { activeWriterTasks: new Set<string>(), resumeOrphans: async (_run?: string, ids?: string[]) => { asked.push(ids ?? []); return { resumed: [], finished: [], skipped: [] }; } } as unknown as Services;
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false } as never;
    Object.assign(services, createStability(ctx, services));
    await createTaskReconcile(ctx, services).reconcileTasks({ phase: "periodic", now: Date.now() });
    out.n1403 = asked;
  }

  // n1404: a path outside owns_paths is named; a path inside is not; a never_touch path is named.
  {
    const task = { owns_paths: ["src/a.ts", "src/owned/**"], never_touch: ["src/owned/secret.ts"] } as never;
    out.n1404 = [findUnownedChanges(["src/a.ts", "src/stray.ts"], task), findUnownedChanges(["src/a.ts", "src/owned/b.ts"], task), findUnownedChanges(["src/owned/secret.ts"], task)];
  }

  // n1405: a subscription-window event of any thread is stored by provider; another kind of limit is not; the same event again writes nothing.
  {
    const store = new Map<string, unknown>(); const sets: string[] = []; const handlers: Array<(payload: unknown) => unknown> = [];
    const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { sets.push(key); store.set(key, value); } };
    mountRateLimitWatch({ isDisposed: () => false, bb: { storage: { kv }, log: { info: () => {} }, events: { on: (_n: string, h: (p: unknown) => unknown) => { handlers.push(h); } } } } as never);
    const reset = Date.now() + 3_600_000;
    const limits = { kind: "subscription-window", providerId: "claude-code", status: "blocked", windows: [{ label: "five-hour", providerKey: "five_hour", status: "blocked", resetsAtMs: reset }] };
    const send = (rateLimits: Record<string, unknown>) => handlers[0]!({ event: { type: "provider/rateLimits/updated", rateLimits } });
    await send(limits);
    await send({ ...limits, kind: "credits", providerId: "other" });
    await send(limits);
    out.n1405 = { sets, prefix: RATE_LIMIT_PREFIX, stored: (store.get(`${RATE_LIMIT_PREFIX}claude-code`) as { windows: Array<{ label: string; status: string; resetsAtMs: number }> }).windows[0], reset };
  }

  // n1406: the attempt's base sha is compared with HEAD as two trees; the stray path is the one outside owns_paths.
  {
    const repo = tmp("r18-tree-");
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "base.txt"), "base\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "base"]);
    const baseSha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    writeFileSync(join(repo, "a.ts"), "a\n"); writeFileSync(join(repo, "b.ts"), "b\n"); git(repo, ["add", "."]); git(repo, ["commit", "-qm", "work"]);
    const changed = await gitOwnershipChangedPaths({ projectCwd: repo, baseSha, compareCommitted: true });
    const failed = await gitOwnershipChangedPaths({ projectCwd: repo, baseSha: null, compareCommitted: true });
    out.n1406 = { status: changed.status, paths: changed.paths, unowned: findUnownedChanges(changed.paths, { owns_paths: ["a.ts"], never_touch: [] } as never), unreadStatus: failed.status };
  }

  // n1407: only live-state attempts older than the cutoff are listed.
  {
    const { db } = open();
    createRun(db, "run", "proj", "bb", "/repo");
    for (const [id, state, age] of [["old-run", "running", 600_000], ["new-run", "running", 1_000], ["old-queued", "queued", 600_000]] as const) {
      createTask(db, { id: `T-${id}`, runId: "run", kind: "bb", contract: {} });
      createAttempt(db, { id, runId: "run", taskId: `T-${id}` });
      db.prepare("UPDATE lane_pilot_attempt SET state=?, updated_at=? WHERE id=?").run(state, Date.now() - age, id);
    }
    out.n1407 = listUnmovedLiveAttempts(db, Date.now() - 300_000).map((row) => row.id);
  }

  // n1408: a worktree no live attempt holds is removed and its registry row released; one an open attempt holds is kept.
  {
    const { db, bb } = open();
    createRun(db, "run", "proj", "bb", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_host_id='h1' WHERE id='run'").run();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested"); transitionAttempt(db, "a1", "running");
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/wt/held' WHERE id='a1'").run();
    registerWorktree(db, { host: "h1", path: "/wt/held", branch: "lane/a1", owner_kind: "attempt", owner_id: "a1" });
    registerWorktree(db, { host: "h1", path: "/wt/gone", branch: "lane/gone", owner_kind: "attempt", owner_id: "a-gone" });
    const removedCalls: string[] = [];
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false, host: { call: async (method: string, input: { worktreePath?: string }) => { if (method === "gitRemoveWorktree") removedCalls.push(input.worktreePath ?? ""); return { removed: true }; } } } as never;
    const removed = await reconcileWorktreeRegistry(ctx);
    out.n1408 = { removed, calls: removedCalls, open: listOpenWorktrees(db).map((row) => row.path) };
  }

  // n1409: a SessionEnd with no files in its payload still names the files PostToolUse journaled; a payload's own list is named in order.
  {
    const home = tmp("r18-end-");
    hook({ hook_event_name: "PostToolUse", session_id: "e1", tool_name: "Edit", tool_input: { file_path: "src/journaled.ts" }, tool_response: "ok", cwd: home }, home);
    const ran = hook({ hook_event_name: "SessionEnd", session_id: "e1", cwd: home }, home);
    const draft = readFileSync(join(home, ".lane-pilot/session-hooks/e1/farewell.md"), "utf8");
    hook({ hook_event_name: "SessionEnd", session_id: "e2", cwd: home, files: ["a/first.ts", "b/second.ts"] }, home);
    out.n1409 = { status: ran.status, journaled: draft.split("\n")[2], listed: readFileSync(join(home, ".lane-pilot/session-hooks/e2/farewell.md"), "utf8").split("\n")[2] };
  }

  // n1410: the segment text.
  {
    const now = Date.parse("2026-11-11T12:00:00Z");
    const windows = { five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 18, resetsAt: null }, seven_day_opus: { utilization: 5, resetsAt: null } };
    out.n1410 = [usageSegment(windows, "2026-11-11T11:30:00Z", now), usageSegment(windows, "2026-11-11T09:00:00Z", now), usageSegment({}, null, now)];
  }

  // n1411: the wrapper is taken off and the person's saved line comes back exactly; the person's own line is not touched.
  {
    const home = "/home/person";
    const mine = { type: "command", command: "node /opt/my-line.js --fancy", padding: 2 };
    const wrapped = JSON.stringify({ model: "opus", statusLine: { type: "command", command: `${home}/.agents/bin/lane-statusline` } }, null, 2);
    const restored = stripClaudeLaneSettings(wrapped, home, { saved: mine });
    const own = JSON.stringify({ statusLine: mine }, null, 2);
    out.n1411 = { restored: JSON.parse(restored.text), removed: restored.removed, ownByteForByte: stripClaudeLaneSettings(own, home, { saved: { type: "command", command: "other" } }).text === own };
  }

  // n1413 / n1417 / n1423: the start text from a brief; after a compaction the capsule is first.
  {
    const home = tmp("r18-start-");
    const bb = stubBb(home, { "session-brief": '{"summary":"Work in this project: 2 live, 1 stale; a merge into main is running.","foreign":[],"weak":[]}' });
    hook({ hook_event_name: "PreCompact", session_id: "st1", cwd: home, asks: ["keep the contract"], files: ["src/a.ts"] }, home);
    const startup = ctxText(hook({ hook_event_name: "SessionStart", source: "startup", session_id: "st1", cwd: home }, home, { BB_CLI: bb }).stdout);
    const compact = ctxText(hook({ hook_event_name: "SessionStart", source: "compact", session_id: "st1", cwd: home }, home, { BB_CLI: bb }).stdout);
    out.n1413 = { startupHead: startup.split("\n")[0], hasCapsule: startup.includes("Capsule restored after compaction:") };
    out.n1417 = startup.split("\n")[0];
    out.n1423 = { compactHead: compact.split("\n")[0], briefingAfterCapsule: compact.indexOf("Work in this project") > compact.indexOf("Capsule restored") };
  }

  // n1414 / n1426 / n1427 / n1428: the prompt's words search memory; a pointer is the claim and the file, once per session; the masked words are the argument.
  {
    const home = tmp("r18-recall-");
    const body = "First sentence names src/a.ts. Second sentence is the long body that must never be shown in the pointer.";
    const bb = recordingBb(home, `- [n1] ${body}\n`);
    const prompt = (text: string) => hook({ hook_event_name: "UserPromptSubmit", session_id: "rc1", prompt: text, cwd: home }, home, { BB_CLI: bb });
    const first = prompt("--project other API_KEY=hunter2hunter2 how does the gate work");
    const second = prompt("--project other API_KEY=hunter2hunter2 how does the gate work");
    const argv = readFileSync(join(home, "bb-args.log"), "utf8").split("\n").filter(Boolean);
    const text = ctxText(first.stdout);
    out.n1414 = { status: first.status, pointerLine: text.split("\n")[1] };
    out.n1426 = { queryFlag: argv[6], masked: !argv.join("\n").includes("hunter2hunter2"), words: /how does the gate work$/.test(argv[7] ?? "") };
    out.n1427 = { first: first.stdout !== "", second: second.stdout };
    out.n1428 = { claimAndFile: text.split("\n")[1], bodyShown: text.includes("Second sentence") };
  }

  // n1416: after a model change the old hit rate is not shown: calibrate counts only the current model's tasks.
  {
    const score = { files: { forecast: 2, fact: 2, error: 0 }, firstTry: { forecast: true, fact: true, hit: true }, tokensRatio: null, minutesRatio: null, lines: null, dependencies: null, paths: null } as never;
    const rows = [...Array.from({ length: 5 }, () => ({ area: "ui", score, model: "codex/a" })), { area: "ui", score, model: "codex/b" }];
    out.n1416 = { forB: (calibrate(rows, "codex/b").overall as { tasks: number } | null)?.tasks ?? null, forA: (calibrate(rows, "codex/a").overall as { tasks: number } | null)?.tasks ?? null };
  }

  // n1418: the PM's rules block, section-scoped.
  {
    const { db } = open();
    const adopt = (rule: string, scope?: string[]) => {
      const made = upsertLessonProposal(db, "proj_1", { rule, evidence: "e", audience: "pm", always: false }, Date.now() - 40 * 86_400_000);
      adoptRuleProposal(db, "proj_1", made.id, Date.now() - 10 * 86_400_000);
      if (scope) db.prepare("UPDATE lane_pilot_rule_proposal SET scope_json=? WHERE id=?").run(JSON.stringify(scope), made.id);
    };
    adopt("Run the vitest gate before every merge into main.");
    adopt("Quote the clients section's contract wording when you plan.", ["section:clients"]);
    const lines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));
    out.n1418 = { plain: lines(pmRulesPromptBlock(db, "proj_1", [], 1600)), clients: lines(pmRulesPromptBlock(db, "proj_1", ["section:clients"], 1600)) };
  }

  // n1419: an area with under three scored tasks is a weak area.
  {
    const { db } = open();
    createRun(db, "run1", "projW");
    const contract = { schema_version: 2, id: "tw", title: "tw", risk: "low", lane: "w", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["x"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [], area: "ui", forecast: { files: 2, checks_pass_first_try: true } };
    createTask(db, { id: "tw", runId: "run1", kind: "bb", contract });
    createAttempt(db, { id: "a_tw", runId: "run1", taskId: "tw" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=1 WHERE id='a_tw'").run();
    upsertAttemptChange(db, { attemptId: "a_tw", runId: "run1", taskId: "tw" }, { outcome: "merged", changed: [{ path: "src/a.ts", status: "modified" }] });
    out.n1419 = { weak: weakAreas(db as never, "projW"), none: weakAreas(db as never, "proj-none") };
  }

  // n1420: a disarm past its term re-arms to the warning level; a renewed one is left alone.
  {
    const { db } = open();
    const t0 = Date.now() - 9 * 86_400_000;
    saveProjectSetting(db as never, "p", "code_critique.mode", "advisory");
    db.prepare("UPDATE lane_pilot_project_settings SET value=? WHERE project_id='p' AND binding_id='' AND key='protection.disarm.code_critique.mode'").run(JSON.stringify({ key: "code_critique.mode", by: "owner", at: t0, until: t0 + 7 * 86_400_000 }));
    const rearmed = rearmExpiredDisarms(db as never, "p");
    noteProtectionDisarm(db as never, "p", "code_critique.mode", "advisory", { by: "owner" });
    out.n1420 = { rearmed, again: rearmExpiredDisarms(db as never, "p") };
  }

  // n1421: the miss digest follows new misses with no rebuild: 2 then 3, an old miss is absent.
  {
    const { db } = open();
    const now = Date.now();
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now - 1000);
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now - 500);
    const two = missCurriculum(db, 30, now).find((row) => row.projectId === "p")?.count;
    recordMemoryMiss(db, "p", "how does the janitor keep worktrees", now);
    recordMemoryMiss(db, "p", "ancient miss", now - 40 * 86_400_000);
    const again = missCurriculum(db, 30, now);
    out.n1421 = { two, three: again.find((row) => row.projectId === "p")?.count, ancient: again.some((row) => row.query === "ancient miss") };
  }

  // n1422 / n1424: the MEMORY.md budget line, and no output at all when there is nothing to say.
  {
    const home = tmp("r18-mem-"); const bb = stubBb(home, {});
    const project = (lines: number) => { const cwd = tmp("r18-memproj-"); writeFileSync(join(cwd, "MEMORY.md"), `${Array.from({ length: lines - 1 }, (_, i) => `line ${i}`).join("\n")}\n`); return cwd; };
    const quiet = hook({ hook_event_name: "SessionStart", session_id: "mq", cwd: tmp("r18-nomem-") }, home, { BB_CLI: bb });
    out.n1422 = { mid: ctxText(hook({ hook_event_name: "SessionStart", session_id: "m1", cwd: project(100) }, home, { BB_CLI: bb }).stdout), full: ctxText(hook({ hook_event_name: "SessionStart", session_id: "m2", cwd: project(180) }, home, { BB_CLI: bb }).stdout) };
    out.n1424 = { quietStdout: quiet.stdout, quietStatus: quiet.status, spoken: JSON.parse(hook({ hook_event_name: "SessionStart", session_id: "m3", cwd: project(100) }, home, { BB_CLI: bb }).stdout).hookSpecificOutput.hookEventName };
  }

  // n1425: a stored note is found by its words at once, before any vector exists.
  {
    const { db } = open();
    storeMemoryRecordsKeepingOverflow(db as never, { projectId: "P", audience: "subagent", sourceSha256: "a".repeat(64), entries: [{ kind: "note", content: "The zorblax reconciler prunes stale lease rows hourly", concepts: ["janitor"] }], coreBudget: 3072, noteBudget: 24000, indexBudget: 65536 });
    out.n1425 = searchMemoryRecords(db as never, "P", "zorblax", 5, "auto").map((row: { content: string }) => row.content);
  }

  // n1429: a Task spawn is born with the project's rules, the window's claims and the lessons.
  {
    const home = tmp("r18-pretask-");
    const bb = stubBb(home, { "subagent-pack": '{"rules":["always run vitest"],"lessons":["the lockfile is generated"]}' });
    hook({ hook_event_name: "PostToolUse", session_id: "pt1", tool_name: "Edit", tool_input: { file_path: "src/claimed.ts" }, tool_response: "ok", cwd: home }, home);
    const ran = hook({ hook_event_name: "PreToolUse", session_id: "pt1", tool_name: "Task", tool_input: { subagent_type: "general-purpose", prompt: "explore the repo" }, cwd: home }, home, { BB_CLI: bb });
    const prompt = (JSON.parse(ran.stdout) as { hookSpecificOutput: { updatedInput: { prompt: string } } }).hookSpecificOutput.updatedInput.prompt;
    out.n1429 = { status: ran.status, rules: prompt.includes("Rules: always run vitest"), lessons: prompt.includes("Lessons: the lockfile is generated"), claim: prompt.includes("Files this window claims: src/claimed.ts") };
  }

  // n1430: PreCompact writes the flight capsule: each list in its own field.
  {
    const home = tmp("r18-pc-");
    const ran = hook({ hook_event_name: "PreCompact", session_id: "pc1", cwd: home, asks: ["keep the contract"], files: ["src/touched.ts"], claims: ["src/claimed.ts"] }, home);
    const capsule = JSON.parse(readFileSync(join(home, ".lane-pilot/session-hooks/pc1/capsule.json"), "utf8")) as Record<string, unknown>;
    out.n1430 = { status: ran.status, stdout: ran.stdout, asks: capsule.asks, files: capsule.files, claims: capsule.claims, trigger: capsule.trigger };
  }

  // n1431: a path the subagent says it wrote that the tree does not have is named; a path the tree has is not.
  {
    const home = tmp("r18-sv-");
    writeFileSync(join(home, "present.ts"), "x\n");
    const ran = hook({ hook_event_name: "SubagentStop", session_id: "sv1", cwd: home, claimed: ["missing/ghost.ts", "present.ts"], changed: [] }, home);
    const receipt = JSON.parse(readFileSync(join(home, ".lane-pilot/session-hooks/sv1/receipts.jsonl"), "utf8").trim()) as { subagent_receipt: { missing: string[] } };
    out.n1431 = { status: ran.status, text: ctxText(ran.stdout), missing: receipt.subagent_receipt.missing };
  }
  return out;
}

process.stdout.write(`${JSON.stringify(await main())}\n`); // the probe's one result line
