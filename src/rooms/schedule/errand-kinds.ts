/**
 * The kinds of an errand and the row of the role table each runs on. One errand graph (workflows/errand.json), one errand helper profile;
 * only the model differs: «open the app and record the screen» and «answer the ticket» stopped sharing one row (owner, 2026-11-01: every
 * errand of a session had fallen to the light model of the `errand` row). A kind is the PM's word (`lane_pilot_errand` `kind`, a schedule's
 * `errandKind`), else what the named skills, plugins, MCP servers or the words of the brief point at (`hintedErrandKind`), else the generic row. The kind is written into the run (`kind`,
 * `kindBy`) and the helper thread (`errandKind`), so the week's receipts say which kind ran on which model with what outcome.
 */
export const ERRAND_KINDS = ["computer", "devops", "browser", "research", "message"] as const;
export type ErrandKind = (typeof ERRAND_KINDS)[number];
export const isErrandKind = (value: unknown): value is ErrandKind => typeof value === "string" && (ERRAND_KINDS as readonly string[]).includes(value);

/** The row of the role table a kind runs on: its own row (`errand-<kind>`); a message, no kind or an unknown one runs on `errand`. */
export function errandKindRole(kind: string | null | undefined): string {
  return isErrandKind(kind) && kind !== "message" ? `errand-${kind}` : "errand";
}

export type ErrandKindHints = { task: string; skills?: readonly string[] | undefined; plugins?: readonly string[] | undefined; mcp?: readonly string[] | undefined };

type Hint = { kind: ErrandKind; names: readonly string[]; words: RegExp };
// ponytail: word lists in Russian and English only; a brief the regexes miss runs on the generic errand row, and the PM names the kind when it matters.
// Order matters within a pass: the first kind with a hit wins, research last because its words are the broadest.
const HINTS: readonly Hint[] = [
  { kind: "computer", names: ["computer-use", "claude-video", "roblox-build", "roblox-toolkit"], words: /запи(с[ьи]|ши) экран|screen ?record|roblox studio|открой приложение|open the app\b|на рабочем столе|desktop app|xcode\b|\bfinder\b/i },
  { kind: "devops", names: ["linux-sysadmin", "blender-video", "physics-shorts", "bb-core-vk", "blender"], words: /\bssh\b|установ[иь]|\binstall|deploy|выложи|разверн|docker|systemctl|\bpm2\b|nginx|angie|vast\.ai|арендован|\bgpu\b|blender|\brojo\b/i },
  { kind: "browser", names: ["browser-automation", "social-browser", "chrome-devtools"], words: /браузер|\bchrome\b|консол[ьи]\b|кабинет|cabinet|войди|log ?in\b|sign ?in\b|форм[ау]\b|нажми|\bclick\b|devtools|проверь на сайте|on the live site/i },
  { kind: "message", names: ["telegram-user", "telegram-rich-messages"], words: /письм[оа]|\bemail\b|тикет|ticket|ответ(ь|ить) (в|на)\b|сообщени[ея]|telegram|телеграм|рассылк/i },
  { kind: "research", names: ["tavily", "text-insights", "social-insights", "game-teardown", "alphaxiv"], words: /разбер[иа]|карт[ау] функци|сравни|исследуй|\bresearch\b|map the features|с источник|проанализируй|\banalys[ei]s?\b/i },
];

/** The kind the named skills, plugins and MCP servers point at (a name is an explicit ask, so it comes first), else the words of the brief; null when nothing does. */
export function hintedErrandKind(input: ErrandKindHints): ErrandKind | null {
  const named = new Set([...(input.skills ?? []), ...(input.plugins ?? []), ...(input.mcp ?? [])].map((name) => name.toLowerCase()));
  for (const hint of HINTS) if (hint.names.some((name) => named.has(name))) return hint.kind;
  for (const hint of HINTS) if (hint.words.test(input.task)) return hint.kind;
  return null;
}

export type ErrandKindPick = { kind: ErrandKind | "errand"; by: "pm" | "hint" | "none" };

/** The kind of an errand: the PM's word, else a hint from the named skills and the brief, else the generic row. No model is asked. */
export function classifyErrand(input: ErrandKindHints & { kind?: string | null | undefined }): ErrandKindPick {
  if (input.kind && isErrandKind(input.kind)) return { kind: input.kind, by: "pm" };
  const hinted = hintedErrandKind(input);
  return hinted ? { kind: hinted, by: "hint" } : { kind: "errand", by: "none" };
}
