import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * How Lane Pilot's agent tools read in a chat timeline (BB grammar v3, `registerTool({ presentation })`). Without it
 * every call shows as «Ran lane_pilot_wait_writer», which tells the owner nothing. A label is capped at 80 characters
 * and BB has no locale hook for it, so the language is fixed when the plugin starts, from the owner's stored choice;
 * on «Auto» it is the locale the app last resolved, and both languages stand in one label only when none is known yet.
 * `quiet` rows are collapsed by default: calls the PM repeats in a loop or that only read.
 */
type Labels = { pending: string; completed: string };
type Entry = { en: Labels; ru: Labels; quiet?: true };

const row = (enPending: string, enCompleted: string, ruPending: string, ruCompleted: string, quiet?: true): Entry =>
  ({ en: { pending: enPending, completed: enCompleted }, ru: { pending: ruPending, completed: ruCompleted }, ...(quiet ? { quiet } : {}) });

export const TOOL_PRESENTATION: Record<string, Entry> = {
  lane_pilot_read: row("Reading a workspace file", "Read a workspace file", "Читаю файл рабочей папки", "Прочитан файл рабочей папки", true),
  lane_pilot_dispatch_writer: row("Sending a task to a writer", "Sent a task to a writer", "Отправляю задачу писателю", "Задача отправлена писателю"),
  lane_pilot_cancel_task: row("Canceling a task", "Canceled a task", "Отменяю задачу", "Задача отменена"),
  lane_pilot_update_task: row("Updating a task", "Updated a task", "Обновляю задачу", "Задача обновлена"),
  lane_pilot_reassign_task: row("Reassigning a task", "Reassigned a task", "Переназначаю задачу", "Задача переназначена"),
  lane_pilot_wait_writer: row("Waiting for a writer", "Waited for a writer", "Жду писателя", "Дождался писателя", true),
  lane_pilot_answer_writer: row("Answering a writer", "Answered a writer", "Отвечаю писателю", "Ответ писателю отправлен"),
  lane_pilot_ask_owner: row("Asking the owner", "The owner answered", "Спрашиваю владельца", "Владелец ответил"),
  lane_pilot_browser_qa: row("Checking the page in a browser", "Checked the page in a browser", "Проверяю страницу в браузере", "Страница проверена в браузере"),
  lane_pilot_ingest_opencode_telemetry: row("Reading OpenCode telemetry", "Read OpenCode telemetry", "Читаю телеметрию OpenCode", "Телеметрия OpenCode прочитана"),
  lane_pilot_workspace_status: row("Checking the workspace", "Checked the workspace", "Проверяю рабочую папку", "Рабочая папка проверена"),
  lane_pilot_memory_context: row("Reading project memory", "Read project memory", "Читаю память проекта", "Память проекта прочитана"),
  lane_pilot_gate_report: row("Reading the gate report", "Read the gate report", "Читаю отчёт проверки", "Отчёт проверки прочитан"),
  lane_pilot_council_start: row("Opening a council", "Opened a council", "Открываю совет", "Совет открыт"),
  lane_pilot_council_status: row("Checking the council", "Checked the council", "Смотрю состояние совета", "Состояние совета получено"),
  lane_pilot_council_say: row("Speaking to the council", "Spoke to the council", "Пишу в совет", "Сообщение в совет отправлено"),
  lane_pilot_council_stop: row("Closing the council", "Closed the council", "Закрываю совет", "Совет закрыт"),
  lane_pilot_browser: row("Using the owner's browser", "Used the owner's browser", "Работаю в браузере владельца", "Браузер владельца использован"),
  lane_pilot_errand: row("Starting an errand", "Started an errand", "Запускаю поручение", "Поручение запущено"),
  lane_pilot_wait_errand: row("Waiting for an errand", "Waited for an errand", "Жду поручение", "Дождался поручения", true),
  lane_pilot_handoff_create: row("Creating a handoff card", "Created a handoff card", "Создаю карточку передачи", "Карточка передачи создана"),
  lane_pilot_handoff_receipt: row("Recording a handoff receipt", "Recorded a handoff receipt", "Записываю квитанцию передачи", "Квитанция передачи записана"),
  lane_pilot_handoff_list: row("Listing handoffs", "Listed handoffs", "Смотрю передачи", "Передачи получены"),
  lane_pilot_run_health: row("Checking run health", "Checked run health", "Проверяю состояние прогона", "Состояние прогона проверено"),
  lane_pilot_routing_stats: row("Reading routing stats", "Read routing stats", "Читаю статистику маршрутов", "Статистика маршрутов прочитана"),
  lane_pilot_lessons_sweep: row("Sweeping lessons", "Swept lessons", "Собираю уроки", "Уроки собраны"),
  lane_pilot_rule_propose: row("Proposing a rule", "Proposed a rule", "Предлагаю правило", "Правило предложено"),
  lane_pilot_lesson: row("Saving a lesson", "Saved a lesson", "Сохраняю урок", "Урок сохранён"),
  lane_pilot_learned: row("Reading what was learned from the owner", "Read what was learned from the owner", "Смотрю, чему научился на сообщениях владельца", "Посмотрел, чему научился"),
  lane_pilot_memory_golden: row("Checking golden memory", "Checked golden memory", "Проверяю эталонную память", "Эталонная память проверена"),
  lane_pilot_ask: row("Asking another chat", "Asked another chat", "Спрашиваю другой чат", "Вопрос другому чату отправлен"),
  lane_pilot_reply: row("Answering another chat", "Answered another chat", "Отвечаю другому чату", "Ответ другому чату отправлен"),
  lane_pilot_relay_list: row("Listing relay items", "Listed relay items", "Смотрю вопросы и напоминания", "Вопросы и напоминания получены", true),
  lane_pilot_route: row("Choosing a workflow", "Chose a workflow", "Подбираю граф", "Граф подобран"),
  lane_pilot_run_workflow: row("Starting a workflow", "Started a workflow", "Запускаю граф", "Граф запущен"),
  lane_pilot_workflow_amend: row("Changing the goals of a run", "Changed the goals of a run", "Меняю цели запуска", "Цели запуска изменены"),
  lane_pilot_workflow_status: row("Checking a workflow run", "Checked a workflow run", "Смотрю ход графа", "Ход графа получен", true),
  lane_pilot_specialist: row("Starting a specialist", "Started a specialist", "Запускаю специалиста", "Специалист запущен"),
  lane_pilot_workflow_draft_create: row("Starting a workflow draft", "Started a workflow draft", "Начинаю черновик графа", "Черновик графа создан"),
  lane_pilot_workflow_draft_patch: row("Changing the workflow draft", "Changed the workflow draft", "Дорабатываю граф", "Граф доработан"),
  lane_pilot_workflow_draft_get: row("Reading the workflow draft", "Read the workflow draft", "Читаю черновик графа", "Черновик графа прочитан", true),
  lane_pilot_workflow_capabilities: row("Checking what a chain can use", "Checked what a chain can use", "Смотрю, что доступно графу", "Доступное графу проверено", true),
  lane_pilot_workflow_draft_test: row("Testing the workflow on stubs", "Tested the workflow on stubs", "Проверяю граф на заглушках", "Граф проверен на заглушках"),
  lane_pilot_workflow_draft_publish: row("Publishing the workflow", "Published the workflow", "Публикую граф", "Граф опубликован"),
  lane_pilot_schedule: row("Working with the schedule", "Worked with the schedule", "Работаю с расписанием", "С расписанием поработал"),
  lane_pilot_phase: row("Moving the phase", "Moved the phase", "Веду фазу", "Фазу провёл"),
  lane_pilot_queue: row("Working with the queue", "Worked with the queue", "Работаю с очередью", "С очередью поработал"),
  lane_pilot_facts: row("Reading the facts", "Read the facts", "Читаю факты", "Факты прочитал"),
  lane_pilot_check: row("Running a check", "Ran a check", "Запускаю проверку", "Проверку запустил"),
  lane_pilot_permit: row("Answering a permit", "Answered a permit", "Отвечаю на разрешение", "На разрешение ответил"),
  lane_pilot_forge: row("Working in the forge", "Worked in the forge", "Работаю в кузнице", "В кузнице поработал"),
  // The PM's folded tools (src/pm-tool-families.ts): one row per family, BB cannot label by action.
  lane_pilot_helpers: row("Calling a helper", "Called a helper", "Зову помощника", "Помощник отработал"),
  lane_pilot_council: row("Working with the council", "Worked with the council", "Работаю с советом", "С советом поработал"),
  lane_pilot_relay: row("Writing to another chat", "Wrote to another chat", "Пишу в другой чат", "Другой чат получил сообщение"),
  lane_pilot_memory: row("Working with project memory and lessons", "Worked with project memory and lessons", "Работаю с памятью и уроками", "С памятью и уроками поработал"),
  lane_pilot_workflow_draft: row("Working on a workflow draft", "Worked on a workflow draft", "Работаю над черновиком графа", "Над черновиком графа поработал"),
  lane_pilot_tool_search: row("Looking for a Lane Pilot tool", "Looked for a Lane Pilot tool", "Ищу инструмент Lane Pilot", "Инструмент Lane Pilot найден", true),
  lane_pilot_wait_specialist: row("Waiting for a specialist", "Waited for a specialist", "Жду специалиста", "Дождался специалиста", true),
};

