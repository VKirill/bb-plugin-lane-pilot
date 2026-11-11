/**
 * Fail-open session hook for a native Claude session Lane Pilot launches.
 * A hook never wedges a session: failOpen swallows errors and the process exits 0.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// node --experimental-strip-types resolves this file only with a .ts specifier.
// @ts-expect-error TS5097
import { buildCapsule, capsuleDetails, claimedPaths, claimedState, codeMapDrift, draftTarget, failOpen, foreignClaimAdvice, hookOutput, injectPack, ledgerAddAsk, ledgerAddCommand, ledgerAddFile, ledgerOf, pmSkillUseOf, pretaskDecision, progressRecord, promptRecall, protectionsOff, runStreams, sessionEndDraft, sessionStartText, stallObserve, subagentVerify, subagentVerifyText, treeVerifyText, type Capsule, type PmSkillUse, type SessionLedger, type ToolCtx } from "./logic.ts";

type Payload = Record<string, unknown>;

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
  mkdirSync(dir, { recursive: true });
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

function readLedger(dir: string): SessionLedger {
  return ledgerOf(readJson<unknown>(ledgerPath(dir), null));
}

function writeLedger(dir: string, ledger: SessionLedger): void {
  // An empty ledger leaves no file: the state folder keeps only what the session did.
  if (!ledger.files.length && !ledger.commands.length && !ledger.asks.length) return;
  try { writeFileSync(ledgerPath(dir), JSON.stringify(ledger)); } catch { /* the ledger is best effort */ }
}

/** A lane-pilot verb from the hook, fail-open: stdout on a zero exit inside the budget, "" otherwise. */
function bbCall(args: string[], timeoutMs: number, cwd?: string): string {
  try {
    const ran = spawnSync(process.env.BB_CLI || "bb", args, { encoding: "utf8", timeout: timeoutMs, ...(cwd ? { cwd } : {}) });
    return ran.status === 0 ? (ran.stdout ?? "") : "";
  } catch { return ""; }
}

const CLAIMS_WINDOW_MS = 30 * 60_000;
const CLAIMS_FILE = () => join(SESSIONS_ROOT(), "claims.jsonl");

/** The shared claim book (SMA m_rd_coord_ledger): every hook session's edit calls, appended as one line each. */
function appendClaim(row: { session: string; role: string; cwd: string; path: string; at: number }): void {
  try { appendFileSync(CLAIMS_FILE(), `${JSON.stringify(row)}\n`); } catch { /* a lost claim never wedges the session */ }
}

/** The last 100 KB of the claim book: another live session's claim on the same path inside the window. */
function foreignClaim(path: string, session: string, now: number): { path: string; who?: string } | null {
  try {
    const file = CLAIMS_FILE();
    const size = statSync(file).size;
    const text = size > 100 * 1024
      ? readText(file).slice(-100 * 1024)
      : readText(file);
    for (const line of text.split("\n").filter(Boolean).reverse()) {
      try {
        const row = JSON.parse(line) as { session?: unknown; role?: unknown; path?: unknown; at?: unknown };
        if (row.session === session || row.path !== path) continue;
        if (typeof row.at !== "number" || now - row.at > CLAIMS_WINDOW_MS) continue;
        return { path, who: `${row.session}${row.role ? ` (${String(row.role)})` : ""}` };
      } catch { /* a torn line is skipped */ }
    }
  } catch { /* no claim book yet */ }
  return null;
}


