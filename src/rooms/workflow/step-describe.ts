/**
 * A graph step described in full, from the raw workflow JSON: what the step does, what it gets, what it gives and
 * where the run goes next. The «Graph map» step card and the markdown export both print this, so a shared export
 * is enough for another agent to rebuild the graph without Lane Pilot's code.
 */
type Raw = Record<string, unknown>;
type Locale = "en" | "ru";
export type StepFact = { label: string; value: string };

const L = {
  ru: { type: "Тип", role: "Исполнитель", skills: "Навыки", task: "Задание", question: "Вопрос владельцу", options: "Варианты ответа", calls: "Вызывает граф", action: "Действие", params: "Параметры", forEach: "Для каждого", gets: "Получает", gives: "Отдаёт", gates: "Готово, когда", next: "Дальше", modes: "Только в режимах", skip: "Пропуск", limits: "Ограничения", other: "Прочие настройки", end: "конец графа" },
  en: { type: "Type", role: "Performer", skills: "Skills", task: "Task", question: "Question to the owner", options: "Answer options", calls: "Calls graph", action: "Action", params: "Parameters", forEach: "For each", gets: "Gets", gives: "Gives", gates: "Done when", next: "Next", modes: "Only in modes", skip: "Skipped", limits: "Limits", other: "Other settings", end: "end of graph" },
} as const;

const TYPE: Record<string, { ru: string; en: string }> = {
  agent: { ru: "агент (модель выполняет задание)", en: "agent (a model does the task)" },
  "lp-task": { ru: "задача программисту в отдельной ветке", en: "coding task in its own branch" },
  action: { ru: "действие кодом, без модели", en: "code action, no model" },
  decision: { ru: "развилка по данным", en: "branch on data" },
  jev: { ru: "быстрое суждение (Jev)", en: "quick judgment (Jev)" },
  human: { ru: "вопрос владельцу, ждёт ответа", en: "question to the owner, waits for the answer" },
  parallel: { ru: "параллельные ветки", en: "parallel branches" },
  join: { ru: "сбор параллельных веток", en: "join of parallel branches" },
  subworkflow: { ru: "вызов другого графа", en: "calls another graph" },
};

/** Keys printed by name; everything else that is not layout goes to «other settings» so nothing is lost. */
const SHOWN = new Set(["id", "type", "title", "label", "role", "profile", "prompt", "question", "options", "workflow", "action", "params", "for_each", "consumes", "out", "produces", "gates", "applicable_modes", "skip_when", "guards", "maxVisits", "maxAttempts", "timeoutSec", "position", "src", "provider", "model", "reasoning", "service_tier"]);

const str = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value);
const fieldNames = (value: unknown): string[] => Array.isArray(value)
  ? value.map((field) => typeof field === "string" ? field : str((field as Raw).name ?? (field as Raw).kind ?? field))
  : value && typeof value === "object" ? Object.keys(value as Raw) : [];
const titleOf = (node: Raw, locale: Locale): string => {
  const title = node.title as Raw | undefined;
  return (title && typeof title[locale] === "string" ? title[locale] as string : null) ?? (node.label as string | undefined) ?? String(node.id);
};

export function describeStep(definition: Raw, nodeId: string, locale: Locale = "ru"): StepFact[] {
  const l = L[locale];
  const nodes = (definition.nodes as Raw[] | undefined) ?? [];
  const edges = (definition.edges as Raw[] | undefined) ?? [];
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const facts: StepFact[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return;
    facts.push({ label, value: str(value) });
  };
  const type = String(node.type);
  add(l.type, TYPE[type]?.[locale] ?? type);
  add(l.role, node.role);
  add(l.skills, ((node.profile as Raw | undefined)?.skills as string[] | undefined)?.join(", "));
  add(l.task, node.prompt);
  add(l.question, node.question);
  add(l.options, (node.options as string[] | undefined)?.join(" / "));
  add(l.calls, node.workflow);
  add(l.action, node.action);
  if (node.params && Object.keys(node.params as Raw).length) add(l.params, node.params);
  add(l.forEach, node.for_each);
  const incoming = edges.filter((edge) => edge.to === nodeId).map((edge) => {
    const passed = edge.with ? ` (${Object.entries(edge.with as Raw).map(([key, from]) => `${key} ← ${str(from)}`).join(", ")})` : "";
    return `${str(edge.from)}${passed}`;
  });
  const consumed = fieldNames(node.consumes);
  add(l.gets, [incoming.join("; "), consumed.join(", ")].filter(Boolean).join(" · "));
  add(l.gives, fieldNames(node.out).join(", "));
  add(l.gates, (node.gates as string[] | undefined)?.join("; "));
  const next = edges.filter((edge) => edge.from === nodeId).map((edge) => `${str(edge.to)}${edge.when !== undefined ? ` (${str(edge.when)})` : ""}`);
  add(l.next, next.length ? next.join("; ") : l.end);
  add(l.modes, (node.applicable_modes as string[] | undefined)?.join(", "));
  add(l.skip, node.skip_when);
  const limits: Raw = { ...(node.guards as Raw | undefined) };
  for (const key of ["maxVisits", "maxAttempts", "timeoutSec"]) if (node[key] !== undefined) limits[key] = node[key];
  if (Object.keys(limits).length) add(l.limits, Object.entries(limits).map(([key, value]) => `${key} ${str(value)}`).join(", "));
  const rest = Object.fromEntries(Object.entries(node).filter(([key]) => !SHOWN.has(key)));
  if (Object.keys(rest).length) add(l.other, rest);
  return facts;
}

