/**
 * The words an owner reads on a connection instead of the expression behind it: `brainstorm.status in ['ok','low_confidence']` is
 * «если ok или неуверенно», `build.status == 'partial' && visits('replan') == 0` is «если частично и ещё не перепланировали».
 * Pure and free of schema code, so the browser can use it. What the reader cannot say in words stays as the atom's own text, so the
 * label is never wrong, only less friendly; the full expression is always the tooltip's.
 */
export type LabelLang = "en" | "ru";
/** The title of a node by id, for «replan ran N times»; absent, the id itself is said. */
export type NameOf = (id: string) => string | null;

const STATUS: Record<string, { en: string; ru: string }> = {
  ok: { en: "ok", ru: "ok" }, low_confidence: { en: "low confidence", ru: "неуверенно" }, partial: { en: "partial", ru: "частично" },
  done: { en: "done", ru: "готово" }, pass: { en: "passed", ru: "пройдено" }, fail: { en: "failed", ru: "провал" }, failed: { en: "failed", ru: "ошибка" },
  rework: { en: "needs rework", ru: "на доработку" }, closed: { en: "closed", ru: "закрыто" }, unmet: { en: "not met", ru: "не выполнено" },
  blocked: { en: "blocked", ru: "заблокировано" }, accepted: { en: "accepted", ru: "принято" }, confirmed: { en: "confirmed", ru: "подтверждено" },
  inconclusive: { en: "inconclusive", ru: "неубедительно" }, refuted: { en: "refuted", ru: "опровергнуто" }, clarify: { en: "clarify", ru: "уточнить" },
  proceed: { en: "proceed", ru: "продолжить" }, accept: { en: "accept", ru: "принять" }, ship: { en: "ship", ru: "выпускать" }, fix: { en: "fix", ru: "исправить" },
  timeout: { en: "timeout", ru: "таймаут" }, large: { en: "large", ru: "большой" }, unknown: { en: "unknown", ru: "неясно" }, no_go: { en: "no go", ru: "не идти" },
  critical: { en: "critical", ru: "критично" }, high: { en: "high", ru: "высокий" }, issues: { en: "issues", ru: "замечания" }, provide: { en: "provide", ru: "дать данные" },
  continue: { en: "continue", ru: "продолжить" }, review: { en: "review", ru: "проверить" },
};
const FIELD: Record<string, { en: string; ru: string }> = {
  verdict: { en: "verdict", ru: "вердикт" }, answer_kind: { en: "answer", ru: "ответ" }, confidence: { en: "confidence", ru: "уверенность" }, disposition: { en: "decision", ru: "решение" },
  state: { en: "state", ru: "состояние" }, severity: { en: "severity", ru: "серьёзность" }, scope_verdict: { en: "scope", ru: "объём" }, recommendation: { en: "recommendation", ru: "рекомендация" },
  ok: { en: "succeeded", ru: "успешно" }, found: { en: "found", ru: "найдено" }, confirmed: { en: "confirmed", ru: "подтверждено" }, needs_clarification: { en: "needs clarification", ru: "нужны уточнения" },
  no_framework: { en: "no test framework", ru: "нет тестового фреймворка" }, gate_ok: { en: "gate passed", ru: "ворота пройдены" },
};
/** «ran already» for the steps a loop counts: `visits('replan') == 0` is «replan has not run yet» — said with the step's own past tense when it is common. */
const DID: Array<[RegExp, { en: string; ru: string }]> = [
  [/^replan/, { en: "not re-planned yet", ru: "ещё не перепланировали" }], [/^investigate/, { en: "not investigated yet", ru: "ещё не исследовали" }],
  [/^(re_)?review/, { en: "not reviewed yet", ru: "ещё не проверяли" }], [/^plan_fix|^fix_plan/, { en: "plan not fixed yet", ru: "план ещё не правили" }],
  [/^autofix/, { en: "not auto-fixed yet", ru: "ещё не чинили" }], [/^ask_more/, { en: "not asked yet", ru: "ещё не спрашивали" }],
];

/** «not <field>» said as a phrase of its own where «не <field>» would be wrong Russian. */
const NEGATED: Record<string, { en: string; ru: string }> = {
  ok: { en: "failed", ru: "не успешно" }, found: { en: "not found", ru: "не найдено" }, gate_ok: { en: "gate failed", ru: "ворота не пройдены" },
  confirmed: { en: "not confirmed", ru: "не подтверждено" }, passes: { en: "does not pass", ru: "не проходит" },
};
const notField = (field: string, lang: LabelLang) => NEGATED[field]?.[lang] ?? (lang === "ru" ? `нет: ${fieldWord(field, lang)}` : `not ${fieldWord(field, lang)}`);

const words = (text: string) => text.replace(/[_.]+/g, " ").trim();
const statusWord = (value: string, lang: LabelLang) => STATUS[value]?.[lang] ?? words(value);
const fieldWord = (field: string, lang: LabelLang) => FIELD[field]?.[lang] ?? words(field);

/** Splits at a top-level separator, ignoring the ones inside quotes, brackets and parentheses. */
function splitTop(text: string, separator: "&&" | "||"): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && text.startsWith(separator, index)) { parts.push(text.slice(start, index)); start = index + 2; index += 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const unwrap = (text: string): string => {
  let value = text.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0, closes = -1;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "(") depth += 1;
      else if (value[index] === ")") { depth -= 1; if (depth === 0) { closes = index; break; } }
    }
    if (closes !== value.length - 1) break;
    value = value.slice(1, -1).trim();
  }
  return value;
};

