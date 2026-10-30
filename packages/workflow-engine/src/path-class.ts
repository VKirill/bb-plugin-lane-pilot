/**
 * How big and how risky an owner's request is, before any Opus call. The rules settle the obvious cases; a miss is not
 * confident and the intake asks Jev (`intake.path_class`). The short-path graph reads the result and does not call a model to classify.
 */
export const PATH_SIZES = ["tiny", "small", "large"] as const;
export const PATH_RISKS = ["low", "medium", "high"] as const;
export type PathSize = (typeof PATH_SIZES)[number];
export type PathRisk = (typeof PATH_RISKS)[number];
export type PathClass = { size: PathSize; risk: PathRisk; confident: boolean };

/** Same ceiling as the intake's unread-message rule: past this, the request is a goal, not a tweak. */
const LARGE_CHARS = 700;

const HIGH = /\b(password|passwd|secret|credential|oauth|payment|billing|checkout|stripe|migration|migrate|xss|csrf|auth(?:entication|orization)?)\b|парол|секрет|оплат|плат[её]ж|миграц|авторизац/i;
const LARGE = /\b(redesign|rewrite|architecture|architect|migration|several tasks|new feature)\b|архитектур|редизайн|перепиш|спроектир|несколько задач|новая фича|миграц/i;
const TINY = /\b(typo|rename|label|button|icon|color|colour|spacing|hint)\b|опечат|покрась|переимен|кнопк|иконк|подсказк|пробел/i;

const isSize = (value: unknown): value is PathSize => typeof value === "string" && (PATH_SIZES as readonly string[]).includes(value);
const isRisk = (value: unknown): value is PathRisk => typeof value === "string" && (PATH_RISKS as readonly string[]).includes(value);

/** What the code settles alone. `confident: false` goes to Jev; without Jev this reading stands. */
export function pathClassByRules(text: string): PathClass {
  const clean = text.trim();
  const high = HIGH.test(clean);
  const large = clean.length > LARGE_CHARS || LARGE.test(clean);
  if (large && high) return { size: "large", risk: "high", confident: true };
  if (large) return { size: "large", risk: "medium", confident: true };
  if (high) return { size: "small", risk: "high", confident: true };
  if (clean.length <= 180 && !clean.includes("\n\n") && TINY.test(clean)) return { size: "tiny", risk: "low", confident: true };
  if (clean.length <= 400) return { size: "small", risk: "low", confident: false };
  return { size: "small", risk: "medium", confident: false };
}

/**
 * The class a run starts with. A size and a risk already on the inputs (the intake's Jev) win. A requester severity of
 * critical or high still raises the risk, the same way the old triage kept a high rating.
 */
export function pathClassFrom(text: string, given: { size?: unknown; risk?: unknown; severity?: unknown } = {}): PathClass & { severity: string; by: "input" | "rules" } {
  const rules = pathClassByRules(text);
  const givenSize = given.size;
  const givenRisk = given.risk;
  let size = rules.size;
  let risk = rules.risk;
  let by: "input" | "rules" = "rules";
  if (isSize(givenSize) && isRisk(givenRisk)) { size = givenSize; risk = givenRisk; by = "input"; }
  const asked = typeof given.severity === "string" ? given.severity : "";
  if (asked === "critical" || asked === "high") risk = "high";
  const severity = asked === "critical" || asked === "high" || asked === "medium" || asked === "low" ? asked : risk;
  return { size, risk, severity, by, confident: by === "input" || rules.confident };
}