const INTRO = {
  ru: [
    "Как читать этот файл. Граф — это шаги и стрелки между ними. Запуск начинается с первого шага и идёт по стрелкам; стрелка с условием срабатывает, только когда условие верно. Шаг «агент» — модель с заданием и навыками; «вопрос владельцу» ждёт ответа человека; «параллельные ветки» запускают дочерние шаги для каждого элемента списка; «вызов другого графа» запускает граф целиком и берёт его выходы.",
    "Чтобы собрать такой граф у себя, отдайте агенту этот файл (и папку `workflows/` из zip-выгрузки, если она есть): в JSON — точные определения, здесь — их описание по шагам. «Навыки» — инструкции, которые агент загружает перед шагом; если у вас их нет, опишите шаг своими словами по полю «Задание».",
  ],
  en: [
    "How to read this file. A graph is steps and arrows between them. A run starts at the first step and follows the arrows; an arrow with a condition fires only when it holds. An «agent» step is a model with a task and skills; a «question to the owner» waits for a person; «parallel branches» run child steps for every item of a list; «calls another graph» runs a whole graph and takes its outputs.",
    "To rebuild such a graph elsewhere, hand an agent this file (and the `workflows/` folder of the zip export, if you have it): the JSON holds the exact definitions, this file describes them step by step. «Skills» are instructions the agent loads before the step; without them, describe the step in your own words from its «Task».",
  ],
} as const;

export const exportIntro = (locale: Locale = "ru"): string[] => INTRO[locale].flatMap((line) => [line, ""]);

/** One graph in markdown: description, inputs, outputs, then every step with its full description in file order. */
export function describeWorkflowMarkdown(definition: Raw, locale: Locale = "ru"): string[] {
  const name = (definition.name as Raw | undefined)?.[locale] ?? definition.id;
  const description = (definition.description as Raw | undefined)?.[locale];
  const lines = [`### ${str(name)} (\`${str(definition.id)}\`)`, ""];
  if (description) lines.push(str(description), "");
  const io = (label: string, value: unknown) => { const names = fieldNames(value); if (names.length) lines.push(`- **${label}:** ${names.join(", ")}`); };
  io(locale === "ru" ? "Входы графа" : "Graph inputs", definition.inputs);
  io(locale === "ru" ? "Выходы графа" : "Graph outputs", definition.outputs);
  if (definition.requires) lines.push(`- **${locale === "ru" ? "Требует" : "Requires"}:** ${str(definition.requires)}`);
  if (definition.entry) lines.push(`- **${locale === "ru" ? "Первый шаг" : "First step"}:** \`${str(definition.entry)}\``);
  lines.push("");
  for (const node of (definition.nodes as Raw[] | undefined) ?? []) {
    if (node.type === "note") continue;
    lines.push(`#### ${titleOf(node, locale)} (\`${str(node.id)}\`)`, "");
    for (const fact of describeStep(definition, String(node.id), locale)) {
      lines.push(fact.value.includes("\n") ? `- **${fact.label}:**\n\n  ${fact.value.replace(/\n/g, "\n  ")}` : `- **${fact.label}:** ${fact.value}`);
    }
    lines.push("");
  }
  return lines;
}
