/**
 * Fail-open session hook for a native Claude session Lane Pilot launches.
 * A hook never wedges a session: failOpen swallows errors and the process exits 0.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// node --experimental-strip-types resolves this file only with a .ts specifier.
// @ts-expect-error TS5097
import { buildCapsule, codeMapDrift, failOpen, hookOutput, injectPack, pmSkillUseOf, pretaskDecision, progressRecord, promptRecall, runStreams, sessionEndDraft, sessionStartText, stallObserve, subagentVerify, subagentVerifyText, type Capsule, type PmSkillUse, type ToolCtx } from "./logic.ts";

type Payload = Record<string, unknown>;

function readStdin(): string {
  try { return readFileSync(0, "utf8"); }
  catch { return ""; }
}

function stateDir(session: string): string {
  const dir = join(homedir(), ".lane-pilot", "session-hooks", session.replace(/[^\w.-]/g, "_") || "session");
  mkdirSync(dir, { recursive: true });
  return dir;
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
    const capsule = buildCapsule({
      asks: Array.isArray(payload.asks) ? payload.asks.map(String) : [],
      files: Array.isArray(payload.files) ? payload.files.map(String) : [],
      claims: Array.isArray(payload.claims) ? payload.claims.map(String) : [],
      trigger: "precompact",
    });
    writeFileSync(join(dir, "capsule.json"), JSON.stringify(capsule));
    const progress = progressRecord({ session, files: capsule.files.length, asks: capsule.asks.length });
    appendFileSync(join(dir, "progress.jsonl"), `${JSON.stringify(progress)}\n`);
    return;
  }
  if (event === "SessionStart") {
    const capsule = readJson<Capsule | null>(join(dir, "capsule.json"), null);
    let memoryLines = 0;
    const memoryPath = cwd ? join(cwd, "MEMORY.md") : "";
    if (memoryPath && existsSync(memoryPath)) memoryLines = readFileSync(memoryPath, "utf8").split("\n").length;
    // The code map's freshness (SMA k_wp_drift): .gitnexus/meta.json lastCommit against the checkout's HEAD.
    let codeMapBehind = 0;
    const metaCommit = readJson<{ lastCommit?: string } | null>(cwd ? join(cwd, ".gitnexus", "meta.json") : "/dev/null", null)?.lastCommit;
    if (metaCommit && cwd) {
      try {
        const head = spawnSyncGit(cwd, ["rev-parse", "HEAD"]);
        const behind = head && head !== metaCommit ? Number(spawnSyncGit(cwd, ["rev-list", "--count", `${metaCommit}..HEAD`])) : 0;
        codeMapBehind = codeMapDrift(metaCommit, head, Number.isFinite(behind) ? behind : 0);
      } catch { /* a map that cannot be read stays silent */ }
    }
    const text = sessionStartText({
      model: typeof payload.model === "string" ? payload.model : undefined,
      lastModel: readText(join(dir, "model.txt")),
      memoryLines,
      capsule,
      codeMapBehind,
    });
    if (typeof payload.model === "string") writeFileSync(join(dir, "model.txt"), payload.model);
    emit(hookOutput(event, text));
    return;
  }
  if (event === "UserPromptSubmit") {
    const state = readJson<{ given: string[]; hits: Array<{ id?: string; content?: string }> }>(join(dir, "recall.json"), { given: [], hits: [] });
    const next = promptRecall(state);
    writeFileSync(join(dir, "recall.json"), JSON.stringify({ given: next.given, hits: state.hits }));
    emit(hookOutput(event, next.text));
    return;
  }
  if (event === "PreToolUse") {
    const name = toolName(payload);
    const input = toolInput(payload);
    if (name === "Task" || name === "Agent") {
      const spawned = readJson<number>(join(dir, "spawned.txt"), 0);
      // The machine's spend facts (SMA k_hs_spend): a Task past a human-set window cap is refused, else allowed.
      const snap = readJson<{ at?: string; windows?: Array<{ usedPercent?: number; resetsAt?: string | null }>; skipPercent?: number; skipSetByHuman?: boolean } | null>(join(homedir(), ".lane-pilot", "usage-snapshot.json"), null);
      const worst = (snap?.windows ?? []).reduce((top, w) => Math.max(top, typeof w?.usedPercent === "number" ? w.usedPercent : 0), 0);
      const snapReset = (snap?.windows ?? []).find((w) => typeof w?.usedPercent === "number" && w.usedPercent === worst)?.resetsAt ?? null;
      const decision = pretaskDecision({
        usage: snap ? { skipSetByHuman: snap.skipSetByHuman === true, skipPercent: snap.skipPercent, percent: worst, resetsAt: snapReset, atMs: snap.at ? Date.parse(snap.at) : 0 } : undefined,
        role: process.env.LANE_PILOT_ROLE ?? "",
        kind: String(input.subagent_type ?? input.kind ?? "general-purpose"),
        background: input.run_in_background === true,
        spawned,
        prompt: typeof input.prompt === "string" ? input.prompt : "",
        claims: [],
        repo: cwd,
      });
      if (!decision.deny) writeFileSync(join(dir, "spawned.txt"), String(decision.spawned));
      appendFileSync(join(dir, "subagents.jsonl"), `${JSON.stringify({ kind: input.subagent_type ?? "general-purpose", deny: decision.deny ?? null })}\n`);
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
    const streams = runStreams(ctx, Date.now);
    appendFileSync(join(dir, "perf.jsonl"), `${JSON.stringify(streams.perf)}\n`);
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
    const observed = stallObserve(readJson(join(dir, "stall.json"), {}), toolName(payload), toolInput(payload), payload.tool_response ?? payload.toolResponse);
    writeFileSync(join(dir, "stall.json"), JSON.stringify(observed.state));
    // What this session touched (SMA k_hse_farewell): the farewell draft is built from it when the payload names no files.
    const touchedPath = String(toolInput(payload).file_path ?? toolInput(payload).path ?? "");
    if (/^(edit|multiedit|write|notebookedit)$/i.test(toolName(payload)) && touchedPath) {
      appendFileSync(join(dir, "touched.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), tool: toolName(payload), path: touchedPath })}\n`);
    }
    emit(hookOutput(event, observed.hint || null));
    return;
  }
  if (event === "SubagentStop") {
    const claimed = Array.isArray(payload.claimed) ? payload.claimed.map(String) : [];
    const changed = Array.isArray(payload.changed) ? payload.changed.map(String) : [];
    const checked = subagentVerify({ claimed, changed, exists: (path) => existsSync(path) });
    appendFileSync(join(dir, "receipts.jsonl"), `${JSON.stringify({ subagent_receipt: checked.receipt })}\n`);
    emit(hookOutput(event, subagentVerifyText(checked.missing)));
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
    writeFileSync(join(dir, "farewell.md"), sessionEndDraft({ files, at: new Date().toISOString(), subagents }));
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
