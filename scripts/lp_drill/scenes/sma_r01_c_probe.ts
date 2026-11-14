// Probe of scenes/sma_r01_c.py (region 1, batch c): runs the real nodes of the attempt's life (the working copy, the launch, the prompts, the session, its ends)
// of THIS checkout on scratch repositories and a scratch database and prints what they returned as one JSON line. It judges nothing: the scene compares each
// value with what the node's card expects and prove()s it. No model, no hub write, nothing outside the machine.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../../src/rooms/core/server/core";
import { claudeExecLine } from "../../../src/rooms/native-agent/native-claude-host";
import { MANDATORY_MCP_SERVERS, effectiveGroup } from "../../../src/rooms/contracts/helper-context";
import { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS, WRITER_DISALLOWED_TOOLS } from "../../../src/rooms/native-agent/claude-guard-launch";
import { CONVEYOR_KEY, conveyorStartLine, setConveyor } from "../../../src/rooms/runs/conveyor";
import { isHeld } from "../../../src/rooms/runs/server/runs-pause";
import { createWorktree } from "../../../src/rooms/verification/git-integrate/worktree-lifecycle";
import { classifyManagedWorkspace, waitManagedWorktreeReady } from "../../../src/rooms/verification/routing";
import { candidatePath, createCandidates } from "../../../src/rooms/phase/server/candidate";
import { designGate, phaseFolder } from "../../../src/rooms/phase/logic/design";
import { nextAction } from "../../../src/rooms/phase/logic/next-action";
import type { Phase, PhaseRecord } from "../../../src/rooms/phase/logic";
import { createPhaseDriver } from "../../../tests/phase-driver";
import { noOptionalPlugins } from "../../../tests/optional-plugin-stubs";
import { contractSections, needsHumanQuestion, pendingWordPush, pendingWordTake, writerBriefSegments, taskNeedsBrowser } from "../../../src/rooms/writer/server/writer-task";
import { routeAttemptFailure } from "../../../src/rooms/writer/server/start-failure-route";
import { listOpenOwnerItems } from "../../../src/rooms/owner-waiting/items";
import { createWriterSkillPick } from "../../../src/rooms/writer/server/skill-pick";
import { similarWorksLines } from "../../../src/rooms/writer/server/writer-knowledge";
import { SKILL_CATALOG_BLOCK } from "../../../src/rooms/native-agent/skill-catalog";
import { createWriterUpdateTask } from "../../../src/rooms/writer/server/update-task";
import { createAttemptReopen, contractFixTurnPrompt } from "../../../src/rooms/writer/server/reopen-attempt";
import { repeatedCallOf, sweepWriterSilence, writerFrame } from "../../../src/rooms/writer/server/writer-silence";
import { gitUndoCheckWrites } from "../../../src/rooms/host-worker/handlers/git";
import { acceptanceProofGap } from "../../../packages/contracts/src/stage-proof";
import { sha256Hex } from "@lane-pilot/kit";
import { saveProjectSetting } from "../../../src/rooms/storage";
import { getPhase, savePhase } from "../../../src/rooms/phase/store";
import { openDatabase } from "../../../src/rooms/plugin-db";
import {
  createAttempt, createRun, createTask, getAttempt, getReasoningTrace, noteAttemptStream, savePrototypeConfig,
  saveReasoningTrace, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt,
} from "../../../src/rooms/storage";
import { ATTEMPT_STREAM_EXCERPT_CHARS } from "../../../src/rooms/storage/attempts-store/reasoning";
import type { TaskV2 } from "../../../src/rooms/contracts";
import { HOST, WS, config, git, scratchRepo, taskOf } from "../../../tests/sma/r01-world-c";