const literal = (raw: string): { text: string; kind: "string" | "number" | "boolean" | "other" } => {
  const value = raw.trim();
  const quoted = /^(['"])(.*)\1$/.exec(value);
  if (quoted) return { text: quoted[2]!, kind: "string" };
  if (/^-?\d+(\.\d+)?$/.test(value)) return { text: value, kind: "number" };
  if (value === "true" || value === "false") return { text: value, kind: "boolean" };
  return { text: value, kind: "other" };
};
const list = (raw: string): string[] => raw.split(",").map((item) => literal(item).text).filter(Boolean);

type Left = { kind: "visits"; id: string } | { kind: "length"; field: string } | { kind: "field"; field: string; status: boolean } | { kind: "other"; text: string };
function left(raw: string): Left {
  const text = raw.trim();
  const visits = /^visits\(\s*['"]([^'"]+)['"]\s*\)$/.exec(text);
  if (visits) return { kind: "visits", id: visits[1]! };
  const ref = /^([$A-Za-z_][\w$]*(?:\.[\w$]+)+|[$A-Za-z_][\w$]*)$/.exec(text);
  if (!ref) return { kind: "other", text };
  const parts = text.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "length") return { kind: "length", field: parts.slice(0, -1).join(".") };
  return { kind: "field", field: parts[parts.length - 1]!, status: parts[parts.length - 1] === "status" };
}

const quoteName = (name: string) => `«${name}»`;

function atom(raw: string, lang: LabelLang, nameOf: NameOf): string {
  const text = unwrap(raw);
  const ru = lang === "ru";
  const not = /^!\s*(.+)$/.exec(text);
  if (not && !text.startsWith("!=")) {
    const inner = unwrap(not[1]!);
    const target = left(inner);
    if (target.kind === "field") return notField(target.field, lang);
    return `${ru ? "не" : "not"} (${atom(inner, lang, nameOf)})`;
  }
  const membership = /^(.+?)\s+(not in|in)\s+\[(.*)\]$/.exec(text);
  if (membership) {
    const target = left(membership[1]!);
    const values = list(membership[3]!).map((value) => (target.kind === "field" && !target.status && !FIELD[target.field] ? value : statusWord(value, lang)));
    const joined = values.join(ru ? " или " : " or ");
    const negative = membership[2] === "not in";
    if (target.kind === "field" && target.status) return negative ? `${ru ? "не" : "not"} ${joined}` : joined;
    if (target.kind === "field") return `${fieldWord(target.field, lang)}${negative ? (ru ? " не" : " not") : ""}: ${joined}`;
    return text;
  }
  const comparison = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/.exec(text);
  if (comparison) {
    const target = left(comparison[1]!);
    const op = comparison[2]!;
    const value = literal(comparison[3]!);
    if (target.kind === "visits") {
      const name = nameOf(target.id) ?? words(target.id);
      if (op === "==" && value.text === "0") {
        const verb = nameOf(target.id) ? undefined : DID.find(([pattern]) => pattern.test(target.id))?.[1];
        return verb ? verb[lang] : ru ? `${quoteName(name)} ещё не было` : `${quoteName(name)} has not run yet`;
      }
      if ((op === "<" || op === "<=") && value.kind === "number") {
        const times = op === "<" ? Number(value.text) : Number(value.text) + 1;
        return ru ? `${quoteName(name)} было меньше ${times} раз` : `${quoteName(name)} ran fewer than ${times} times`;
      }
      return text;
    }
    if (target.kind === "length" && value.text === "0" && (op === ">" || op === "!=")) return ru ? `${words(target.field.split(".").pop()!)} не пусто` : `${words(target.field.split(".").pop()!)} not empty`;
    if (target.kind === "length" && value.text === "0" && op === "==") return ru ? `${words(target.field.split(".").pop()!)} пусто` : `${words(target.field.split(".").pop()!)} empty`;
    if (target.kind === "field") {
      const shown = value.kind === "string" ? statusWord(value.text, lang) : value.text;
      if (target.status) return op === "!=" ? `${ru ? "не" : "not"} ${shown}` : op === "==" ? shown : `${ru ? "статус" : "status"} ${op} ${shown}`;
      if (value.kind === "boolean") return value.text === (op === "!=" ? "false" : "true") ? fieldWord(target.field, lang) : notField(target.field, lang);
      if (value.kind === "string" && value.text === "" && (op === "==" || op === "!=")) return `${fieldWord(target.field, lang)} ${(op === "==") === true ? (ru ? "пусто" : "is empty") : (ru ? "задано" : "is set")}`;
      return `${fieldWord(target.field, lang)} ${op === "==" ? "=" : op === "!=" ? "≠" : op} ${shown}`;
    }
    return text;
  }
  const target = left(text);
  if (target.kind === "field") return fieldWord(target.field, lang);
  return text;
}

/** «если …» for a condition, or null when there is none. Several conditions read as «и» (and) / «или» (or). */
export function humanCondition(when: string | null | undefined, lang: LabelLang, nameOf: NameOf = () => null): string | null {
  const expression = when?.replace(/\s+/g, " ").trim();
  if (!expression) return null;
  const ru = lang === "ru";
  const alternatives = splitTop(expression, "||").map((group) => splitTop(unwrap(group), "&&").map((part) => atom(part, lang, nameOf)).join(ru ? " и " : " and "));
  const body = alternatives.join(ru ? " или " : " or ");
  return `${ru ? "если" : "if"} ${body}`;
}

/** The label of a connection: the author's own `label`, else the words of its condition, else nothing. */
export function edgeCaption(edge: { label: string | null; when: string | null }, lang: LabelLang, nameOf?: NameOf): string | null {
  return edge.label?.trim() || humanCondition(edge.when, lang, nameOf);
}

export const OTHERWISE = { en: "otherwise", ru: "иначе" } as const;
