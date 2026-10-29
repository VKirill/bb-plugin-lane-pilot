/**
 * Fail-open session hook for a native Claude session Lane Pilot launches.
 * A hook never wedges a session: failOpen swallows errors and the process exits 0.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// node --experimental-strip-types resolves this file only with a .ts specifier.
// @ts-expect-error TS5097
import { buildCapsule, failOpen, hookOutput, injectPack, pretaskDecision, progressRecord, promptRecall, runStreams, sessionEndDraft, sessionStartText, stallObserve, subagentVerify, subagentVerifyText, type Capsule, type ToolCtx } from "./logic.ts";

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
    const text = sessionStartText({
      model: typeof payload.model === "string" ? payload.model : undefined,
      lastModel: readText(join(dir, "model.txt")),
      memoryLines,
      capsule,
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
      const decision = pretaskDecision({
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
    const counts = readJson<Record<string, number>>(join(dir, "stall.json"), {});
    const observed = stallObserve(counts, toolName(payload), toolInput(payload), payload.tool_response ?? payload.toolResponse);
    writeFileSync(join(dir, "stall.json"), JSON.stringify(observed.counts));
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
    const files = Array.isArray(payload.files) ? payload.files.map(String) : [];
    writeFileSync(join(dir, "farewell.md"), sessionEndDraft({ files, at: new Date().toISOString() }));
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