const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 400) }; }
};
const hostOf = () => ({ call: async (method: string, input: Record<string, unknown>) => {
  if (method !== "runCommand") return {};
  const ran = spawnSync("sh", ["-c", String(input.command)], { cwd: String(input.cwd), encoding: "utf8" });
  return { hostId: HOST, exitCode: ran.status ?? -1, stdout: ran.stdout, stderr: ran.stderr };
} });
const phaseAt = (record: PhaseRecord, stage: Phase["stage"] = "design"): Phase => ({
  id: "ph_c", projectId: "p", pmThreadId: "t", runId: "r", title: "Hud", goal: "a hud", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

function runWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: Array<{ threadId: string; mode?: string; text: string }> = [];
  harness.sdk.stub("threads.listRunning", async () => []);
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.send", async (args: { threadId: string; mode?: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, mode: args.mode, text: args.input[0]!.text }); return undefined; });
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
  harness.sdk.stub("files.write", async () => ({}));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", "/ws");
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const task = taskOf("T1");
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(db, "T1", "Plan for T1");
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
  setAttemptWorkspace(db, "a1", { path: "/wt/T1", environmentId: null, decision: {} });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  return { bb, harness, db, ctx, sent, task };
}

type Settings = { permissions?: { deny?: string[]; allow?: string[] }; hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
function launch(role: string, layer: unknown, person: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "sma-r01c-personal-"));
  mkdirSync(join(dir, "hooks"), { recursive: true });
  mkdirSync(join(dir, "cfg"), { recursive: true });
  writeFileSync(join(dir, "hooks", "guard_shell.py"), "x");
  writeFileSync(join(dir, "guard.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `python3 ${dir}/hooks/guard_shell.py` }] }] } }));
  writeFileSync(join(dir, "layer.json"), JSON.stringify(layer));
  writeFileSync(join(dir, "cfg", "settings.json"), JSON.stringify(person));
  writeFileSync(join(dir, "show.sh"), `#!/bin/sh\nprintf 'ARGS:%s\\n' "$*"\nwhile [ $# -gt 0 ]; do if [ "$1" = "--settings" ]; then cat "$2"; fi; shift; done\n`);
  chmodSync(join(dir, "show.sh"), 0o755);
  const ran = spawnSync("sh", ["-c", claudeExecLine(join(dir, "show.sh"), join(dir, "guard.json")), "sh", "--settings", join(dir, "layer.json")], {
    encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: role, CLAUDE_CONFIG_DIR: join(dir, "cfg") },
  });
  const [first, ...rest] = ran.stdout.split("\n");
  const merged = JSON.parse(rest.join("\n") || "{}") as Settings;
  return { dir, status: ran.status, stderr: ran.stderr, args: first!.slice("ARGS:".length), merged, commands: (merged.hooks?.PreToolUse ?? []).flatMap((group) => group.hooks.map((hook) => hook.command)) };
}

async function main() {
  // n222: the copy stands on the named commit, on its own lane/<name> branch; the founder's tree is untouched.
  await step("n222", async () => {
    const { dir, base, first, second } = scratchRepo();
    const target = join(dir, "wt", "app", "lpattempt_c1");
    const made = await createWorktree({ basePath: base, targetPath: target, name: "lpattempt_c1", commit: first });
    return { made: { status: made.status, branch: made.branch, baseSha: made.baseSha }, first, bThere: existsSync(join(target, "b.txt")), laneBranch: git(base, "rev-parse", "lane/lpattempt_c1"),
      founderHead: git(base, "rev-parse", "HEAD"), second, founderStatus: git(base, "status", "--porcelain") };
  });
  // n223: a refused copy parks the attempt blocked and puts one owner item before the person.
  await step("n223", async () => {
    const { db } = (() => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return { db: openDatabase(bb) }; })();
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "task.copy", runId: "run1", kind: "bb", contract: taskOf("task.copy") });
    const refuse = async (attemptId: string, reason: string) => {
      createAttempt(db, { id: attemptId, runId: "run1", taskId: "task.copy" });
      transitionAttempt(db, attemptId, "spawn_requested");
      transitionAttempt(db, attemptId, "spawn_rejected", { reason });
      const state = { attemptId, last: { status: "spawn_rejected", reason } } as never;
      const deps = { ctx: { bb: {}, db, host: {}, log: () => undefined }, services: {} } as never;
      return routeAttemptFailure(deps, state, { projectId: "proj1", runId: "run1", taskId: "task.copy" } as never,
        { failedBinding: null, redo: {} as never, sessionEnd: null, streamHandOff: false, turn: { failure: null, diff: null, streamError: false } } as never);
    };
    const result = await refuse("a1", "attempt_worktree_failed:path already exists");
    await refuse("a2", "attempt_worktree_failed:path already exists");
    const items = listOpenOwnerItems(db, { kind: "copy_refused" });
    return { result, attempt: getAttempt(db, "a1")?.state, items: items.length, what: items[0]?.what, why: items[0]?.why };
  });
  // n224: a copy the daemon left failed is refused before launch; a ready one is taken.
  await step("n224", async () => {
    let clock = 0;
    const refused = await waitManagedWorktreeReady({ threadId: "thr", expectedHostId: "host-1", getThread: async () => ({ environmentId: "env-1" }), getEnvironment: async () => ({ status: "failed" }),
      now: () => clock, sleep: async () => { clock += 1_000; }, timeoutMs: 5_000 } as never).then(() => "taken", (error: Error) => error.message);
    const taken = await waitManagedWorktreeReady({ threadId: "thr", expectedHostId: "host-1", getThread: async () => ({ environmentId: "env-1" }),
      getEnvironment: async () => ({ id: "env-1", status: "ready", hostId: "host-1", managed: true, workspaceProvisionType: "managed-worktree", path: "/work/repo" }),
      now: () => 0, sleep: async () => {}, timeoutMs: 5_000 } as never);
    return { destroyed: classifyManagedWorkspace({ status: "destroyed" } as never, "host-1").kind, refused, taken };
  });
  // n225: a phase's verify copy lives on phase/<id> inside the base checkout's .git.
  await step("n225", async () => {
    const { base, second } = scratchRepo();
    const candidates = createCandidates(hostOf() as never, HOST, { warn: () => undefined } as never);
    const tree = await candidates.ensure(base, "ph_c1");
    return { tree, expectedPath: candidatePath(base, "ph_c1"), branch: git(`${base}/.git/lp-phases/ph_c1`, "rev-parse", "--abbrev-ref", "HEAD"), second, baseStatus: git(base, "status", "--porcelain", "--untracked-files=all") };
  });
  // n226: a task that follows a drawing names its files as the first input line.
  await step("n226", () => ({
    drawn: contractSections(taskOf("d1", { drawing: ["design/ph/UI-SPEC.md", "design/ph/main.png"] }), false).inputs.split("\n").filter((line) => line.startsWith("drawing:")),
    plain: contractSections(taskOf("d2"), false).inputs.split("\n").filter((line) => line.startsWith("drawing:")),
  }));
  // n230: the person's deny rules ride into a helper's settings, never the person's allow list nor user-level hooks.
  await step("n230", () => {
    const layer = { permissions: { deny: ["Bash(rm -rf /)"] }, hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "python3 /definitely/missing/person-hook.py" }] }] } };
    const person = { permissions: { deny: ["Bash(rm -rf /)", "Read(~/.ssh/**)"], allow: ["Bash(ls)"] } };
    const helper = launch("writer", layer, person);
    const pm = launch("pm", layer, person);
    return { status: helper.status, deny: helper.merged.permissions?.deny, allow: helper.merged.permissions?.allow ?? null, userSourceOff: helper.args.includes("--setting-sources=project,local"),
      commands: helper.commands.map((c) => c.replace(helper.dir, "<dir>")), dropped: helper.stderr.includes("/definitely/missing/person-hook.py does not exist"), pmDeny: pm.merged.permissions?.deny, pmHooks: pm.commands.length };
  });
  // n231: a role's connections plus the mandatory ones; an owner's list replaces the role's, keeps the mandatory.
  await step("n231", () => ({
    mandatory: MANDATORY_MCP_SERVERS, writer: effectiveGroup("writer", "mcpServers"),
    owner: effectiveGroup("writer", "mcpServers", { mcpServers: { mode: "allow", names: ["context7"] } }), all: effectiveGroup("writer", "mcpServers", { mcpServers: { mode: "all" } }),
  }));
  // n232: a switched-off conveyor holds every run; switching on lets them go.
  await step("n232", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
    const before = await isHeld(kv as never, "run1");
    const off = await setConveyor(kv, false, "maintenance");
    const heldOff = [await isHeld(kv as never, "run1"), await isHeld(kv as never, "run2")];
    const line = conveyorStartLine(off);
    await setConveyor(kv, true);
    return { before, heldOff, reason: off.reason, line: line?.replace(String(off.since), "<since>") ?? null, after: await isHeld(kv as never, "run1"), keyAfter: store.get(CONVEYOR_KEY) ?? null };
  });
  // n234: a UI task's writer gets the browser skill, a plain one does not.
  await step("n234", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("skills.list", async () => ({ skills: [] }));
    const pick = createWriterSkillPick({ bb, host: { call: async () => ({}) } } as never);
    const ui = taskOf("ui-task", { qa_url: "http://localhost:3000/page", owns_paths: ["src/page.vue"] });
    const plain = taskOf("plain-task", { owns_paths: ["src/logic.ts"] });
    const chosen = await pick.pick({ attemptId: "a1", projectId: "proj1", hostId: HOST, projectCwd: WS, task: ui } as never);
    const plainChosen = await pick.pick({ attemptId: "a2", projectId: "proj1", hostId: HOST, projectCwd: WS, task: plain } as never);
    await harness.lifecycle.dispose();
    return { ui: chosen.skills, plain: plainChosen.skills, uiNeeds: taskNeedsBrowser(ui), plainNeeds: taskNeedsBrowser(plain) };
  });
  // n235: a brief carries at most five accepted similar works and no blocked one.
  await step("n235", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "p1");
    const contract = taskOf("t1", { project_cwd: "/w", title: "Экспорт отчётов в CSV ломается", display_title: "Экспорт отчётов в CSV", objective: "починить экспорт CSV в отчётах", expected_outputs: ["docs updated"], verification: [] });
    for (let index = 0; index < 9; index++) {
      const taskId = `old-${index}`;
      createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: { ...contract, id: taskId, title: `Экспорт отчётов в CSV ломается ${index}`, display_title: `Экспорт отчётов ${index}` } });
      const attemptId = `a-old-${index}`;
      createAttempt(db, { id: attemptId, runId: "run1", taskId });
      transitionAttempt(db, attemptId, "spawn_requested");
      transitionAttempt(db, attemptId, "running", { threadId: "thr" });
      transitionAttempt(db, attemptId, index < 7 ? "accepted" : "blocked", { reason: "nope" });
      const { upsertAttemptChange } = await import("../../../src/rooms/rollback/store");
      upsertAttemptChange(db, { attemptId, runId: "run1", taskId }, { outcome: "merged", mergeCommit: "m", changed: [{ path: `src/f${index}.ts`, status: "modified" }] } as never);
    }
    const text = await similarWorksLines({ db, host: {} as never, chainForRun: async () => [], log: () => undefined } as never,
      { projectId: "p1", runId: "run1", hostId: "h", task: { ...contract, id: "new-task" } as TaskV2, memorySettings: { contextBudget: 3000 } as never }, async () => ({ approach: "через поток записи" }));
    return { listed: (text.match(/«/g) ?? []).length, blocked: text.includes("old-7") || text.includes("old-8"), approach: text.includes("через поток записи") };
  });
  // n237: the launch line carries the turn ceiling as a whole number and the writer's full deny list; a PM's has neither.
  await step("n237", () => {
    const line = (role: string, extra: Record<string, unknown> = {}) => claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role, agentType: role, ...extra } as never);
    const writer = line("writer", { maxTurns: 150.7 });
    const pm = line("pm");
    return { turns: /--max-turns (\d+)/.exec(writer)?.[1] ?? null, denyList: writer.includes(`--disallowedTools '${HELPER_DISALLOWED_TOOLS},${WRITER_DISALLOWED_TOOLS}'`), pmTurns: pm.includes("--max-turns"), pmDeny: pm.includes("--disallowedTools") };
  });
  // n238 / n239: the PM's text at the design stage.
  await step("n238", () => {
    const folder = phaseFolder("ph_c");
    const first = nextAction(phaseAt({ design: { decision: "needed", why: "pieces that change screens: hud" } }), new Map()).text.split("\n")[0];
    const drawn = nextAction(phaseAt({ design: { decision: "needed", why: "screens", drawing: { paths: [`${folder}/design/UI-SPEC.md`], sha256: "x", designer: "lp.draw", feasible: true, reviewer: "lp.draw" } } }), new Map()).text;
    return { first, drawnHasNoDesignerLine: !drawn.includes("Do not start a designer") };
  });
  await step("n239", () => {
    const record = (feasible: boolean | undefined, over: Record<string, unknown> = {}): PhaseRecord => ({ design: { decision: "needed", why: "screens",
      drawing: { paths: [`${phaseFolder("ph_c")}/design/UI-SPEC.md`], sha256: "x", designer: "lp.draw", reviewer: "ui-review", ...(feasible === undefined ? {} : { feasible }), ...over } } }) as PhaseRecord;
    return { shape: nextAction(phaseAt(record(true)), new Map()).text.includes('lane_pilot_phase {action:"drawing", phaseId:"ph_c", paths:[...], designer, feasible:true|false, contradiction?, reviewer}'),
      none: designGate(record(undefined)), contradiction: designGate(record(false, { contradiction: "the bar cannot be both fixed and scrolling" })), ok: designGate(record(true)) };
  });
  // n240: the brief names the writer's role and either the picked skills or the catalog.
  await step("n240", () => {
    const task = taskOf("w1");
    const picked = writerBriefSegments(task, "memory: a.ts is the entry", "FILE src/a.ts\nexport const a = 1;", undefined, "Lane Pilot writer", "", "", "", null, false, { skills: ["lp-writer", "browser-automation"] })[0]!;
    const broad = writerBriefSegments(task, "", "", undefined, "Lane Pilot writer", "", "", "", null, false, { broadSkills: true })[0]!;
    return { first: picked.text.split("\n")[0], skillsLine: picked.text.split("\n").includes("Your skills for this task: lp-writer, browser-automation."), pickedCatalog: picked.text.includes(SKILL_CATALOG_BLOCK),
      broadCatalog: broad.text.includes(SKILL_CATALOG_BLOCK), broadSkillsLine: broad.text.includes("Your skills for this task:") };
  });
  // n241: a drawing edited after the owner's yes does not launch.
  await step("n241", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.get", async () => ({ id: "thr_w", status: "idle" }));
    harness.sdk.stub("threads.send", async () => undefined);
    harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WS);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    const services = { activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins, startWriterTask: () => undefined, workflowEngine: null } as never;
    const shas = new Map<string, string>();
    const bag = services as unknown as Record<string, unknown>;
    bag.readWriterWorkspaceFile = async ({ path }: { path: string }) => ({ sha256: shas.get(path) ?? sha256Hex(`${path}:v1`), sizeBytes: 100, content: "x" });
    const dispatched: string[] = [];
    bag.dispatchWriter = async () => { dispatched.push("x"); return { ok: true, taskId: "t1" }; };
    bag.runBudgets = { get: () => undefined };
    const { phases } = createPhaseDriver(ctx as never, services);
    saveProjectSetting(db, "proj1", "owner.words", "on");
    const phase = await phases.open({ projectId: "proj1", pmThreadId: "thr_pm", title: "Draw", goal: "g" });
    const drawingPath = `.agents/phases/${phase.id}/design/UI-SPEC.md`;
    const drawingSha = sha256Hex(`${drawingPath}:${sha256Hex(`${drawingPath}:v1`)}`);
    const record: PhaseRecord = { ownerWords: true,
      plan: { items: [{ id: "p1", title: "piece", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: taskOf("t1") as never }], sha: "plansha", contextSha: "c", admittedSha: "plansha" },
      design: { decision: "needed", why: "ui", drawing: { paths: [drawingPath], sha256: drawingSha, designer: "d", reviewer: "r", feasible: true } },
      candidate: { branch: "ph", trees: {}, off: "no writer host" } as never,
      words: [{ turn: "design", decision: "yes", by: "owner", text: "да", at: 1, key: drawingSha }, { turn: "issue", decision: "yes", by: "owner", text: "да", at: 2, key: "plansha" }] };
    savePhase(db, phase.id, { stage: "execution", record, state: "active", at: Date.now() });
    shas.set(drawingPath, sha256Hex(`${drawingPath}:v2`));
    await phases.drive(getPhase(db, phase.id)!);
    const parts = db.prepare("SELECT text FROM lane_pilot_phase_part WHERE phase_id=? AND kind='stale_consent'").all(phase.id) as Array<{ text: string }>;
    return { dispatched: dispatched.length, staleNotes: parts.length, note: parts[0]?.text.includes("changed since it was recorded") ?? false };
  });
  // n243: what a session said is kept masked and bounded.
  await step("n243", () => {
    const w = runWorld();
    saveReasoningTrace(w.db, { planSha256: "p", sourceLength: 1, jevStatus: "ok", jevDecision: null, requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null,
      providerId: "p", model: "wm", runId: "run1", attemptId: "a1", threadId: "thr_w" } as never);
    const secret = `ghp_${"a1B2".repeat(9)}`;
    const text = `${"x".repeat(ATTEMPT_STREAM_EXCERPT_CHARS - 10)} token ${secret} and more words after it`;
    noteAttemptStream(w.db, "a1", text);
    const stream = (getReasoningTrace(w.db, "a1") as { stream?: { chars: number; sha256: string; excerpt: string } }).stream!;
    return { charsMatch: stream.chars === text.length, bounded: stream.excerpt.length <= ATTEMPT_STREAM_EXCERPT_CHARS, leaked: stream.excerpt.includes("ghp_") || stream.excerpt.includes("a1B2a1B2"), hash: /^[0-9a-f]{64}$/.test(stream.sha256) };
  });
  // n244 / n246: the PM's note reaches a running writer now or at its next turn; a note it could not take rides the next brief once.
  await step("n244", async () => {
    const w = runWorld();
    const services = { activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins, startWriterTask: () => undefined, workflowEngine: null } as never;
    const { updateTask } = createWriterUpdateTask(w.ctx, services);
    const input = { projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "T1" };
    const now = await updateTask({ ...input, note: "use the cached list", when: "now" });
    await updateTask({ ...input, note: "and log the ids", when: "next_turn" });
    return { delivered: now.delivered, modes: w.sent.map((row) => row.mode), thread: w.sent[0]?.threadId, state: getAttempt(w.db, "a1")?.state };
  });
  await step("n246", async () => {
    const w = runWorld();
    w.harness.sdk.stub("threads.send", async () => { throw new Error("thread gone"); });
    const services = { activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins, startWriterTask: () => undefined, workflowEngine: null } as never;
    const { updateTask } = createWriterUpdateTask(w.ctx, services);
    const done = await updateTask({ projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "T1", note: "acceptance: also cover empty input", when: "now" });
    const kv = w.bb.storage.kv as never;
    const first = await pendingWordTake(kv, "run1", "T1");
    return { delivered: done.delivered, first: first ?? null, second: (await pendingWordTake(kv, "run1", "T1")) ?? null };
  });
  // n245: a blocked writer's question is answered in its own thread; no new attempt.
  await step("n245", async () => {
    const w = runWorld();
    transitionAttempt(w.db, "a1", "blocked", { threadId: "thr_w", reason: "needs_human: which locale?" });
    const started: Array<Record<string, unknown>> = [];
    const reopen = createAttemptReopen(w.ctx, { activeWriterTasks: new Set<string>(), startWriterTask: (arg: Record<string, unknown>) => { started.push(arg); } } as never);
    const attempt = getAttempt(w.db, "a1")!;
    const turn = contractFixTurnPrompt({ question: "which locale?", changes: [{ field: "acceptance", from: ["done"], to: ["done in ru"] }] });
    const result = await reopen.reopenAttempt({ projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: "thr_pm", attempt, threadId: "thr_w", workspacePath: "/ws", config, contract: w.task, reason: "answered", turn, qaAnswer: "ru" });
    return { result, sentTo: w.sent.map((row) => row.threadId), carries: w.sent[0]?.text.includes('- acceptance: ["done"] → ["done in ru"]') ?? false, state: getAttempt(w.db, "a1")?.state, thread: getAttempt(w.db, "a1")?.thread_id,
      restarts: started.length, writerThreadId: started[0]?.writerThreadId, turnSent: started[0]?.turnSent, attempts: (w.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_attempt WHERE task_id='T1'").get() as { n: number }).n };
  });
  // n247: a dangerous call is refused and a ticket is filed once; the PM's grant lets the same command through once.
  await step("n247", () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01c-ticket-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sma-r01c-ticket-cwd-")));
    const call = (command: string) => spawnSync("python3", [join(process.cwd(), "lane-stack/hooks/guard_shell.py")], {
      encoding: "utf8", input: JSON.stringify({ agent_type: "writer", tool_name: "Bash", tool_input: { command }, cwd, session_id: "sess_c" }),
      env: { PATH: process.env.PATH ?? "", AGENT_HOOK_CLIENT: "claude", HOME: home, LANE_PILOT_ROLE: "writer", LANE_PILOT_AGENT_TYPE: "writer" },
    });
    const dir = join(home, ".agents", "permits", "sess_c");
    const tickets = () => { try { return readdirSync(dir).filter((name) => name.endsWith(".ticket.json")); } catch { return []; } };
    const first = call("rm data.csv");
    const filed = tickets();
    const again = call("rm data.csv");
    const afterAgain = tickets().length;
    const digest = filed[0]?.replace(".ticket.json", "") ?? "";
    writeFileSync(join(dir, `${digest}.answer.json`), JSON.stringify({ decision: "allow", at: Date.now() / 1000 + 1 }));
    const granted = call("rm data.csv");
    const reused = call("rm data.csv");
    return { firstRefused: first.status !== 0, filed: filed.length, told: first.stdout.includes(`Permit ticket ${digest} is filed`), againRefused: again.status !== 0, afterAgain,
      grantedOk: granted.status === 0 && granted.stdout === "", used: (JSON.parse(readFileSync(join(dir, `${digest}.answer.json`), "utf8")).used ?? 0) > 0, reusedRefused: reused.status !== 0 };
  });
  // n250: files the checks wrote outside owns_paths are undone; the task's own and the listed ones stay.
  await step("n250", async () => {
    const { base } = scratchRepo();
    mkdirSync(join(base, "src"), { recursive: true });
    mkdirSync(join(base, "docs"), { recursive: true });
    writeFileSync(join(base, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(base, "docs", "x.md"), "original\n");
    git(base, "add", "-A");
    git(base, "commit", "-qm", "files");
    writeFileSync(join(base, "docs", "x.md"), "changed by a check\n");
    mkdirSync(join(base, "reports"), { recursive: true });
    writeFileSync(join(base, "reports", "out.js"), "built\n");
    writeFileSync(join(base, "src", "new.ts"), "export const n = 1;\n");
    writeFileSync(join(base, "docs", "keep.txt"), "kept by the caller\n");
    const result = await gitUndoCheckWrites({ requestedHostId: "h", projectCwd: base, keep: ["docs/keep.txt"], ownsPaths: ["src/"], neverTouch: [], bookkeeping: [] } as never, {} as never) as { reverted: string[]; failed: string[] };
    return { reverted: [...result.reverted].sort(), failed: result.failed, restored: readFileSync(join(base, "docs", "x.md"), "utf8"), reportGone: !existsSync(join(base, "reports", "out.js")),
      own: readFileSync(join(base, "src", "new.ts"), "utf8"), kept: readFileSync(join(base, "docs", "keep.txt"), "utf8") };
  });
  // n254: frames read closed, spinning and progressing, and a spinning writer is nudged.
  await step("n254", async () => {
    const cmd = (n: number, command = "npm test") => ({ type: "item/completed", createdAt: Date.now() - n * 1000, data: { item: { type: "commandExecution", command } } });
    const fileChange = { type: "item/completed", createdAt: Date.now(), data: { item: { type: "fileChange", changes: {} } } };
    const six = [1, 2, 3, 4, 5, 6].map((n) => cmd(n));
    const sent: string[] = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const deps = {
      bb: { sdk: { threads: { send: async (args: never) => { sent.push(JSON.stringify(args)); return {}; }, events: { list: async () => six } } }, storage: { kv: bb.storage.kv } },
      openAttempts: () => [{ id: "a1", run_id: "run1", task_id: "t1", thread_id: "thr_w", state: "running", project_id: "proj1", pm_thread_id: "thr_pm" }],
      getThread: async () => ({ status: "active" }), silenceMinutes: () => 20, isDisposed: () => false, waitingForOwner: async () => false, log: () => undefined,
    };
    const swept = await sweepWriterSilence(deps as never);
    return { spinning: writerFrame(six), progressing: writerFrame([cmd(1), fileChange, ...six]), closed: writerFrame([{ type: "turn/completed", createdAt: Date.now() }, ...six]),
      named: String(repeatedCallOf(six)).includes("npm test"), swept, nudgeNamesCall: sent.some((line) => line.includes("npm test")) };
  });
  // n255: a work is accepted only on a stage decided by code.
  await step("n255", () => ({
    advisory: acceptanceProofGap(["code-critique"]), none: acceptanceProofGap([]), verification: acceptanceProofGap(["verification"]),
    receipt: acceptanceProofGap(["acceptance-receipt", "pm-read"]), mixed: acceptanceProofGap(["code-critique", "verification"]),
  }));
  console.log(JSON.stringify(out)); // guardian: allow
}

main().then(() => process.exit(0), (error) => { console.log(JSON.stringify({ fatal: String(error) })); /* guardian: allow */ process.exit(0); });
