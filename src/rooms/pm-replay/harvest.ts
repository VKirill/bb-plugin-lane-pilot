import { z } from "zod";
import type { Db } from "../learning";
import { scenarioId, type Scenario } from "./store";

/**
 * The nightly harvest (src/rooms/pm-replay): the last 24 h of PM chats are searched for owner messages that correct the
 * PM. The learning room's cheap judge already read every owner message (`lane_pilot_learning_obs`): a row that came out
 * kind `correction` in a thread that is a PM chat is a candidate incident. For each, a model (the project's rules
 * analyzer, the same the learning extractor uses) rebuilds the replay scenario: the situation the PM faced, the right
 * behaviour the owner's correction implies, and the canned answers the stub serves.
 *
 * Sandbox/drill projects are skipped (isSandboxProjectName), and the night keeps a cap: at most `cap` scenarios a
 * night, and the run step stops at its dollar cap.
 */

/** A learning observation that names a correction in a PM thread. */
export type CorrectionObs = {
  obsId: string; threadId: string; projectId: string; at: number;
  ownerMessage: string; prevReply: string;
};

/** Observations judged `correction` (or clearly frustrated) in PM threads of the window, oldest first. */
export function correctionObservations(db: Db, pmThreads: ReadonlySet<string>, since: number, limit: number): CorrectionObs[] {
  const rows = db.prepare(`SELECT id, thread_id, project_id, at, excerpt, body, prev, kind, frustration FROM lane_pilot_learning_obs
    WHERE judged_at>=? AND (kind='correction' OR frustration>=0.5) ORDER BY at LIMIT ?`).all(since, limit * 4) as Array<Record<string, unknown>>;
  return rows
    .filter((row) => pmThreads.has(row.thread_id as string))
    .slice(0, limit)
    .map((row) => ({
      obsId: row.id as string, threadId: row.thread_id as string, projectId: row.project_id as string, at: row.at as number,
      ownerMessage: ((row.body as string | null) ?? (row.excerpt as string | null) ?? "").slice(0, 1200),
      prevReply: ((row.prev as string | null) ?? "").slice(-1_200),
    }))
    .filter((row) => row.ownerMessage.trim().length > 0);
}

/** Threads that are a PM chat of a live run (lane_pilot_run.pm_thread_id) or that the notice table names. */
export function pmThreadIds(db: Db, since: number): Set<string> {
  const a = db.prepare("SELECT pm_thread_id AS t FROM lane_pilot_run WHERE pm_thread_id IS NOT NULL AND updated_at>=?").all(since) as Array<{ t: string }>;
  const b = db.prepare("SELECT DISTINCT pm_thread_id AS t FROM lane_pilot_pm_notice WHERE sent_at>=?").all(since) as Array<{ t: string }>;
  return new Set([...a, ...b].map((row) => row.t));
}

const scenarioSchema = z.object({
  situation: z.string().max(3000),
  should: z.string().max(1200),
  fail_if: z.string().max(1200).optional().default(""),
  expect: z.array(z.string()).max(6).optional().default([]),
  forbid: z.array(z.string()).max(6).optional().default([]),
  responses: z.record(z.string(), z.unknown()).optional().default({}),
}).passthrough();

/** The prompt that rebuilds one incident as a replay scenario. */
export function harvestPrompt(input: { project: string; ownerMessage: string; prevReply: string; tools: readonly string[] }): string {
  return [
    "You rebuild one incident of a project-manager agent (Lane Pilot PM) as a replayable test scenario. The PM has tools like lane_pilot_dispatch_writer, lane_pilot_errand, lane_pilot_workflow_status, lane_pilot_ask_owner.",
    "The owner corrected the PM in a real chat. Write the scenario so that replaying it shows whether a PM does the right thing.",
    `Project: ${input.project}`,
    `The owner's correcting message:\n${input.ownerMessage}`,
    `What the PM had said/done just before (its last reply; the wrong behaviour it implies):\n${input.prevReply || "(none on record — infer from the correction)"}`,
    "Answer with JSON only:",
    '{ "situation": "the message the PM receives in the replay, 1st person context: [Context] project … + the notice or owner message the PM was reacting to when it went wrong. In the owner\'s language.",',
    '  "should": "the right behaviour, one paragraph, in English",',
    '  "fail_if": "the wrong behaviour to fail on, one sentence, in English",',
    '  "expect": ["tool names the PM should call, at most 3; empty when it should answer without tools"],',
    '  "forbid": ["tool names it must not call; the ones the incident used wrongly"],',
    '  "responses": {"tool or tool.action": "a canned answer the stub serves; only for tools whose answer the moment depends on"} }',
    `Known tool names (only these may appear in expect/forbid/responses): ${input.tools.join(", ")}`,
  ].join("\n\n");
}

/** A model's reply as one scenario; null when unreadable or empty. */
export function parseHarvested(text: string, input: { obsId: string; threadId: string; projectId: string; at: number; ownerMessage: string; tools: readonly string[] }, now: number): Scenario | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const row = scenarioSchema.safeParse(parsed);
  if (!row.success || row.data.situation.trim().length < 20 || row.data.should.trim().length < 10) return null;
  const known = new Set(input.tools);
  const names = (list: string[]) => list.filter((name) => known.has(name)).slice(0, 6);
  const responses = Object.fromEntries(Object.entries(row.data.responses).filter(([key]) => known.has(key) || known.has(key.split(".")[0]!)));
  const seq = Number(input.obsId.split(":").pop());
  const msg = row.data.situation.includes(input.ownerMessage.slice(0, 40))
    ? row.data.situation
    : `${row.data.situation}\n\nThe owner writes:\n${input.ownerMessage}`;
  return {
    id: scenarioId(`${input.threadId}:${input.obsId}:${msg}`),
    projectId: input.projectId,
    sourceThread: input.threadId, sourceSeq: Number.isFinite(seq) ? seq : null,
    msg: msg.slice(0, 4000), responses, expect: names(row.data.expect), forbid: names(row.data.forbid), argCheck: {},
    should: row.data.should.trim(), failIf: row.data.fail_if.trim() || null, ruleId: null, createdAt: now, state: "active",
  };
}

/** `pm-replay import <file>`: the manual pm-live-eval scenario format (scenarios.json / scenarios-real.json). */
export function importScenarios(rows: readonly Record<string, unknown>[], projectId: string, now: number): Scenario[] {
  const out: Scenario[] = [];
  for (const row of rows) {
    const msg = typeof row.msg === "string" ? row.msg : "";
    if (msg.trim().length < 10 || typeof row.id !== "string" || !row.id.trim()) continue;
    out.push({
      id: `imp_${String(row.id).replace(/[^\w-]/g, "_").slice(0, 48)}`,
      projectId,
      sourceThread: null, sourceSeq: null,
      msg, responses: (row.responses as Record<string, unknown>) ?? {},
      expect: Array.isArray(row.expect) ? row.expect.filter((v): v is string => typeof v === "string") : [],
      forbid: Array.isArray(row.forbid) ? row.forbid.filter((v): v is string => typeof v === "string") : [],
      argCheck: (row.argCheck as Record<string, string>) ?? {},
      should: typeof row.should === "string" ? row.should : null,
      failIf: typeof row.fail_if === "string" ? row.fail_if : null,
      ruleId: null, createdAt: now, state: "active",
    });
  }
  return out;
}
