/**
 * Session behaviour Claude Lane ran from sma_hooks.py and stall_check.py on every lane session.
 * Native Claude sessions Lane Pilot launches call the bundled session-hook.mjs. A sticky writer calls the capsule
 * helpers before BB compacts the thread. A hook never wedges a session: callers catch and continue.
 */
// The session hook runs as plain source (node --experimental-strip-types): a relative import needs its .ts suffix.
// @ts-expect-error TS5097
import { maskCredentials } from "../../../packages/kit/src/redact.ts";

/** Text that enters a ledger, a capsule or a recall line passes the repo's credential mask first. */
const masked = (text: string): string => maskCredentials(text).text;
export const maskText = masked;

export const DOCUMENTARY_AGENTS = ["Explore", "Plan", "statusline-setup"] as const;
export const SUBAGENT_CAP = 8;
export const SOFT_BUDGET_SEC = 1.5;

export const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);
const READ_TOOLS = new Set(["read", "grep", "glob"]);
const DESTRUCTIVE_GIT = /\bgit\s+(checkout\s+--|restore\b|reset\b|clean\b|stash\s+(drop|clear)|rebase\b|branch\s+-D)/;
const DEPENDENCY_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock)$|(^|\/)node_modules\//;
const VOLATILE = /\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b|\b\d+(\.\d+)?\s?(ms|s)\b|\/tmp\/[\w.-]+|\b[0-9a-f]{12,}\b/g;
const CLASS_SWEEP = "Name the class of this failure, then sweep every similar place offline in one pass (read/grep, no reruns), fix the whole class, and run once to confirm.";

export type ToolCtx = {
  tool: string;
  sid: string;
  cwd: string;
  command: string;
  path: string;
  denials: Record<string, number>;
  foreign?: { path: string; who?: string } | null;
  rules?: HardRule[];
  lessons?: string[];
  notes?: Array<{ claim?: string }>;
  sha?: string | null;
};

export type HardRule = { tool?: string; pattern?: string; message?: string };

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

export type StreamName = "hard_rules" | "git_airbag" | "dependency_store" | "reflexes" | "rule_loops" | "knowledge";

export const STREAMS: StreamName[] = ["hard_rules", "git_airbag", "dependency_store", "reflexes", "rule_loops", "knowledge"];

const REQUIRED_STREAMS = new Set<StreamName>(["hard_rules"]);

/** Only these streams may refuse the call (SMA k_hp_merge): a deny of any other stream merges as a warning. */
const DENY_RIGHTS = new Set<StreamName>(["hard_rules"]);

/**
 * Inventory of checkable gates (SMA k_d_ref_gates_inv): every pre-tool guard with when it fires
 * (matcher), the deny/advice it gives (text) and the switch that holds it (the env that tunes it or
 * the stream that can be left out of runStreams).
 */
export type GuardRow = { id: string; matcher: string; text: string; switch: string };

export const GUARD_INVENTORY: GuardRow[] = [
  { id: "execution-without-agent", matcher: "a writer calls a subagent whose kind is not in the documentary list", text: "a writer does its task itself; only read-and-report agents may help", switch: "role writer" },
  { id: "subagent-foreground", matcher: "run_in_background is set on a subagent call", text: "a lane session's subagent runs in the foreground", switch: "none: a background subagent is always refused" },
  { id: "subagent-cap", matcher: "the session's spawned subagents reach the cap", text: "finish with what you have or do it yourself", switch: "LANE_SUBAGENT_CAP" },
  { id: "spend-cap", matcher: "a usage window the owner capped (usage.skip_percent) is at or past its cap when a subagent is called", text: "no subagent until the window resets; finish with what you have", switch: "usage.skip_percent (0 turns it off)" },
  { id: "hard_rules", matcher: "an owner hard rule matches the tool and its subject", text: "deny with the rule's own message", switch: "stream hard_rules" },
  { id: "git_airbag", matcher: "a destructive git command runs on a dirty tree", text: "advice: the safety ref written and how to restore", switch: "stream git_airbag" },
  { id: "dependency_store", matcher: "an edit tool touches a lockfile or node_modules", text: "advice: dependencies change through the package manager", switch: "stream dependency_store" },
  { id: "reflexes", matcher: "a remembered failure line repeats in the tool call", text: "advice: the recorded fix", switch: "stream reflexes" },
  { id: "rule_loops", matcher: "the same denial fires again in the session", text: "advice: stop and change approach", switch: "stream rule_loops" },
  { id: "knowledge", matcher: "an edit tool call matches a knowledge note", text: "advice: the note's claim", switch: "stream knowledge" },
];

