/**
 * Pure pre-tool streams, guard inventory, spend-window checks, convention gates, and subagent context pack rules.
 */

export const DOCUMENTARY_AGENTS = ["Explore", "Plan", "statusline-setup"] as const;
export const SUBAGENT_CAP = 8;
export const SOFT_BUDGET_SEC = 1.5;

export const EDIT_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);
const DESTRUCTIVE_GIT = /\bgit\s+(checkout\s+--|restore\b|reset\b|clean\b|stash\s+(drop|clear)|rebase\b|branch\s+-D)/;
const DEPENDENCY_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|Gemfile\.lock)$|(^|\/)node_modules\//;

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
