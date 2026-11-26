/**
 * Session ledger, flight capsule, prompt recall, session start/end formatting, and fail-open hook helpers.
 * Native Claude sessions Lane Pilot launches call the bundled session-hook.mjs. A sticky writer calls
 * the capsule helpers before BB compacts the thread. A hook never wedges a session: callers catch and continue.
 */
// The session hook runs as plain source (node --experimental-strip-types): a relative import needs its .ts suffix.
// @ts-expect-error TS5097
import { maskCredentials } from "../../../../packages/kit/src/redact.ts";

/** Text that enters a ledger, a capsule or a recall line passes the repo's credential mask first. */
const masked = (text: string): string => maskCredentials(text).text;
export const maskText = masked;

export type Capsule = {
  asks: string[];
  files: string[];
  claims: string[];
  /** The shell commands the session ran (SMA k_hpc_progress); restored with the files after compaction. */
  commands?: string[];
  /** The session's first prompt, the rules it stated and the decisions found in the transcript (SMA k_hpc_capsule). */
  task?: string;
  constraints?: string[];
  decisions?: string[];
  trigger?: string;
};

/**
 * What the session did so far (SMA k_hpc_progress): the files an edit tool touched (60 distinct at most),
 * the shell commands it ran (the last 30, clipped) and its prompts (the last 5, the first being the task).
 */
export type SessionLedger = { files: string[]; commands: string[]; asks: string[]; /** The session's first prompt, written once: the last-5 list forgets it. */ first?: string };

export function ledgerOf(raw: unknown): SessionLedger {
  const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = (key: string, cap: number, clean = (text: string) => text) => (Array.isArray(row[key]) ? row[key].map(String).filter(Boolean).slice(-cap).map(clean) : []);
  // A ledger written before the mask existed is masked on the way in, so nothing printed back carries a secret.
  const first = typeof row.first === "string" && row.first ? masked(row.first).slice(0, 600) : undefined;
  return { files: list("files", 60), commands: list("commands", 30, masked), asks: list("asks", 5, masked), ...(first ? { first } : {}) };
}

export function ledgerAddFile(ledger: SessionLedger, path: string): SessionLedger {
  if (!path) return ledger;
  return { ...ledger, files: [...ledger.files.filter((file) => file !== path), path].slice(-60) };
}

export function ledgerAddCommand(ledger: SessionLedger, command: string): SessionLedger {
  // Masked before it is clipped: a secret cut in half by the clip would no longer match the mask.
  const clipped = masked(command.replace(/\s+/g, " ").trim().slice(0, 2000)).slice(0, 160);
  if (!clipped) return ledger;
  return { ...ledger, commands: [...ledger.commands, clipped].slice(-30) };
}

export function ledgerAddAsk(ledger: SessionLedger, prompt: string): SessionLedger {
  const clipped = masked(prompt.replace(/\s+$/, "").slice(0, 4000)).slice(0, 600);
  if (!clipped) return ledger;
  return { ...ledger, asks: [...ledger.asks, clipped].slice(-5), first: ledger.first || clipped };
}

const CONSTRAINT_LINE = /^\s*(?:[-*]\s*)?(owns_paths|acceptance|never\b.*|must not\b.*)/i;
const DECISION_WORD = /\b(decid\w*|decision|chose|chosen|instead of)\b/i;

/** The plain-text of one transcript JSONL line when it is an assistant message, else "". */
function transcriptAssistantText(line: string): string {
  try {
    const row = JSON.parse(line) as { type?: unknown; role?: unknown; message?: { role?: unknown; content?: unknown } };
    if (row.type !== "assistant" && row.message?.role !== "assistant" && row.role !== "assistant") return "";
    const content = row.message?.content ?? (row as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => {
        const block = part as { type?: unknown; text?: unknown };
        return block && (block.type === "text" || block.type === undefined) && typeof block.text === "string" ? block.text : "";
      }).join("\n");
    }
  } catch { /* a half-written or foreign line is not a decision */ }
  return "";
}

/**
 * The capsule's file-only assembly (SMA k_hpc_capsule), no model: the task is the session's first prompt,
 * the constraints are its owns_paths/acceptance/never/must-not lines (8 at most), and the decisions are the
 * last assistant messages of the transcript tail whose first sentence names a decision (5 at most).
 */