/** A guard row with an empty field, and a deny tag no inventory row names. */
export function guardInventoryGaps(denyTags: readonly string[] = []): { empty: string[]; unknown: string[] } {
  const known = new Set(GUARD_INVENTORY.map((row) => row.id));
  return {
    empty: GUARD_INVENTORY.filter((row) => !row.matcher || !row.text || !row.switch).map((row) => row.id),
    unknown: denyTags.filter((tag) => !known.has(tag)),
  };
}

export type SpendWindow = { label?: string; usedPercent: number; resetsAt?: string | null; model?: string | null };

/** A window of a model family (`opus`) applies to a model id that names it; a window of no model applies to all. */
export function windowAppliesTo(window: { model?: string | null | undefined }, model: string): boolean {
  const family = window.model?.trim().toLowerCase();
  return !family || model.toLowerCase().includes(family);
}

/** The windows at or past the threshold that apply to the model and have not reset yet: the one rule of the writer hold (usageHold) and the Task cap. */
export function spentWindows<T extends SpendWindow>(windows: readonly T[], input: { model: string; threshold: number; now: number }): T[] {
  return windows.filter((window) => windowAppliesTo(window, input.model) && window.usedPercent >= input.threshold
    && !(window.resetsAt && Date.parse(window.resetsAt) <= input.now));
}

/** A usage snapshot older than this no longer decides a Task; the hub rewrites an unchanged one hourly, so a live machine stays inside it. */
export const SNAPSHOT_MAX_AGE_MS = 90 * 60_000;

export function pretaskDecision(input: {
  role: string;
  kind: string;
  background: boolean;
  spawned: number;
  prompt?: string;
  claims?: string[];
  repo?: string;
  cap?: number;
  /** The machine's usage snapshot (SMA k_hs_spend): a Task past a human-set window cap is refused, after every other refusal, with the reset time. */
  usage?: { skipSetByHuman?: boolean; skipPercent?: number; windows?: SpendWindow[]; model?: string; at?: string; now?: number };
  /** Project rules and confirmed lessons the subagent-pack verb gathered (SMA k_h_pretask); empty when the switch or the verb gives none. */
  rules?: string[];
  lessons?: string[];
}): { deny?: string; prompt?: string; spawned: number; pack?: PackMeta } {
  const cap = input.cap ?? SUBAGENT_CAP;
  const kind = input.kind || "general-purpose";
  if (input.role === "writer" && !DOCUMENTARY_AGENTS.includes(kind as typeof DOCUMENTARY_AGENTS[number])) {
    return {
      deny: `[execution-without-agent] a writer does its task itself; subagent «${kind}» is refused here — only ${[...DOCUMENTARY_AGENTS].sort().join(", ")} (read and report) may help.`,
      spawned: input.spawned,
    };
  }
  // Subagent in the foreground only: a background subagent outlives the turn that owns its result.
  if (input.background) {
    return {
      deny: "[subagent-foreground] in a lane session a subagent runs in the foreground: call it again without run_in_background.",
      spawned: input.spawned,
    };
  }
  if (input.spawned >= cap) {
    return {
      deny: `[subagent-cap] ${input.spawned} subagents already in this session (cap ${cap}, LANE_SUBAGENT_CAP): finish with what you have or do it yourself.`,
      spawned: input.spawned,
    };
  }
  // The spend cap comes last: a call main refused keeps main's reason. 0 means off; a missing or unreadable `at` decides nothing.
  const usage = input.usage;
  const now = usage?.now ?? Date.now();
  const measured = usage?.at ? Date.parse(usage.at) : NaN;
  if (usage?.skipSetByHuman === true && typeof usage.skipPercent === "number" && usage.skipPercent > 0
    && Number.isFinite(measured) && now - measured <= SNAPSHOT_MAX_AGE_MS && measured - now <= 5 * 60_000) {
    const spent = spentWindows(usage.windows ?? [], { model: usage.model ?? "", threshold: usage.skipPercent, now });
    if (spent.length) {
      const worst = spent.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
      return {
        deny: `[spend-cap] the «${worst.label ?? "usage"}» window is at ${Math.round(worst.usedPercent)}% and the cap is ${usage.skipPercent}% (usage.skip_percent, set by a person): no subagent until it resets${worst.resetsAt ? ` at ${worst.resetsAt}` : " (reset time unknown)"}. Finish with what you have; the owner lifts the cap with: bb lane-pilot setting <project> usage.skip_percent=0`,
        spawned: input.spawned,
      };
    }
  }
  const spawned = input.spawned + 1;
  const pack = pretaskPack({ repo: input.repo, claims: input.claims, rules: input.rules, lessons: input.lessons });
  const prompt = input.prompt ?? "";
  if (prompt && !prompt.includes("[context pack]")) return { prompt: prompt + pack.text, spawned, pack: pack.meta };
  return { spawned, pack: pack.meta };
}

