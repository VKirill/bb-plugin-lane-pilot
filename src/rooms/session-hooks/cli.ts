/**
 * Fail-open session hook for a native Claude session Lane Pilot launches.
 * A hook never wedges a session: failOpen swallows errors and the process exits 0.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync as appendFileRaw, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync as writeFileRaw } from "node:fs";
import type { WriteFileOptions } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
// node --experimental-strip-types resolves this file only with a .ts specifier.
// @ts-expect-error TS5097
import { buildCapsule, capsuleDetails, claimedPaths, claimedState, codeMapDrift, draftTarget, EDIT_TOOLS, failOpen, hookOutput, injectPack, ledgerAddAsk, ledgerAddCommand, ledgerAddFile, ledgerOf, maskText, pmSkillUseOf, pretaskDecision, progressRecord, promptRecall, protectionsOff, runStreams, sessionEndDraft, sessionStartText, stallObserve, subagentVerify, subagentVerifyText, treeVerifyText, type Capsule, type ClaimedState, type PmSkillUse, type SessionLedger, type ToolCtx } from "./logic.ts";
// @ts-expect-error TS5097
import { appendTouch, buildCatalog, cardNotes, findRepo, startCatalogBuild } from "../file-cards/index.ts";

type Payload = Record<string, unknown>;

// What a session writes can quote the person's prompt: its files are the owner's alone (0600, folders 0700).
const writeFileSync = (path: string, data: string, options?: WriteFileOptions): void => writeFileRaw(path, data, { mode: 0o600, ...(typeof options === "object" && options ? options : {}) });
const appendFileSync = (path: string, data: string): void => appendFileRaw(path, data, { mode: 0o600 });

function readStdin(): string {
  try { return readFileSync(0, "utf8"); }
  catch { return ""; }
}

const SESSIONS_ROOT = () => join(homedir(), ".lane-pilot", "session-hooks");

/** The session's folder name. guard_shell.py's _session_dir_name applies the same rule; a dot-only id would climb out of the folder. */
function stateName(session: string): string {
  const name = session.replace(/[^\w.-]/g, "_");
  return !name || /^\.+$/.test(name) ? "session" : name;
}

function stateDir(session: string): string {
  const dir = join(SESSIONS_ROOT(), stateName(session));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The state folders of finished sessions never went away; a session start removes at most 50 whose newest file is over 30 days old. Silent. */
function pruneOldSessions(keep: string): void {
  try {
    const root = SESSIONS_ROOT();
    const cutoff = Date.now() - 30 * 86_400_000;
    let removed = 0;
    for (const name of readdirSync(root)) {
      if (removed >= 50) break;
      if (name === keep || !/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) continue;
      try {
        const full = join(root, name);
        const folder = lstatSync(full);
        if (!folder.isDirectory() || folder.mtimeMs > cutoff) continue;
        let newest = folder.mtimeMs;
        for (const file of readdirSync(full)) newest = Math.max(newest, lstatSync(join(full, file)).mtimeMs);
        if (newest > cutoff) continue;
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      } catch { /* one folder that cannot be read or removed is left */ }
    }
  } catch { /* nothing to prune */ }
}

/** A session's perf.jsonl past 256 KB keeps its newest 500 lines. */
function appendPerf(dir: string, row: unknown): void {
  const file = join(dir, "perf.jsonl");
  try {
    if (statSync(file).size > 256 * 1024) writeFileSync(file, `${readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-500).join("\n")}\n`);
  } catch { /* no file yet */ }
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return fallback; }
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8").trim(); }
  catch { return ""; }
}

function emit(value: Record<string, unknown> | null): void {
  if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
}

function toolName(payload: Payload): string {
  return String(payload.tool_name ?? payload.tool ?? "");
}

