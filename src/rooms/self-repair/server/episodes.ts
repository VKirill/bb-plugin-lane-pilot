import packageJson from "../../../../package.json";
import { failureClass } from "../../runs";
import { fileAllowedByOwns, fileBlockedByNeverTouch, sha256Hex } from "@lane-pilot/kit";
import { codeVerdict, splitRejectedPaths } from "@lane-pilot/run-insights";
import type { Incident, SignatureRecord } from "./types";

export const VERSION: string = packageJson.version;
/** When this code was loaded: a failure before it may be what this release fixed. */
export const LOADED_AT = Date.now();

const OWNER_TURN = "client/turn/requested" as const;
const MUTE_MS = 7 * 86_400_000;
const REPEAT_AFTER_MS = 86_400_000;
export const LOG_TAIL_BYTES = 1_000_000;
/**
 * Plugin log lines that report Lane Pilot's own failure; a disconnected or slow machine is not one, and neither is a
 * browser check's verdict on the project («adopted after a reload: failed» is the product failing its check).
 */
const LOG_FAILURE = /\bfailed\b|stale API handle|is retired|unhandled|uncaught/i;
const LOG_NOT_OURS = /^self-repair|writer attempt \S+ failed|writer spawn for \S+ failed|Host is not connected|Timed out waiting for command result|native-trace|reasoning trace|waits for|browser check \S+ adopted after a reload|ended early, starting one more session/i;

/**
 * An ownership rejection of files the writer put outside its task: every named file is neither owned by the contract nor
 * bookkeeping, so the gate was right, the writer is told in its thread and redoes the task there. Several such tasks in a
 * day are writers' mistakes, not a pattern of Lane Pilot's; a gate that rejected an owned or a bookkeeping file is still one
 * (codeVerdict, as in triage). The reason's path count is part of the repeat signature, so each count used to open a repair
 * of its own (proj_acpiaqf4wq 2026-10-19/20: «<path>» answered not-lane-pilot, then «<path>, <path>» was raised again).
 * The run-scope gate (writer/server/verify.ts) words the same rejection «writer changed paths outside owns_paths or inside
 * never_touch: …»; read only as «owns_paths rejected», its writers' strays raised repairs in three projects (2026-10-24/25).
 */
const STRAY_REASON = /^(?:owns_paths rejected|writer changed paths outside owns_paths or inside never_touch:) [^;]+$/;
export function writerStrayFiles(reason: string, contractJson: string | null | undefined): boolean {
  const text = reason.replace(/^retry limit \d+ exhausted:\s*/i, "").trim();
  if (!STRAY_REASON.test(text) || !contractJson) return false;
  let contract: { owns_paths?: unknown; never_touch?: unknown };
  try { contract = JSON.parse(contractJson) as typeof contract; } catch { return false; }
  if (!Array.isArray(contract.owns_paths)) return false;
  const strings = (value: unknown) => (Array.isArray(value) ? value : []).filter((item): item is string => typeof item === "string");
  const owns = strings(contract.owns_paths);
  const never = strings(contract.never_touch);
  const split = splitRejectedPaths(text, (path) => fileAllowedByOwns(path, owns) && !fileBlockedByNeverTouch(path, never));
  return split.outside.length > 0 && split.bookkeeping.length === 0 && codeVerdict(split) === null;
}

/**
 * A writer's own red check: the task's road (red, the retry, green), told to the writer with the check's output. The repeat signature
 * blanks numbers, so different tasks' own tests read as one reason: Vampirism Fire 2026-10-25, «studio_test.py --filter Par031/37/38/70»
 * in four tasks, each triaged writer, opened a repair. The night wall skips these too (wall/select.ts). A red check triaged to Lane
 * Pilot's side (orchestrator, environment) or marked environment by the check gate keeps counting; no triage yet reads as the writer's.
 */
export function writerRedCheck(reason: string, triageOrigin: string | null | undefined, failureCode?: string | null): boolean {
  const text = reason.replace(/^retry limit \d+ exhausted:\s*/i, "").trim();
  // A merge-conflict replay also names a failed check, and the failureClass rule below keeps it out (it is a free redo,
  // not the writer's own red check).
  return (failureCode === "verification_failed" || failureCode === "verification_timeout")
    && failureClass("validation_failed", text) === "task" && triageOrigin !== "orchestrator" && triageOrigin !== "environment";
}