export type PackMeta = { chars: number; layers: { rules: number; lessons: number; claims: number }; trimmed: boolean; ranked: number };

/**
 * The pack a subagent is born with (SMA m_pack / k_h_pretask): the repo, the files its window claims, the
 * project's rules and the confirmed lessons — inside 2 KB. Layers drop in the order lessons, rules, claims
 * when the pack would not fit; `trimmed` says something was dropped and `ranked` how many items made it.
 */
export function pretaskPack(input: { repo?: string; claims?: string[]; rules?: string[]; lessons?: string[] }): { text: string; meta: PackMeta } {
  // The newest claims: a ledger lists oldest first, and a long session's early files are the stale ones.
  const claims = (input.claims ?? []).filter(Boolean).slice(-20);
  const rules = (input.rules ?? []).filter(Boolean).map((rule) => rule.slice(0, 200)).slice(0, 8);
  const lessons = (input.lessons ?? []).filter(Boolean).map((lesson) => lesson.slice(0, 200)).slice(0, 5);
  const build = (rs: string[], ls: string[], cs: string[]) =>
    `\n\n[context pack] Repository ${input.repo || "."}. Files this window claims: ${cs.join(", ") || "none"}.`
    + `${rs.length ? ` Rules: ${rs.join(" | ")}.` : ""}${ls.length ? ` Lessons: ${ls.join(" | ")}.` : ""}`
    + " Report the files you changed by path at the end.";
  let keepRules = rules, keepLessons = lessons, keepClaims = claims;
  let text = build(keepRules, keepLessons, keepClaims);
  let trimmed = false;
  const drop = [() => { keepLessons = keepLessons.slice(1); }, () => { keepRules = keepRules.slice(1); }, () => { keepClaims = keepClaims.slice(1); }];
  while (text.length > 2048 && (keepLessons.length || keepRules.length || keepClaims.length > 1)) {
    trimmed = true;
    for (const next of drop) { if (text.length <= 2048) break; next(); text = build(keepRules, keepLessons, keepClaims); }
  }
  if (text.length > 2048) { text = `${text.slice(0, 2040)}…`; trimmed = true; }
  return {
    text,
    meta: { chars: text.length, layers: { rules: keepRules.length, lessons: keepLessons.length, claims: keepClaims.length }, trimmed, ranked: keepRules.length + keepLessons.length + keepClaims.length },
  };
}