function toolInput(payload: Payload): Record<string, unknown> {
  const input = payload.tool_input ?? payload.toolInput;
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

/** The session's running ledger (SMA k_hpc_progress): what it touched, ran and asked, restored after compaction. */
function ledgerPath(dir: string): string {
  return join(dir, "ledger.json");
}

/**
 * The ledger as the file holds it; null when the file is there but does not parse (a read that raced a write): the caller then
 * skips its update instead of writing a ledger that drops what was there. A file that stays unreadable for 10 s is corrupt, not racing: it counts as empty.
 */
function readLedgerFile(dir: string): SessionLedger | null {
  const file = ledgerPath(dir);
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? ledgerOf(null) : null; }
  try { return ledgerOf(JSON.parse(raw)); }
  catch {
    try { return Date.now() - statSync(file).mtimeMs > 10_000 ? ledgerOf(null) : null; } catch { return null; }
  }
}

/** For a reader: an unreadable ledger reads as empty (nothing is written back). */
function readLedger(dir: string): SessionLedger {
  return readLedgerFile(dir) ?? ledgerOf(null);
}

/** Read, change, write: an unreadable ledger is left alone. */
function updateLedger(dir: string, change: (ledger: SessionLedger) => SessionLedger): void {
  const current = readLedgerFile(dir);
  if (current) writeLedger(dir, change(current));
}

function writeLedger(dir: string, ledger: SessionLedger): void {
  // An empty ledger leaves no file: the state folder keeps only what the session did.
  if (!ledger.files.length && !ledger.commands.length && !ledger.asks.length) return;
  // Tool calls run in parallel: the file is replaced whole by a rename, a reader never sees half of it.
  const temp = `${ledgerPath(dir)}.${process.pid}.tmp`;
  try { writeFileSync(temp, JSON.stringify(ledger)); renameSync(temp, ledgerPath(dir)); }
  catch { try { unlinkSync(temp); } catch { /* nothing to clean */ } /* the ledger is best effort */ }
}