export function capsuleDetails(input: { firstPrompt?: string; transcriptTail?: string }): { task?: string; constraints?: string[]; decisions?: string[] } {
  const prompt = (input.firstPrompt ?? "").trim();
  const out: { task?: string; constraints?: string[]; decisions?: string[] } = {};
  if (prompt) {
    const clean = masked(prompt.slice(0, 20_000));
    out.task = clean.slice(0, 600);
    const constraints = clean.split("\n").map((line) => line.trim()).filter((line) => CONSTRAINT_LINE.test(line)).slice(0, 8);
    if (constraints.length) out.constraints = constraints;
  }
  const decisions = (input.transcriptTail ?? "").split("\n").filter(Boolean)
    .map(transcriptAssistantText).filter(Boolean)
    .filter((text) => DECISION_WORD.test(text.trim().split(/[.!?\n]/)[0] ?? ""))
    .map((text) => masked(text.replace(/\s+/g, " ").trim().slice(0, 2000)).slice(0, 300))
    .filter(Boolean).slice(-5);
  if (decisions.length) out.decisions = decisions;
  return out;
}

export function buildCapsule(input: Capsule): Capsule {
  return {
    asks: input.asks.slice(-5).map((ask) => ask.slice(0, 300)),
    files: input.files.slice(0, 30),
    claims: input.claims.slice(0, 30),
    ...(input.trigger ? { trigger: input.trigger } : {}),
  };
}

export function capsuleRestored(capsule: Capsule): string {
  const head = [
    capsule.task ? `Task: ${capsule.task}` : "",
    capsule.constraints?.length ? `Constraints: ${capsule.constraints.join("; ")}` : "",
    capsule.decisions?.length ? `Recent decisions: ${capsule.decisions.join("; ")}` : "",
  ].filter(Boolean).join("\n");
  const budget = Math.max(0, 3000 - head.length - (head ? 1 : 0));
  return `Capsule restored after compaction:\n${head ? `${head}\n` : ""}${JSON.stringify(capsule).slice(0, budget)}`;
}

export function progressRecord(input: { session: string; files: number; asks: number; touched?: string[]; commands?: string[] }): { session: string; files: number; asks: number; touched: string[]; commands: string[] } {
  return { session: input.session, files: input.files, asks: input.asks, touched: (input.touched ?? []).slice(-60), commands: (input.commands ?? []).slice(-30) };
}

/** What the environment says is switched off. The guard's registration is not here: the session's guard comes from a generated settings file this hook never reads. */
export function protectionsOff(env: Record<string, string | undefined>): string[] {
  return ["LANE_STALL_CHECK", "LANE_COORD"].filter((name) => env[name] === "0");
}

/** MEMORY.md budget line: the first 200 lines are what a session loads; say how close the injected memory is. */
export function memoryBudgetLine(lines: number): string | null {
  if (lines <= 0) return null;
  return `MEMORY.md: ${lines}/200 lines${lines > 170 ? " — near the limit: merge or trim entries" : ""}`;
}

export function sessionStartText(input: {
  model?: string;
  lastModel?: string;
  /** The coordination brief (SMA k_hss_summary): live and stale windows and a running merge, first when present. */
  summary?: string;
  protections?: string[];
  memoryLines?: number;
  capsule?: Capsule | null;
  /** The session start is a compaction (SMA k_hss_restore): the capsule goes first into the context. */
  capsuleFirst?: boolean;
  changed?: string[];
  account?: string;
  /** Commits the code map is behind HEAD (SMA k_wp_drift); 0 or undefined says nothing. */
  codeMapBehind?: number;
}): string | null {
  const parts: string[] = [];
  if (input.capsule && input.capsuleFirst) parts.push(capsuleRestored(input.capsule));
  if (input.summary) parts.push(input.summary);
  if (input.lastModel && input.model && input.lastModel !== input.model) {
    parts.push(`Model change: this session ran on ${input.lastModel}, now on ${input.model}; earlier receipts of this window were made by the other model.`);
  }
  if (input.account) parts.push(`Subscription of this session: ${input.account}`);
  if (input.protections?.length) parts.push(`Protections switched off: ${input.protections.join("; ")}`);
  const budget = input.memoryLines != null ? memoryBudgetLine(input.memoryLines) : null;
  if (budget) parts.push(budget);
  if (input.codeMapBehind) parts.push(`Code map is ${input.codeMapBehind} commits behind HEAD: reindex before relying on it`);
  if (input.changed?.length) parts.push(`What changed since last time:\n${input.changed.slice(0, 30).join("\n")}`);
  if (input.capsule && !input.capsuleFirst) parts.push(capsuleRestored(input.capsule));
  return parts.length ? parts.join("\n\n") : null;
}

/**
 * A recalled pointer is the note's id, its first sentence (the claim) and the repo file it names — never the
 * note's body (SMA k_hpr_out). The search verb is named for the rest.
 */