// Fire and forget: a PM's Skill call lands one row in lane_pilot_pm_skill_use. Never blocks the tool call.
/** One git call in the workspace, nothing on failure: the hook must answer inside its budget either way. */
function spawnSyncGit(cwd: string, args: string[]): string {
  try {
    const ran = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
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
    const details = capsuleDetails({ firstPrompt: asks[0] ?? "", transcriptTail });
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
    // What moved in this checkout since the last start (SMA k_hss_digest): head.txt per cwd hash.
    if (cwd) {
      try {
        const headsDir = join(SESSIONS_ROOT(), "heads");
        mkdirSync(headsDir, { recursive: true });
        let hash = 0;
        for (let i = 0; i < cwd.length; i++) hash = Math.imul(hash, 31) + cwd.charCodeAt(i) | 0;
        const headFile = join(headsDir, `${(hash >>> 0).toString(16)}.txt`);
        const old = readText(headFile);
        const head = spawnSyncGit(cwd, ["rev-parse", "HEAD"]);
        if (head && old && old !== head) {
          const log = spawnSyncGit(cwd, ["log", "--oneline", `${old}..HEAD`]);
          changed.push(...log.split("\n").filter(Boolean).slice(0, 10));
        }
        if (head) writeFileSync(headFile, head);
      } catch { /* a head that cannot be compared stays silent */ }
    }
    // Which protections are off (SMA k_h_session_start): the env zeros and a missing guard registration.
    let guardRegistered = false;
    for (const file of [join(cwd || ".", ".claude", "settings.json"), join(cwd || ".", ".claude", "settings.local.json")]) {
      try { if (readFileSync(file, "utf8").includes("guard_shell.py")) guardRegistered = true; } catch { /* not this file */ }
    }
    const text = sessionStartText({
      summary,
      protections: protectionsOff(process.env, guardRegistered),
      model: typeof payload.model === "string" ? payload.model : undefined,
      lastModel: readText(join(dir, "model.txt")),
      memoryLines,
      capsule,
      changed,
      codeMapBehind,
    });
    if (typeof payload.model === "string") writeFileSync(join(dir, "model.txt"), payload.model);
    emit(hookOutput(event, text));
    return;
  }
  if (event === "UserPromptSubmit") {
    const promptText = String(payload.prompt ?? "");
    writeLedger(dir, ledgerAddAsk(readLedger(dir), promptText));
    const state = readJson<{ given: string[]; hits: Array<{ id?: string; content?: string }> }>(join(dir, "recall.json"), { given: [], hits: [] });
    // The prompt's own words search the hub memory (SMA k_h_prompt_recall, k_hpr_find): 3 words or more,
    // 1.2 s at most, a failure or «nothing relevant» stays silent.
    const query = promptText.replace(/\s+/g, " ").trim().slice(0, 300);
    if (query.split(" ").length >= 3) {
      const found = bbCall(["lane-pilot", "memory", "search", query], 1200, cwd || undefined);
      if (found && !found.includes("nothing relevant")) {
        const hits = found.split("\n").map((line) => /^- \[([^\]]+)\]\s*(.+)$/.exec(line))
          .filter((row): row is RegExpExecArray => row !== null)
          .map((row) => ({ id: row[1], content: row[2] }));
        state.hits = hits.length ? hits : state.hits;
      }
    }
    const next = promptRecall({ ...state, query });
    writeFileSync(join(dir, "recall.json"), JSON.stringify({ given: next.given, hits: state.hits }));
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
        emit(hookOutput(event, null, packed));
      }
      return;
    }
    const lessons = existsSync(join(dir, "LESSONS.md")) ? readFileSync(join(dir, "LESSONS.md"), "utf8").split("\n") : [];
    const ctx: ToolCtx = {
      tool: name, sid: session, cwd, command: String(input.command ?? ""), path: String(input.file_path ?? input.path ?? ""),
      denials: {}, lessons,
    };
    // The terminal claim book (SMA m_rd_coord_ledger): this edit is claimed, and another live session's claim
    // on the same path is said — advice only, never a block.
    let foreign: { path: string; who?: string } | null = null;
    if (/^(edit|multiedit|write|notebookedit)$/i.test(name) && ctx.path) {
      const now = Date.now();
      foreign = foreignClaim(ctx.path, session, now);
      appendClaim({ session, role: process.env.LANE_PILOT_ROLE ?? "", cwd, path: ctx.path, at: now });
    }
    const streams = runStreams(ctx, Date.now);
    appendPerf(dir, streams.perf);
    const text = [...streams.advice, foreignClaimAdvice(foreign)].filter(Boolean).join("\n");
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
    {
      let ledger = readLedger(dir);
      if (/^(edit|multiedit|write|notebookedit)$/i.test(tool) && touchedPath) ledger = ledgerAddFile(ledger, touchedPath);
      if (/^bash$/i.test(tool)) ledger = ledgerAddCommand(ledger, String(toolInput(payload).command ?? ""));
      writeLedger(dir, ledger);
    }
    emit(hookOutput(event, observed.hint || null));
    return;
  }
  if (event === "SubagentStop") {
    // The claims are the paths the subagent's last message names (SMA k_hsv_tree); the payload arrays, when
    // present, win. Each is tested against the real tree: on disk, in git status, in a commit after the spawn.
    const message = typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "";
    const payloadClaimed = Array.isArray(payload.claimed) ? payload.claimed.map(String) : [];
    const claimed = payloadClaimed.length ? payloadClaimed : claimedPaths(message);
    const changed = Array.isArray(payload.changed) ? payload.changed.map(String) : [];
    const checked = subagentVerify({ claimed, changed, exists: (path) => existsSync(path) });
    // The spawn time is the last pack record this session wrote (SMA k_hpt_record).
    const lastSpawn = readText(join(dir, "subagents.jsonl")).split("\n").filter(Boolean).pop();
    let spawnSeconds = 0;
    try { spawnSeconds = Math.floor(Date.parse((JSON.parse(lastSpawn ?? "{}") as { at?: string }).at ?? "") / 1000) || 0; } catch { /* no record */ }
    const states = claimed.map((path: string) => {
      const resolved = path.startsWith("/") ? path : join(cwd || ".", path);
      const dirty = cwd ? spawnSyncGit(cwd, ["status", "--porcelain", "--", path]) !== "" : false;
      const committed = Boolean(cwd && spawnSeconds && spawnSyncGit(cwd, ["log", `--since=@${spawnSeconds}`, "-1", "--", path]));
      return { path, state: claimedState({ exists: existsSync(resolved), dirty, committed }) };
    });
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
    // and when the name is taken the next free -2, -3 name.
    try {
      const slug = (cwd.split("/").filter(Boolean).pop() || "unknown").replace(/[^\w.-]/g, "_");
      const draftsDir = join(homedir(), ".lane-pilot", "drafts", slug);
      mkdirSync(draftsDir, { recursive: true });
      const name = draftTarget(readdirSync(draftsDir), `farewell-${stateName(session)}.md`);
      writeFileSync(join(draftsDir, name), draft, { flag: "wx" });
    } catch { /* a draft that cannot be placed is lost, the session still ends */ }
    return;
  }
  if (event === "Stop") return;
}

failOpen(() => {
  const raw = readStdin().trim();
  const payload = raw ? JSON.parse(raw) as Payload : {};
  handle(payload);
});
process.exit(0);