/** A lane-pilot verb from the hook, fail-open: stdout on a zero exit inside the budget, "" otherwise. */
function bbCall(args: string[], timeoutMs: number, cwd?: string): string {
  try {
    const ran = spawnSync(process.env.BB_CLI || "bb", args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", ...(cwd ? { cwd } : {}) });
    return ran.status === 0 ? (ran.stdout ?? "") : "";
  } catch { return ""; }
}

// Fire and forget: a PM's Skill call lands one row in lane_pilot_pm_skill_use. Never blocks the tool call.
/** One git call in the workspace, nothing on failure: the hook must answer inside its budget either way. */
function spawnSyncGit(cwd: string, args: string[], timeoutMs = 3000): string {
  try {
    const ran = spawnSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
    return ran.status === 0 ? (ran.stdout ?? "").trim() : "";
  } catch { return ""; }
}

function reportPmSkill(row: PmSkillUse): void {
  try {
    const args = ["lane-pilot", "pm-skill-use", row.skill, "--thread", row.thread];
    if (row.project) args.push("--project", row.project);
    const child = spawn(process.env.BB_CLI || "bb", args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* a lost row never wedges the session */ }
}

const SHA = /^[0-9a-f]{7,40}$/;

/** A folder keeps its `keep` newest files; the oldest go. */
function keepNewest(folder: string, keep: number, pattern: RegExp = /./): void {
  const files = readdirSync(folder).filter((name) => pattern.test(name)).map((name) => {
    try { return { name, at: statSync(join(folder, name)).mtimeMs }; } catch { return null; }
  }).filter((row): row is { name: string; at: number } => row !== null);
  if (files.length <= keep) return;
  for (const row of files.sort((a, b) => b.at - a.at).slice(keep)) {
    try { unlinkSync(join(folder, row.name)); } catch { /* one that cannot go stays */ }
  }
}

function handle(payload: Payload): void {
  const event = String(payload.hook_event_name ?? payload.hookEventName ?? "");
  const session = String(payload.session_id ?? payload.sessionId ?? "session");
  const dir = stateDir(session);
  const cwd = String(payload.cwd ?? "");
  if (event === "PreCompact") {
    // The payload's lists win; the session's ledger fills what Claude Code does not send (SMA k_hpc_progress, k_hpc_capsule).
    const ledger = readLedger(dir);
    const payloadList = (key: string): string[] => Array.isArray(payload[key]) ? payload[key].map(String) : [];
    const asks = payloadList("asks").length ? payloadList("asks") : ledger.asks;
    const files = payloadList("files").length ? payloadList("files") : ledger.files;
    const claims = payloadList("claims");
    // Only the tail of the transcript is read: a session's last 200 KB is where its decisions live.
    let transcriptTail = "";
    if (typeof payload.transcript_path === "string") {
      try {
        const fd = openSync(payload.transcript_path, "r");
        const start = Math.max(0, fstatSync(fd).size - 200 * 1024);
        const buf = Buffer.alloc(fstatSync(fd).size - start);
        readSync(fd, buf, 0, buf.length, start);
        closeSync(fd);
        transcriptTail = buf.toString("utf8");
      } catch { /* no transcript: the capsule keeps its ledger fields */ }
    }
    // The task is the session's first prompt: the ledger keeps it apart from the last five.
    const details = capsuleDetails({ firstPrompt: payloadList("asks").length ? asks[0] ?? "" : ledger.first ?? asks[0] ?? "", transcriptTail });
    const capsule = buildCapsule({ asks, files, claims, trigger: "precompact" });
    Object.assign(capsule, details, { commands: ledger.commands });
    writeFileSync(join(dir, "capsule.json"), JSON.stringify(capsule));
    const progress = progressRecord({ session, files: capsule.files.length, asks: capsule.asks.length, touched: capsule.files, commands: ledger.commands });
    appendFileSync(join(dir, "progress.jsonl"), `${JSON.stringify(progress)}\n`);
    return;
  }
  if (event === "SessionStart") {
    pruneOldSessions(stateName(session));
    const capsule = readJson<Capsule | null>(join(dir, "capsule.json"), null);
    let memoryLines = 0;
    const memoryPath = cwd ? join(cwd, "MEMORY.md") : "";
    if (memoryPath && existsSync(memoryPath)) memoryLines = readFileSync(memoryPath, "utf8").split("\n").length;
    // The code map's freshness (SMA k_wp_drift): .gitnexus/meta.json lastCommit against the checkout's HEAD.
    let codeMapBehind = 0;
    const metaRaw = readJson<{ lastCommit?: unknown } | null>(cwd ? join(cwd, ".gitnexus", "meta.json") : "/dev/null", null)?.lastCommit;
    // The sha comes from a file in the repository and goes into git's arguments: a plain hex sha or nothing.
    const metaCommit = typeof metaRaw === "string" && /^[0-9a-f]{7,40}$/.test(metaRaw) ? metaRaw : "";
    if (metaCommit && cwd) {
      try {
        const head = spawnSyncGit(cwd, ["rev-parse", "HEAD"]);
        const behind = head && head !== metaCommit ? Number(spawnSyncGit(cwd, ["rev-list", "--count", `${metaCommit}..HEAD`, "--"])) : 0;
        codeMapBehind = codeMapDrift(metaCommit, head, Number.isFinite(behind) ? behind : 0);
      } catch { /* a map that cannot be read stays silent */ }
    }
    // The coordination brief (SMA k_hss_summary, k_h_session_start): live and stale windows and a merge in
    // flight, from `bb lane-pilot session-brief`; its digest (SMA k_hss_digest) adds other windows' claims and
    // the weakly calibrated areas. A failure stays silent.
    const briefRaw = cwd ? bbCall(["lane-pilot", "session-brief", "--cwd", cwd, "--json"], 1500) : "";
    let summary = "";
    const changed: string[] = [];
    if (briefRaw) {
      try {
        const parsed = JSON.parse(briefRaw) as { summary?: string; foreign?: Array<{ taskId?: string; paths?: string[] }>; weak?: string[] };
        if (typeof parsed.summary === "string") summary = parsed.summary;
        for (const claim of (parsed.foreign ?? []).slice(0, 5)) changed.push(`claimed by another window: ${[claim.taskId, ...(claim.paths ?? [])].filter(Boolean).join(" ")}`);
        for (const area of (parsed.weak ?? []).slice(0, 5)) changed.push(`weakly calibrated area: ${area}`);
      } catch { /* a brief that is not JSON adds nothing */ }
    }
    // What moved in this checkout since the last start (SMA k_hss_digest): one head file per repository, not per
    // folder (every attempt worktree is a folder of its own), the newest 200 kept. The content is a sha or nothing.
    if (cwd) {
      try {
        const headsDir = join(SESSIONS_ROOT(), "heads");
        mkdirSync(headsDir, { recursive: true, mode: 0o700 });
        const repo = findRepo(cwd);
        let key = repo?.commonDir ?? cwd;
        try { key = realpathSync(key); } catch { /* an unresolvable path keys as it is */ }
        const headFile = join(headsDir, `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.txt`);
        const old = readText(headFile);
        const head = spawnSyncGit(cwd, ["rev-parse", "HEAD"]);
        if (SHA.test(head) && SHA.test(old) && old !== head) {
          const log = spawnSyncGit(cwd, ["log", "--oneline", `${old}..HEAD`, "--"]);
          changed.push(...log.split("\n").filter(Boolean).slice(0, 10));
        }
        if (SHA.test(head)) writeFileSync(headFile, head);
        keepNewest(headsDir, 200);
      } catch { /* a head that cannot be compared stays silent */ }
    }
    // Which protections are off (SMA k_h_session_start): only what the environment says. The guard comes from the
    // session's generated settings file, which this hook never reads, so «not registered» is not something it can know.
    const text = sessionStartText({
      summary,
      protections: protectionsOff(process.env),
      model: typeof payload.model === "string" ? payload.model : undefined,
      lastModel: readText(join(dir, "model.txt")),
      memoryLines,
      capsule,
      capsuleFirst: payload.source === "compact",
      changed,
      codeMapBehind,
    });
    if (typeof payload.model === "string") writeFileSync(join(dir, "model.txt"), payload.model);
    // A missing or stale file catalog is built in a detached background process; this hook returns at once (k_st_catalog).
    if (cwd) startCatalogBuild(cwd, process.argv[1] ?? "");
    emit(hookOutput(event, text));
    return;
  }
  if (event === "UserPromptSubmit") {
    const promptText = String(payload.prompt ?? "");
    updateLedger(dir, (ledger) => ledgerAddAsk(ledger, promptText));
    const state = readJson<{ given: string[] }>(join(dir, "recall.json"), { given: [] });
    // The prompt's own words search the project's confirmed memory (SMA k_h_prompt_recall, k_hpr_find): 3 words
    // or more, 1.2 s at most, a failure or «nothing relevant» stays silent. The words are masked before they are
    // an argument; `--recall` is the read-only word search (no embedding, no model, no network) and `--query` takes
    // the words as its value, so a prompt that starts with a dash is never read as an option. Hits are this prompt's only.
    const query = maskText(promptText.replace(/\s+/g, " ").trim().slice(0, 300));
    let hits: Array<{ id: string; content: string }> = [];
    if (query.split(" ").length >= 3) {
      const found = bbCall(["lane-pilot", "memory", "search", "--recall", ...(cwd ? ["--cwd", cwd] : []), "--query", query], 1200, cwd || undefined);
      if (found && !found.includes("nothing relevant")) {
        hits = found.split("\n").map((line) => /^- \[([^\]]+)\]\s*(.+)$/.exec(line))
          .filter((row): row is RegExpExecArray => row !== null)
          .map((row) => ({ id: row[1]!, content: row[2]! }));
      }
    }
    const next = promptRecall({ hits, given: Array.isArray(state.given) ? state.given.map(String) : [], query });
    writeFileSync(join(dir, "recall.json"), JSON.stringify({ given: next.given, hits }));
    emit(hookOutput(event, next.text));
    return;
  }
  if (event === "PreToolUse") {
    const name = toolName(payload);
    const input = toolInput(payload);
    if (name === "Task" || name === "Agent") {
      const spawned = readJson<number>(join(dir, "spawned.txt"), 0);
      // The machine's spend facts (SMA k_hs_spend): checked by pretaskDecision after its other refusals; `usage.skip_percent` 0 or unset by a person = no cap.
      const snap = readJson<{ at?: string; windows?: Array<{ label?: string; usedPercent: number; resetsAt?: string | null; model?: string | null }>; skipPercent?: number; skipSetByHuman?: boolean } | null>(join(homedir(), ".lane-pilot", "usage-snapshot.json"), null);
      // The pack's layers (SMA k_h_pretask): the window's touched files are its claims; rules and lessons come
      // from `bb lane-pilot subagent-pack`, a verb a project switches on (hook.subagent_pack) — 1 s, fail-open.
      const packStarted = Date.now();
      let layers: { rules: string[]; lessons: string[] } = { rules: [], lessons: [] };
      const packRaw = bbCall(["lane-pilot", "subagent-pack", String(input.prompt ?? "").slice(0, 300), "--cwd", cwd], 1000, cwd || undefined);
      if (packRaw) {
        try {
          const parsed = JSON.parse(packRaw) as { rules?: unknown; lessons?: unknown };
          layers = {
            rules: Array.isArray(parsed.rules) ? parsed.rules.map(String).filter(Boolean) : [],
            lessons: Array.isArray(parsed.lessons) ? parsed.lessons.map(String).filter(Boolean) : [],
          };
        } catch { /* a pack that is not JSON is no pack */ }
      }
      const decision = pretaskDecision({
        usage: snap && Array.isArray(snap.windows) ? { skipSetByHuman: snap.skipSetByHuman === true, skipPercent: snap.skipPercent, windows: snap.windows.filter((w) => typeof w?.usedPercent === "number"), model: String(input.model ?? readText(join(dir, "model.txt"))), at: typeof snap.at === "string" ? snap.at : undefined } : undefined,
        role: process.env.LANE_PILOT_ROLE ?? "",
        kind: String(input.subagent_type ?? input.kind ?? "general-purpose"),
        background: input.run_in_background === true,
        spawned,
        prompt: typeof input.prompt === "string" ? input.prompt : "",
        claims: readLedger(dir).files,
        rules: layers.rules,
        lessons: layers.lessons,
        repo: cwd,
      });
      if (!decision.deny) writeFileSync(join(dir, "spawned.txt"), String(decision.spawned));
      // How the pack was built (SMA k_hpt_record): size, the layer counts, trimming and ranking, and the ms it took.
      const meta = decision.pack ?? { chars: 0, layers: { rules: layers.rules.length, lessons: layers.lessons.length, claims: 0 }, trimmed: false, ranked: 0 };
      appendFileSync(join(dir, "subagents.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), kind: input.subagent_type ?? "general-purpose", deny: decision.deny ?? null, chars: meta.chars, layers: meta.layers, trimmed: meta.trimmed, ranked: meta.ranked, ms: Date.now() - packStarted })}\n`);
      if (decision.deny) {
        emit({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: decision.deny } });
        return;
      }
      if (decision.prompt) {
        const packed = injectPack(decision.prompt, true);
        // updatedInput replaces the tool's whole input: the call's other fields (subagent_type, description, model) ride along.
        if (packed.updatedInput) packed.updatedInput = { ...input, prompt: decision.prompt };
        emit(hookOutput(event, null, packed));
      }
      return;
    }
    const lessons = existsSync(join(dir, "LESSONS.md")) ? readFileSync(join(dir, "LESSONS.md"), "utf8").split("\n") : [];
    const ctx: ToolCtx = {
      tool: name, sid: session, cwd, command: String(input.command ?? ""), path: String(input.file_path ?? input.path ?? ""),
      denials: {}, lessons,
      // A cataloged file card becomes the knowledge stream's note for this edit (k_st_catalog).
      notes: cwd && EDIT_TOOLS.has(name.toLowerCase()) ? cardNotes(cwd, String(input.file_path ?? input.path ?? "")) : [],
    };
    const streams = runStreams(ctx, Date.now);
    appendPerf(dir, streams.perf);
    const text = streams.advice.filter(Boolean).join("\n");
    if (streams.deny) {
      emit({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: streams.deny } });
      return;
    }
    emit(hookOutput(event, text || null));
    return;
  }
  if (event === "PostToolUse") {
    const pmSkill = pmSkillUseOf(toolName(payload), toolInput(payload), process.env);
    if (pmSkill) reportPmSkill(pmSkill);
    // The touch journal of the catalog: one line per edit tool call, only where a catalog exists; its own try so the stall bookkeeping below always runs.
    try {
      const tool = toolName(payload).toLowerCase();
      const touched = String(toolInput(payload).file_path ?? toolInput(payload).path ?? "");
      if (cwd && touched && EDIT_TOOLS.has(tool)) appendTouch(cwd, { at: Date.now(), tool, path: touched });
    } catch { /* a lost touch line never costs the session anything */ }
    // stall.json stays the counts map; the trail (last calls, read-only run, nudged patterns) is its own file beside it.
    const trail = readJson<Record<string, unknown>>(join(dir, "stall-trail.json"), {});
    const observed = stallObserve({ counts: readJson<Record<string, number>>(join(dir, "stall.json"), {}), recent: trail.recent, readRun: trail.readRun, nudged: trail.nudged } as never, toolName(payload), toolInput(payload), payload.tool_response ?? payload.toolResponse);
    writeFileSync(join(dir, "stall.json"), JSON.stringify(observed.state.counts));
    writeFileSync(join(dir, "stall-trail.json"), JSON.stringify({ recent: observed.state.recent, readRun: observed.state.readRun, nudged: observed.state.nudged }));
    // What this session touched (SMA k_hse_farewell): the farewell draft is built from it when the payload names no files.
    // The same facts feed the compaction ledger (SMA k_hpc_progress): files of the edit tools, Bash commands.
    const tool = toolName(payload);
    const touchedPath = String(toolInput(payload).file_path ?? toolInput(payload).path ?? "");
    if (/^(edit|multiedit|write|notebookedit)$/i.test(tool) && touchedPath) {
      appendFileSync(join(dir, "touched.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), tool, path: touchedPath })}\n`);
    }
    updateLedger(dir, (current) => {
      let ledger = current;
      if (/^(edit|multiedit|write|notebookedit)$/i.test(tool) && touchedPath) ledger = ledgerAddFile(ledger, touchedPath);
      if (/^bash$/i.test(tool)) ledger = ledgerAddCommand(ledger, String(toolInput(payload).command ?? ""));
      return ledger;
    });
    emit(hookOutput(event, observed.hint || null));
    return;
  }
  if (event === "SubagentStop") {
    // The claims are the paths the subagent's last message names (SMA k_hsv_tree); the payload arrays, when
    // present, win. Each is tested against the real tree: on disk, in git status, in a commit after the spawn.
    const message = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
    const payloadClaimed = Array.isArray(payload.claimed) ? payload.claimed.map(String) : [];
    const root = resolve(cwd || ".");
    // A bare name counts only when a file of that exact name sits at the repo root.
    const rootHas = (name: string): boolean => { try { return statSync(join(root, name)).isFile(); } catch { return false; } };
    // The payload's own list is the harness's, taken as it is; only the paths read out of prose are filtered.
    const claimed = payloadClaimed.length ? payloadClaimed : claimedPaths(message, 10, rootHas);
    // A claimed path is probed only when it stays inside the checkout (symlinks resolved).
    const insideRoot = (path: string): boolean => {
      const full = resolve(root, path);
      if (full !== root && !full.startsWith(root + sep)) return false;
      try { const real = realpathSync(full); const realRoot = realpathSync(root); return real === realRoot || real.startsWith(realRoot + sep); } catch { return true; }
    };
    const changed = Array.isArray(payload.changed) ? payload.changed.map(String) : [];
    const checked = subagentVerify({ claimed, changed, exists: (path) => existsSync(resolve(root, path)) });
    // The spawn time is the last pack record this session wrote (SMA k_hpt_record).
    const lastSpawn = readText(join(dir, "subagents.jsonl")).split("\n").filter(Boolean).pop();
    let spawnSeconds = 0;
    try { spawnSeconds = Math.floor(Date.parse((JSON.parse(lastSpawn ?? "{}") as { at?: string }).at ?? "") / 1000) || 0; } catch { /* no record */ }
    // The whole tree check has 5 s: a path the time did not reach is «unchecked», never a phantom.
    const deadline = Date.now() + 5000;
    const states: Array<{ path: string; state: ClaimedState }> = [];
    for (const path of claimed) {
      if (!insideRoot(path)) continue;
      if (deadline - Date.now() <= 100) { states.push({ path, state: "unchecked" }); continue; }
      const exists = existsSync(resolve(root, path));
      const dirty = cwd ? spawnSyncGit(cwd, ["status", "--porcelain", "--", path], Math.min(3000, deadline - Date.now())) !== "" : false;
      const committed = Boolean(cwd && spawnSeconds && deadline - Date.now() > 100 && spawnSyncGit(cwd, ["log", `--since=@${spawnSeconds}`, "-1", "--", path], Math.min(3000, deadline - Date.now())));
      states.push({ path, state: Date.now() >= deadline ? "unchecked" : claimedState({ exists, dirty, committed }) });
    }
    appendFileSync(join(dir, "receipts.jsonl"), `${JSON.stringify({ subagent_receipt: { ...checked.receipt, states } })}\n`);
    emit(hookOutput(event, treeVerifyText(states) ?? subagentVerifyText(checked.missing)));
    return;
  }
  if (event === "SessionEnd") {
    // The payload names no files: the touched journal of this session is the record (SMA k_hse_farewell).
    let files = Array.isArray(payload.files) ? payload.files.map(String) : [];
    if (!files.length) {
      files = readText(join(dir, "touched.jsonl")).split("\n").filter(Boolean)
        .map((line) => { try { return String((JSON.parse(line) as { path?: unknown }).path ?? ""); } catch { return ""; } })
        .filter(Boolean).slice(-20);
    }
    // The subagent receipts the session filed (SMA k_wd_c2): how many, and which claimed files are unverified.
    const receipts = readText(join(dir, "receipts.jsonl")).split("\n").filter(Boolean)
      .map((line) => { try { return (JSON.parse(line) as { subagent_receipt?: { missing?: string[] } }).subagent_receipt ?? null; } catch { return null; } })
      .filter((row): row is { missing?: string[] } => row !== null);
    const missing = [...new Set(receipts.flatMap((row) => row.missing ?? []))];
    const subagents = receipts.length ? { count: receipts.length, missing } : undefined;
    const draft = sessionEndDraft({ files, at: new Date().toISOString(), subagents });
    writeFileSync(join(dir, "farewell.md"), draft);
    // The draft also moves into the project's drafts (SMA m_draft_move), never over an existing one: flag wx,
    // and when the name is taken the next free -2, -3 name. A farewell of a session that did nothing leaves no file;
    // the folder is the project's name plus a short hash of its full path (two projects named «app» stay apart)
    // and keeps its newest 50 farewells.
    if (!files.length && !subagents) return;
    try {
      const slug = `${(basename(cwd) || "unknown").replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(cwd).digest("hex").slice(0, 8)}`;
      const draftsDir = join(homedir(), ".lane-pilot", "drafts", slug);
      mkdirSync(draftsDir, { recursive: true });
      const name = draftTarget(readdirSync(draftsDir), `farewell-${stateName(session)}.md`);
      writeFileSync(join(draftsDir, name), draft, { flag: "wx" });
      keepNewest(draftsDir, 50, /^farewell-.*\.md$/);
    } catch { /* a draft that cannot be placed is lost, the session still ends */ }
    return;
  }
  if (event === "Stop") return;
}

// `<hook file> catalog-build <cwd>`: the detached background build a session start asked for; no stdin, no output.
if (process.argv[2] === "catalog-build" && process.argv[3]) {
  failOpen(() => { buildCatalog(process.argv[3]!); });
  process.exit(0);
}
failOpen(() => {
  const raw = readStdin().trim();
  const payload = raw ? JSON.parse(raw) as Payload : {};
  handle(payload);
});
process.exit(0);