/**
 * Whether a kind of failure is the workflow engine itself failing: its signature, its samples or the night loop's brief show a fault in the engine's code, on its
 * tables or in its availability. Such a repair is not a graph run: a broken engine cannot run its own repair, so the watcher spawns that thread directly.
 * Only a fault counts, never a mention: a task that edits the engine's files, a check that reads its tables, a test of its folder and the words «workflow engine»
 * or the log prefix of a healthy run name the engine without the engine being broken (Astra's recheck of .341, F6: the first version matched the names alone).
 */
const ENGINE_PATH = String.raw`(?:packages/workflow-engine/src|src/rooms/workflow)/[\w./-]*?(?<!\.test)\.tsx?`;
const FAULT_WORD = String.raw`(?:\bSITE:|\binternal_error\b|\b[A-Za-z]+Error\b|\bunhandled\b|\buncaught\b)`;
const DB_FAULT = String.raw`(?:no such (?:table|column)|SQLITE_\w+|constraint failed|database is locked|malformed)`;
const ENGINE_FAULT = new RegExp([
  // a stack frame in the engine's code
  String.raw`\bat\s[^\n]*?${ENGINE_PATH}:\d+`,
  // an error, a site or an internal error on the same line as the engine's code
  String.raw`${FAULT_WORD}[^\n]*?${ENGINE_PATH}`,
  String.raw`${ENGINE_PATH}[^\n]*?${FAULT_WORD}`,
  // a database error on one of the engine's tables
  String.raw`${DB_FAULT}[^\n]*\blane_pilot_wf_\w+`,
  String.raw`\blane_pilot_wf_\w+[^\n]*${DB_FAULT}`,
  // the engine is down, or the drive of a run crashed (a step that fails ends the run, it does not reject the drive)
  String.raw`\bthe workflow engine (?:is not running|is not up yet|is off)\b`,
  String.raw`\bLane Pilot workflow run \S+ \([^)]*\) stopped with an error`,
].join("|"), "i");
export function pointsAtEngine(signature: string, samples: ReadonlyArray<Pick<Incident, "reason">>, brief = ""): boolean {
  return ENGINE_FAULT.test(`${signature}\n${brief}\n${samples.map((sample) => sample.reason).join("\n")}`);
}