export type ToolLocale = "en" | "ru" | "both";

const cap = (text: string) => text.length > 80 ? `${text.slice(0, 79)}…` : text;

export type ToolPresentation = { label: Labels; suppress?: true };

/** The presentation of one tool, or undefined for a tool this table does not know (BB then shows its standard row). */
export function presentationFor(name: string, locale: ToolLocale): ToolPresentation | undefined {
  const entry = TOOL_PRESENTATION[name];
  if (!entry) return undefined;
  const label = locale === "en" ? entry.en : locale === "ru" ? entry.ru
    : { pending: cap(`${entry.en.pending} / ${entry.ru.pending}`), completed: cap(`${entry.en.completed} / ${entry.ru.completed}`) };
  return { label, ...(entry.quiet ? { suppress: true as const } : {}) };
}

/**
 * The language of the labels: the owner's stored choice; on «Auto» the locale the app last resolved (`recordResolvedLocale`);
 * both languages only when nothing is known yet (a fresh install, before the app first opened). `known` is that locale, or null.
 */
export const toolLocale = (known: "en" | "ru" | null): ToolLocale => known ?? "both";

const localeByApi = new WeakMap<object, ToolLocale>();

/** Plugin start binds the locale once; every tool registered on this plugin API afterwards carries its presentation. */
export function bindToolLocale(bb: BbPluginApi, locale: ToolLocale): void {
  localeByApi.set(bb.agents, locale);
}

export const boundPresentation = (agents: object, name: string): ToolPresentation | undefined => {
  const locale = localeByApi.get(agents);
  return locale ? presentationFor(name, locale) : undefined;
};