export function stallFingerprint(tool: string, toolInput: unknown, response: unknown): string {
  const body = JSON.stringify({ tool: tool.toLowerCase(), input: toolInput }) + stallResultText(response).slice(-2000).replace(VOLATILE, "#");
  let hash = 0;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash, 31) + body.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stallResultText(response: unknown): string {
  if (typeof response === "string") return response;
  try { return JSON.stringify(response) ?? ""; } // JSON.stringify(undefined) returns undefined, not a throw.
  catch { return String(response); }
}

export function stallFailed(response: unknown): boolean {
  if (response && typeof response === "object") {
    const row = response as Record<string, unknown>;
    if (row.is_error || row.error) return true;
    const code = row.exit_code ?? row.exitCode ?? row.returncode;
    if (typeof code === "number" && code !== 0) return true;
    if (row.interrupted === true) return true;
  }
  const text = stallResultText(response).slice(-2000).toLowerCase();
  return /\b(error|failed|traceback|exit code [1-9])\b/.test(text) && !/\b0 failed\b/.test(text);
}

/** Four stall rules. Advice only: the same failing call twice, then the third identical read, edit or other result. */
export function stallHint(tool: string, n: number, isFailed: boolean): string {
  const name = tool.toLowerCase();
  if (isFailed && n === 2 && !EDIT_TOOLS.has(name)) {
    return `[lane-stall class] the same failing call twice (${tool}). Do not run it a third time: change the angle. ${CLASS_SWEEP}`;
  }
  if (n < 3) return "";
  if (READ_TOOLS.has(name)) {
    return `[lane-stall] Identical ${tool} result has already been returned ${n} times. Reuse the earlier result and take the next task step; if you cannot proceed, report the concrete blocker instead of reading it again.`;
  }
  if (EDIT_TOOLS.has(name)) {
    return `[lane-stall] ${tool} on the same path with the same result ${n} times. Existing files need a targeted edit (old_string/new_string), never a whole-file rewrite.`;
  }
  return `[lane-stall] Same ${tool} result ${n} times. Change the hypothesis before retrying. ${CLASS_SWEEP}`;
}

/** The per-session stall record: fingerprint counts, the last calls' trail, the read-only run, and the patterns already nudged. */
export type StallState = {
  counts: Record<string, number>;
  /** Last 8 fingerprints, for the ping-pong rule (A B A B). */
  recent: string[];
  /** Read/Grep/Glob calls in a row with no Edit/Write/Bash between (the monologue rule). */
  readRun: number;
  /** «rule:fingerprint» keys that already nudged this session: one nudge per pattern (SMA k_hst_nudge). */
  nudged: string[];
};

/** A stall.json written before the trail existed is a bare counts map; it upgrades in place. */
export function stallStateOf(raw: unknown): StallState {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const row = raw as Record<string, unknown>;
    if (row.counts && typeof row.counts === "object") {
      return {
        counts: { ...(row.counts as Record<string, number>) },
        recent: Array.isArray(row.recent) ? row.recent.map(String).slice(-8) : [],
        readRun: typeof row.readRun === "number" ? row.readRun : 0,
        nudged: Array.isArray(row.nudged) ? row.nudged.map(String).slice(-60) : [],
      };
    }
    return { counts: { ...(row as Record<string, number>) }, recent: [], readRun: 0, nudged: [] };
  }
  return { counts: {}, recent: [], readRun: 0, nudged: [] };
}

/**
 * Four stuck rules on the plain call record, no model (SMA k_hst_detect): the same failing call twice, the same
 * result three times, the last six calls alternating between two fingerprints, eight read-only calls in a row.
 * Each pattern speaks once per session (SMA k_hst_nudge): a second hit of the same rule and fingerprint stays silent.
 */