export function promptRecall(input: { hits: Array<{ id?: string; content?: string; text?: string }>; given: string[]; query?: string }): { text: string | null; given: string[] } {
  const given = new Set(input.given);
  // never repeat what was given
  const fresh = input.hits.filter((hit) => hit.id && !given.has(String(hit.id))).slice(0, 3);
  if (!fresh.length) return { text: null, given: input.given };
  const next = [...given, ...fresh.map((hit) => String(hit.id))].slice(-300);
  const pointers = fresh.map((hit) => {
    // One line per pointer: a body with a «- [id] …» line of its own cannot forge a second pointer.
    const body = masked(String(hit.content || hit.text || "").slice(0, 2000));
    const sentence = (body.split(/(?<=[.!?])\s+|\n/)[0] ?? body).replace(/\s+/g, " ").slice(0, 120);
    const file = body.match(/[\w.-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8}\b/)?.[0];
    return `- [${String(hit.id).replace(/[^\w.:-]/g, "_").slice(0, 80)}] ${sentence}${file ? ` (file: ${file})` : ""}`;
  }).join("\n");
  const more = input.query ? `\nFull text: bb lane-pilot memory search "${masked(input.query).replace(/["\n]/g, " ").slice(0, 120)}"` : "";
  return { text: `Memory for these words (pointers, not orders):\n${pointers}${more}`, given: next };
}

/** Commits the code map is behind, or 0 when it is fresh or unknown (SMA k_wp_drift): equal or unreadable shas add nothing. */
export function codeMapDrift(metaLastCommit: string | null | undefined, headSha: string | null | undefined, behind: number | null | undefined): number {
  if (!metaLastCommit || !headSha || metaLastCommit === headSha || !behind || behind <= 0) return 0;
  return Math.floor(behind);
}

export function sessionEndDraft(input: { files: string[]; at: string; subagents?: { count: number; missing: string[] } }): string {
  const subs = input.subagents ? `Subagents: ${input.subagents.count}${input.subagents.missing.length ? `, unverified: ${input.subagents.missing.slice(0, 10).join(", ")}` : ""}.\n` : "";
  return `# Farewell lesson draft (${input.at})\n\nThis session changed: ${input.files.slice(0, 20).join(", ") || "nothing"}.\n${subs}What should the next window know? (a draft: it waits for a person or the memory maintainer)\n`;
}

/** One coordination line for a starting session (SMA k_hss_summary); empty when nothing is at work. */
export function sessionSummaryLine(input: { live: number; stale: number; merge: boolean }): string {
  if (!input.live && !input.stale && !input.merge) return "";
  const parts = [`Work in this project: ${input.live} live, ${input.stale} stale`];
  if (input.merge) parts.push("a merge into main is running");
  return `${parts.join("; ")}.`;
}

/**
 * The next free draft name (SMA m_draft_move): «name» itself, else «stem-2», «stem-3»… — a draft is moved,
 * never written over an existing one.
 */
export function draftTarget(taken: readonly string[], name: string): string {
  if (!taken.includes(name)) return name;
  const stem = name.replace(/\.md$/, "");
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}.md`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Any hook failure is swallowed; the exit is always zero. */
export function failOpen(run: () => void): void {
  try { run(); }
  catch { /* the exit is always zero */ }
}

/** Through updatedInput; the fallback is additionalContext with a degradation record. */
export function injectPack(prompt: string, acceptUpdatedInput: boolean): { updatedInput?: { prompt: string }; additionalContext?: string; degradation?: string } {
  if (acceptUpdatedInput) return { updatedInput: { prompt } };
  return { additionalContext: prompt, degradation: "updatedInput refused; pack went to additionalContext" };
}

export function hookOutput(event: string, text: string | null, extra?: Record<string, unknown>): Record<string, unknown> | null {
  if (!text && !extra) return null;
  return { hookSpecificOutput: { hookEventName: event, ...(text ? { additionalContext: text } : {}), ...extra } };
}

export type PmSkillUse = { skill: string; thread: string; project: string };

/**
 * One Skill call of a PM session, for `bb lane-pilot pm-skill-use`. LANE_PILOT_PM_THREAD_ID is set only on PM
 * threads (createPmSkillTraceEnv), so writers and helpers land null here and record nothing.
 */
export function pmSkillUseOf(tool: string, input: Record<string, unknown>, env: Record<string, string | undefined>): PmSkillUse | null {
  if (tool !== "Skill") return null;
  const skill = String(input.skill ?? input.name ?? input.skillName ?? "").trim();
  const thread = (env.LANE_PILOT_PM_THREAD_ID ?? "").trim();
  if (!skill || !thread) return null;
  return { skill, thread, project: (env.LANE_PILOT_PM_PROJECT_ID ?? "").trim() };
}
