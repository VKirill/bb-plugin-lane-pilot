/** The shared UI unit/enum strings and Shturman (lead) strings, merged into the plugin dictionaries by i18n.ts. */
export const leadUiEn = {
  fieldUnitTimes: "times",
  fieldUnitDays: "days",
  enumBaselineNotify: "Warn and go on",
  enumBaselineStop: "Do not start the writer",
  workGroupBaseline: "Baseline and night re-check",
  workGroupBaselineHelp: "What runs around a task for this project: the checks on the base before the writer, and the night re-check of accepted work.",
  cliOnlyTitle: "Retired Lane Stack CLI flags",
  cliOnlyHelp: "The command-line runner is gone. These stored values are not applied. Install folders are still read by the installer.",
} as const;

export const leadUiRu: { [K in keyof typeof leadUiEn]: string } = {
  fieldUnitTimes: "раз",
  fieldUnitDays: "дней",
  enumBaselineNotify: "Предупредить и идти дальше",
  enumBaselineStop: "Не запускать писателя",
  workGroupBaseline: "Базовая линия и ночная сверка",
  workGroupBaselineHelp: "Что запускается вокруг задачи в этом проекте: проверки на базе перед писателем и ночная сверка принятой работы.",
  cliOnlyTitle: "Снятые флаги Lane Stack CLI",
  cliOnlyHelp: "Запуск из командной строки снят. Эти сохранённые значения не применяются. Папки установки по-прежнему читает установщик.",
};