export function stallObserve(state: Record<string, number> | StallState, tool: string, toolInput: unknown, response: unknown): { state: StallState; counts: Record<string, number>; hint: string; fingerprint: string } {
  const current = stallStateOf(state);
  const fingerprint = stallFingerprint(tool, toolInput, response);
  const name = tool.toLowerCase();
  current.counts[fingerprint] = (current.counts[fingerprint] ?? 0) + 1;
  const keys = Object.keys(current.counts);
  if (keys.length > 300) current.counts = Object.fromEntries(keys.slice(-300).map((key) => [key, current.counts[key]!]));
  current.recent = [...current.recent, fingerprint].slice(-8);
  current.readRun = READ_TOOLS.has(name) ? current.readRun + 1 : 0;

  // rule + fingerprint: a nudge repeats only for a different pattern or a different call.
  const say = (rule: string, text: string): string => {
    const key = `${rule}:${fingerprint}`;
    if (current.nudged.includes(key)) return "";
    current.nudged = [...current.nudged, key].slice(-60);
    return text;
  };
  const last6 = current.recent.slice(-6);
  const pingPong = last6.length === 6 && last6[0] === last6[2] && last6[2] === last6[4] && last6[1] === last6[3] && last6[3] === last6[5] && last6[0] !== last6[1];
  let hint = "";
  if (pingPong) hint = say("pingpong", "[lane-stall] you are alternating between two calls; stop and decide which result you trust");
  if (!hint && current.readRun >= 8) hint = say("monologue", "[lane-stall] eight read-only calls in a row and nothing written: write down what you know and take the next step");
  if (!hint) {
    const repeated = stallHint(tool, current.counts[fingerprint] ?? 1, stallFailed(response));
    if (repeated) hint = say("stall", repeated);
  }
  return { state: current, counts: current.counts, fingerprint, hint };
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

export function turnOutside(files: string[], claims: string[]): string[] {
  if (!claims.length) return [];
  return files.filter((file) => !claims.some((claim) => file === claim || file.endsWith(`/${claim}`) || claim.endsWith(`/${file}`) || file.includes(claim)));
}

export function subagentVerify(input: { claimed: string[]; changed: string[]; exists: (path: string) => boolean }): { missing: string[]; receipt: { claimed: string[]; missing: string[] } } {
  const changed = new Set(input.changed);
  const missing = input.claimed.filter((path) => !changed.has(path) && !input.exists(path)).sort();
  return {
    missing,
    receipt: { claimed: input.claimed.slice(0, 40), missing: missing.slice(0, 20) },
  };
}

export function subagentVerifyText(missing: string[]): string | null {
  if (!missing.length) return null;
  return `[subagent-verify] the subagent says it wrote ${missing.slice(0, 6).join(", ")}, but the tree does not have them: check before you rely on it.`;
}

export function hardRuleDeny(rules: HardRule[], tool: string, subject: string): string | null {
  for (const rule of rules) {
    if ((rule.tool && rule.tool.toLowerCase() !== tool.toLowerCase()) || !rule.pattern) continue;
    try {
      if (new RegExp(rule.pattern).test(subject)) return `[hard-rule] ${rule.message || rule.pattern}`;
    } catch { /* a bad pattern is skipped, the call is not */ }
  }
  return null;
}

export type ConventionGate = { id: string; pattern: string; paths?: string[]; message?: string; mode?: "warn" | "block" };

/** A project convention as a checkable rule (SMA k_lib_gates): `paths` entries are globs matched on the changed
 * file; a hit on an added line is the gate's `message`, warn by default. */
export function conventionGateHits(gates: ConventionGate[], patches: Record<string, string>): { warnings: string[]; blocks: string[] } {
  const warnings: string[] = [];
  const blocks: string[] = [];
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*").replace(/\?/g, ".")}$`);
  for (const gate of gates ?? []) {
    let regex: RegExp;
    try { regex = new RegExp(gate.pattern); } catch { continue; }
    const hit = Object.entries(patches).some(([path, patch]) => {
      if (gate.paths?.length && !gate.paths.some((candidate) => glob(candidate).test(path))) return false;
      return patch.split("\n").some((line) => line.startsWith("+") && !line.startsWith("+++") && regex.test(line));
    });
    if (hit) (gate.mode === "block" ? blocks : warnings).push(gate.message || gate.id);
  }
  return { warnings, blocks };
}

export function reflexAdvice(lines: string[], subject: string): string | null {
  for (const line of lines) {
    const match = /^\s*[-*]?\s*WHEN\s+(.+?)\s*(?:→|->)\s*(.+)$/.exec(line);
    if (match && subject.toLowerCase().includes(match[1]!.trim().toLowerCase())) return `[reflex] ${match[2]}`;
  }
  return null;
}

export function gitAirbag(command: string, sha: string | null, now = Date.now()): { ref?: string; advice?: string } {
  if (!command || !DESTRUCTIVE_GIT.test(command) || !sha) return {};
  const ref = `refs/lane-airbag/${Math.floor(now / 1000)}`;
  return { ref, advice: `[git-airbag] uncommitted work saved as ${ref} (${sha.slice(0, 10)}): \`git stash apply ${sha.slice(0, 10)}\` brings it back.` };
}

export function dependencyAdvice(path: string): string | null {
  if (!path || !DEPENDENCY_FILES.test(path)) return null;
  return `[dependency-store] ${path} belongs to the package manager: change the manifest and run the install, do not edit the lockfile or node_modules by hand.`;
}

export function ruleLoopAdvice(denials: Record<string, number>): string | null {
  let worst: [string, number] | null = null;
  for (const [name, count] of Object.entries(denials)) {
    if (!worst || count > worst[1]) worst = [name, count];
  }
  if (!worst || worst[1] < 3) return null;
  return `[rule-loop] «${worst[0]}» refused you ${worst[1]} times this session: stop retrying variants, change the approach or ask.`;
}

export function knowledgeAdvice(notes: Array<{ claim?: string }>): string | null {
  const claims = notes.map((note) => note.claim).filter((claim): claim is string => Boolean(claim)).slice(0, 2);
  return claims.length ? `[file-card] ${claims.map((claim) => claim.slice(0, 200)).join(" | ")}` : null;
}

export type StreamPerf = { stream: string; ms: number; error?: string };

/**
 * Streams in order over one shared context. Advice may skip after the soft budget.
 * A hard rule always runs. A thrown stream is recorded and skipped: A hook never wedges a session.
 */
export function runStreams(
  ctx: ToolCtx,
  now: () => number,
  runners: Partial<Record<StreamName, (ctx: ToolCtx) => { deny: string | null; advice: string | null }>> = defaultRunners,
): { deny: string | null; advice: string[]; perf: StreamPerf[]; denials: Record<string, number> } {
  const begun = now();
  const denials = { ...ctx.denials };
  const advice: string[] = [];
  const perf: StreamPerf[] = [];
  let deny: string | null = null;
  for (const name of STREAMS) {
    if (!REQUIRED_STREAMS.has(name) && (now() - begun) / 1000 > SOFT_BUDGET_SEC) {
      perf.push({ stream: name, ms: 0, error: "skipped: soft budget spent" });
      continue;
    }
    const started = now();
    try {
      const result = (runners[name] ?? defaultRunners[name])(ctx);
      perf.push({ stream: name, ms: Math.max(0, now() - started) });
      if (result.deny && !deny) {
        if (DENY_RIGHTS.has(name)) {
          deny = result.deny;
          denials[name] = (denials[name] ?? 0) + 1;
        } else {
          advice.push(`[downgraded] ${result.deny}`);
        }
      }
      if (result.advice) advice.push(result.advice);
    } catch (error) {
      perf.push({ stream: name, ms: Math.max(0, now() - started), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deny, advice, perf, denials };
}

const defaultRunners: Record<StreamName, (ctx: ToolCtx) => { deny: string | null; advice: string | null }> = {
  hard_rules: (ctx) => ({ deny: hardRuleDeny(ctx.rules ?? [], ctx.tool, ctx.command || ctx.path), advice: null }),
  git_airbag: (ctx) => {
    const saved = gitAirbag(ctx.command, ctx.sha ?? null);
    return { deny: null, advice: saved.advice ?? null };
  },
  dependency_store: (ctx) => ({ deny: null, advice: ctx.tool && EDIT_TOOLS.has(ctx.tool) ? dependencyAdvice(ctx.path) : null }),
  reflexes: (ctx) => ({ deny: null, advice: reflexAdvice(ctx.lessons ?? [], `${ctx.tool} ${ctx.command} ${ctx.path}`) }),
  rule_loops: (ctx) => ({ deny: null, advice: ruleLoopAdvice(ctx.denials) }),
  knowledge: (ctx) => ({ deny: null, advice: EDIT_TOOLS.has(ctx.tool.toLowerCase()) ? knowledgeAdvice(ctx.notes ?? []) : null }),
};

/**
 * A path a subagent may be said to have written: it has a folder part, no «..», and does not start with «/» or «~». A bare file
 * name counts only when `rootHas` says a file of that exact name sits at the repo root (`console.log`, `res.json` and `Next.js` are not paths).
 */
export function claimablePath(token: string, rootHas?: (name: string) => boolean): boolean {
  if (!token || token.includes("..") || token.startsWith("/") || token.startsWith("~")) return false;
  return token.includes("/") ? true : Boolean(rootHas?.(token));
}

/** Repo paths a subagent's last message names, 10 at most (SMA k_hsv_tree). */
export function claimedPaths(text: string, limit = 10, rootHas?: (name: string) => boolean): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/[\w@.-]+\/?[\w@./-]*\.[a-zA-Z0-9]{2,8}\b/g)) {
    const at = match.index ?? 0;
    // «/etc/x.txt» and «~/x.txt» lose their first character to the pattern; a link's host and path are no repo path.
    if (/[\/~]$/.test(text.slice(Math.max(0, at - 1), at)) || /:\/\/$/.test(text.slice(Math.max(0, at - 3), at))) continue;
    if (match[0].includes("..")) continue;
    const token = match[0].replace(/^[./]+/, "");
    if (!claimablePath(token, rootHas)) continue;
    found.add(token);
    if (found.size >= limit) break;
  }
  return [...found];
}

export type ClaimedState = "committed" | "dirty" | "untouched" | "phantom" | "unchecked";

/**
 * The tree's verdict on a claimed path (SMA k_hsv_tree): committed after the spawn, dirty now, present and
 * clean (untouched), or nowhere — not on disk, not in status, not in a commit — a phantom.
 */
export function claimedState(probe: { exists: boolean; dirty: boolean; committed: boolean }): ClaimedState {
  if (!probe.exists && !probe.dirty && !probe.committed) return "phantom";
  if (probe.committed) return "committed";
  if (probe.dirty) return "dirty";
  return "untouched";
}

/** The receipt line of a tree check: phantoms first, then the files the subagent never touched. */
export function treeVerifyText(states: ReadonlyArray<{ path: string; state: ClaimedState }>): string | null {
  const phantoms = states.filter((row) => row.state === "phantom").map((row) => row.path);
  const untouched = states.filter((row) => row.state === "untouched").map((row) => row.path);
  const unchecked = states.filter((row) => row.state === "unchecked").map((row) => row.path);
  if (!phantoms.length && !untouched.length && !unchecked.length) return null;
  const parts = [
    phantoms.length ? `phantoms (named but nowhere in the tree): ${phantoms.slice(0, 6).join(", ")}` : "",
    untouched.length ? `already in the tree, unchanged since before the spawn: ${untouched.slice(0, 6).join(", ")}` : "",
    unchecked.length ? `not checked in time: ${unchecked.slice(0, 6).join(", ")}` : "",
  ].filter(Boolean).join("; ");
  return `[subagent-verify] ${parts}: check before you rely on the report.`;
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
