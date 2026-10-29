/**
 * Session behaviour Claude Lane ran from sma_hooks.py and stall_check.py on every lane session.
 * Native Claude sessions Lane Pilot launches call the bundled session-hook.mjs. A sticky writer calls the capsule
 * helpers before BB compacts the thread. A hook never wedges a session: callers catch and continue.
 */

export const DOCUMENTARY_AGENTS = ["Explore", "Plan", "statusline-setup"] as const;
export const SUBAGENT_CAP = 8;
export const SOFT_BUDGET_SEC = 1.5;

const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);
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
  trigger?: string;
};

export type StreamName = "hard_rules" | "git_airbag" | "dependency_store" | "reflexes" | "rule_loops" | "knowledge";

export const STREAMS: StreamName[] = ["hard_rules", "git_airbag", "dependency_store", "reflexes", "rule_loops", "knowledge"];

const REQUIRED_STREAMS = new Set<StreamName>(["hard_rules"]);

export function pretaskDecision(input: {
  role: string;
  kind: string;
  background: boolean;
  spawned: number;
  prompt?: string;
  claims?: string[];
  repo?: string;
  cap?: number;
}): { deny?: string; prompt?: string; spawned: number } {
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
  const spawned = input.spawned + 1;
  const claims = (input.claims ?? []).slice(0, 20);
  const pack = `\n\n[context pack] Repository ${input.repo || "."}. Files this window claims: ${claims.join(", ") || "none"}. Report the files you changed by path at the end.`;
  const prompt = input.prompt ?? "";
  if (prompt && !prompt.includes("[context pack]")) return { prompt: prompt + pack, spawned };
  return { spawned };
}

export function stallFingerprint(tool: string, toolInput: unknown, response: unknown): string {
  const body = JSON.stringify({ tool: tool.toLowerCase(), input: toolInput }) + stallResultText(response).slice(-2000).replace(VOLATILE, "#");
  let hash = 0;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash, 31) + body.charCodeAt(i) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stallResultText(response: unknown): string {
  if (typeof response === "string") return response;
  try { return JSON.stringify(response); }
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

export function stallObserve(counts: Record<string, number>, tool: string, toolInput: unknown, response: unknown): { counts: Record<string, number>; hint: string; fingerprint: string } {
  const fingerprint = stallFingerprint(tool, toolInput, response);
  const next = { ...counts, [fingerprint]: (counts[fingerprint] ?? 0) + 1 };
  const keys = Object.keys(next);
  const trimmed = keys.length > 300 ? Object.fromEntries(keys.slice(-300).map((key) => [key, next[key]!])) : next;
  return { counts: trimmed, fingerprint, hint: stallHint(tool, trimmed[fingerprint] ?? 1, stallFailed(response)) };
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
  const body = { ...capsule };
  return `Capsule restored after compaction:\n${JSON.stringify(body).slice(0, 3000)}`;
}

export function progressRecord(input: { session: string; files: number; asks: number }): { session: string; files: number; asks: number } {
  return { session: input.session, files: input.files, asks: input.asks };
}

export function protectionsOff(env: Record<string, string | undefined>, guardRegistered: boolean): string[] {
  const off = ["LANE_STALL_CHECK", "LANE_COORD"].filter((name) => env[name] === "0");
  if (!guardRegistered) off.push("guard_shell.py is not registered");
  return off;
}

/** MEMORY.md budget line: the first 200 lines are what a session loads; say how close the injected memory is. */
export function memoryBudgetLine(lines: number): string | null {
  if (lines <= 0) return null;
  return `MEMORY.md: ${lines}/200 lines${lines > 170 ? " — near the limit: merge or trim entries" : ""}`;
}

export function sessionStartText(input: {
  model?: string;
  lastModel?: string;
  protections?: string[];
  memoryLines?: number;
  capsule?: Capsule | null;
  changed?: string[];
  account?: string;
}): string | null {
  const parts: string[] = [];
  if (input.lastModel && input.model && input.lastModel !== input.model) {
    parts.push(`Model change: this session ran on ${input.lastModel}, now on ${input.model}; earlier receipts of this window were made by the other model.`);
  }
  if (input.account) parts.push(`Subscription of this session: ${input.account}`);
  if (input.protections?.length) parts.push(`Protections switched off: ${input.protections.join("; ")}`);
  const budget = input.memoryLines != null ? memoryBudgetLine(input.memoryLines) : null;
  if (budget) parts.push(budget);
  if (input.changed?.length) parts.push(`What changed since last time:\n${input.changed.slice(0, 30).join("\n")}`);
  if (input.capsule) parts.push(capsuleRestored(input.capsule));
  return parts.length ? parts.join("\n\n") : null;
}

export function promptRecall(input: { hits: Array<{ id?: string; content?: string; text?: string }>; given: string[] }): { text: string | null; given: string[] } {
  const given = new Set(input.given);
  // never repeat what was given
  const fresh = input.hits.filter((hit) => hit.id && !given.has(String(hit.id))).slice(0, 3);
  if (!fresh.length) return { text: null, given: input.given };
  const next = [...given, ...fresh.map((hit) => String(hit.id))].slice(-300);
  const pointers = fresh.map((hit) => `- [${hit.id}] ${String(hit.content || hit.text || "").slice(0, 220)}`).join("\n");
  return { text: `Memory for these words (pointers, not orders):\n${pointers}`, given: next };
}

export function sessionEndDraft(input: { files: string[]; at: string }): string {
  return `# Farewell lesson draft (${input.at})\n\nThis session changed: ${input.files.slice(0, 20).join(", ") || "nothing"}.\nWhat should the next window know? (a draft: it waits for a person or the memory maintainer)\n`;
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
        deny = result.deny;
        denials[name] = (denials[name] ?? 0) + 1;
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
  knowledge: (ctx) => ({ deny: null, advice: EDIT_TOOLS.has(ctx.tool) ? knowledgeAdvice(ctx.notes ?? []) : null }),
};

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