/** A reason with its ids, paths, hashes and numbers blanked, so one problem in many tasks is one signature. */
export function reasonSignature(kind: Incident["kind"], reason: string): string {
  const core = reason
    .replace(/retry limit \d+ exhausted:\s*/i, "")
    .replace(/\b(?:lpattempt|lprun|thr|env|proj|host|term|ask|rem)_[a-z0-9]+\b/gi, "<id>")
    .replace(/(?:[\w.@-]+)?\/[^\s'",;)]+/g, "<path>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hash>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return `${kind}:${sha256Hex(core).slice(0, 16)}:${core}`;
}

/** How much a kind of incident matters when it is real: a closed project (breaker) or a parked task outranks a log line or a drill. */
const KIND_SEVERITY: Record<Incident["kind"], number> = { night: 0, breaker: 5, guard: 5, parked: 4, owner: 3, blocked: 3, stuck: 3, triage: 3, repeat: 3, hook: 2, queued: 2, stage: 2, log: 1, drill: 0.4 };
const IMPACT_FLOOR = 0.3;

/**
 * Which due problem gets the next repair (audit 2026-10-08 round 2, #20: the oldest first meant a drill artifact from days ago
 * outranked a fresh failure in a real project; 148 signatures, 0 repairs). Severity of its kind, times how often it happened
 * (log scale), times how recently (halves every day), times how many real projects it hit (a drill, the sandbox and a log line
 * with no project count as none and weigh 0.3). Higher goes first; equal scores go to the older.
 */
export function repairPriority(signature: string, record: Pick<SignatureRecord, "count" | "lastAt" | "samples">, now: number, ignoredProjects: ReadonlySet<string> = new Set()): number {
  const kind = signature.slice(0, signature.indexOf(":")) as Incident["kind"];
  const severity = KIND_SEVERITY[kind] ?? 1;
  const frequency = 1 + Math.min(5, Math.log2(Math.max(1, record.count)));
  const days = Math.max(0, now - record.lastAt) / 86_400_000;
  const freshness = 0.5 ** days;
  const projects = new Set(record.samples.map((sample) => sample.projectId).filter((id) => id && id !== "-" && !ignoredProjects.has(id)));
  const impact = projects.size === 0 ? IMPACT_FLOOR : Math.min(3, 1 + 0.5 * (projects.size - 1));
  return Math.round(severity * frequency * freshness * impact * 1000) / 1000;
}

export function logIncidents(text: string, since: number): Incident[] {
  const out: Incident[] = [];
  for (const line of text.split("\n")) {
    let row: { ts?: unknown; message?: unknown };
    try { row = JSON.parse(line) as typeof row; } catch { continue; }
    if (typeof row.ts !== "number" || row.ts <= since || typeof row.message !== "string") continue;
    // A successful episode summary is status; other failure text in the same line still counts.
    if (!LOG_FAILURE.test(row.message.replace(/^episodes: \d+ enriched, \d+ skipped, 0 failed, 0 held of \d+ picked\b/i, "")) || LOG_NOT_OURS.test(row.message)) continue;
    const projectId = /\bproj_[a-z0-9]+/i.exec(row.message)?.[0] ?? "-";
    out.push({ signature: reasonSignature("log", row.message), kind: "log", projectId, runId: "-", taskId: "-",
      attemptId: `log:${row.ts}`, pmThreadId: null, writerThreadId: null, reason: row.message, at: row.ts });
  }
  return out;
}

function isOwnerInitiated(data: Record<string, unknown>): boolean {
  const systemNotice = data.systemMessageKind != null && data.systemMessageKind !== "unlabeled";
  return data.initiator === "user" && !data.senderThreadId && !systemNotice && !data.retryOfRequestId;
}

export async function lastPmOwnerMessageAt(
  listEvents: (query: { threadId: string; types: [typeof OWNER_TURN]; order: "desc"; limit: string; beforeSeq?: string }) => Promise<unknown>,
  threadId: string,
): Promise<number | null> {
  try {
    let beforeSeq: string | undefined;
    for (let page = 0; page < 10; page++) {
      const listed = await listEvents({
        threadId, types: [OWNER_TURN], order: "desc", limit: "50", ...(beforeSeq ? { beforeSeq } : {}),
      });
      if (!Array.isArray(listed) || listed.length === 0) return null;
      for (const row of listed) {
        if (!row || typeof row !== "object") continue;
        const event = row as { createdAt?: unknown; data?: unknown; seq?: unknown };
        const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
        if (!isOwnerInitiated(data) || typeof event.createdAt !== "number") continue;
        return event.createdAt;
      }
      const seqs = listed.map((row) => Number((row as { seq?: unknown }).seq)).filter((seq) => Number.isFinite(seq));
      const next = Math.min(...seqs);
      if (!Number.isFinite(next) || listed.length < 50) return null;
      if (beforeSeq !== undefined && next >= Number(beforeSeq)) return null;
      beforeSeq = String(next);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a kind of problem began under the version that is running now: it was first recorded after this load and every sample
 * kept happened after it. The deploy script lifts the one-a-day and error-budget rules for an incident deploy only for such a kind
 * (audit 2026-10-08 round 4, P0-8): a problem that was already there when this version started is not what this version broke.
 */
export function firstSeenOnRunningVersion(record: SignatureRecord, loadedAt = LOADED_AT, version = VERSION): boolean {
  return record.firstAt >= loadedAt && record.samples.length > 0 && record.samples.every((sample) => sample.version === version);
}

/**
 * Whether a kind of problem needs a repair now. Only occurrences under the running version count: a failure from
 * before this release may be exactly what the release fixed, so it waits to happen again. After a repair the kind
 * comes back only if it happens again under a newer version (the fix did not hold), a day later without a verdict,
 * or a week later when the repair said it is not Lane Pilot's or needs the owner.
 */
export function isDue(record: SignatureRecord, now: number, version = VERSION): boolean {
  const live = record.samples.some((sample) => sample.version === version && sample.at > (record.spawnedAt ?? 0));
  if (!live) return false;
  if (!record.spawnedAt) return true;
  if (record.verdict === "not-lane-pilot" || record.verdict === "needs-owner") return now - record.spawnedAt > MUTE_MS;
  if (record.verdict === "fixed" || record.verdict === "already-fixed") return version !== record.spawnVersion || now - record.spawnedAt > REPEAT_AFTER_MS;
  return now - record.spawnedAt > REPEAT_AFTER_MS;
}
