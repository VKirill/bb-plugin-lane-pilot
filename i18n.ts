import { fieldEn, fieldRu } from "./src/i18n-fields";

const chromeEn = {
  panelTitle: "Lane Pilot",
  enable: "Enable Lane Pilot",
  enabling: "Starting Lane Pilot…",
  failed: "Lane Pilot could not start",
  alreadyActive: "Lane Pilot is already active in this project",
  tabSettings: "Settings",
  tabMonitor: "Run Monitor",
  tabInstall: "Install",
  emptyProject: "Open a project to edit Lane Pilot settings.",
  emptyRuns: "No runs in this project yet.",
  loadError: "Could not load Lane Pilot data.",
  saving: "Saving…",
  saved: "Saved",
  casConflict: "Not saved: another change updated this setting. Reload and try again.",
  reload: "Reload",
  readonlyBadge: "Read only",
  gapBadge: "Gap",
  editableBadge: "Editable",
  importSource: "Imported once from YAML (S7)",
  importNone: "No YAML import for this project yet.",
  importRouting: "routing.profile.yaml",
  importNight: "night-shift.yaml",
  casVersion: "CAS version",
  projectIsolation: "Values are stored per project.",
  writerPicker: "Writer provider, model, and reasoning",
  jevEffort: "Jev effort gate",
  jevOpencode: "OpenCode Jev subsystem",
  languageField: "Interface language",
  detect: "Detect",
  install: "Install Lane Stack",
  connectOpencode: "Connect OpenCode",
  rollback: "Roll back",
  confirmTitle: "Confirm external operations",
  confirmBody:
    "Rollback will not reliably restore the system to its previous state — before and after will be recorded, not a restoration.",
  confirmList: "These external operations will run:",
  confirmContinue: "Confirm and continue",
  confirmCancel: "Cancel",
  opNpm: "npm install -g @rama_nigg/open-cursor",
  opOpenCursor: "open-cursor install",
  opMarketplace: "claude plugin marketplace add/update",
  opPluginInstall: "claude plugin install lane-stack@claude-lane-stack",
  opPluginUninstall: "claude plugin uninstall fast-jev-compaction@*",
  toastOk: "Done",
  toastError: "Operation failed",
  cancel: "Cancel",
  retry: "Retry",
  resume: "Resume",
  runId: "Run",
  attempt: "Attempt",
  state: "State",
  kind: "Kind",
  unapplied: "Settings not applied to this CLI run",
  noUnapplied: "All stored settings with a typed channel were applied.",
  result: "Writer result",
  installReceipt: "Install receipt",
  receipt: "Receipt",
  hostMissing: "No host is configured for this project.",
  snapshotPath: "Snapshot path",
  lastReceipt: "Last receipt",
  on: "On",
  off: "Off",
  confirmConnectOps: "Only OpenCode JSONC plugin list will be patched. install.sh commands are not run.",
  confirmRollbackOps: "Only snapshot files will be restored. install.sh commands are not repeated.",
  unappliedNoChannel: "no proven runtime channel",
  state_pending: "pending",
  state_queued: "queued",
  state_spawn_requested: "spawn requested",
  state_spawn_unknown: "spawn unknown",
  state_spawn_rejected: "spawn rejected",
  state_running: "running",
  state_provider_error: "provider error",
  state_timeout: "timeout",
  state_empty_output: "empty output",
  state_validation_failed: "validation failed",
  state_cancel_requested: "cancel requested",
  state_canceled: "canceled",
  state_accepted: "accepted",
  state_blocked: "blocked",
};

const chromeRu: { [K in keyof typeof chromeEn]: string } = {
  panelTitle: "Lane Pilot",
  enable: "Включить Lane Pilot",
  enabling: "Lane Pilot запускается…",
  failed: "Не удалось запустить Lane Pilot",
  alreadyActive: "Lane Pilot уже активен в этом проекте",
  tabSettings: "Настройки",
  tabMonitor: "Монитор запусков",
  tabInstall: "Установка",
  emptyProject: "Откройте проект, чтобы править настройки Lane Pilot.",
  emptyRuns: "В этом проекте ещё не было запусков.",
  loadError: "Не удалось загрузить данные Lane Pilot.",
  saving: "Сохранение…",
  saved: "Сохранено",
  casConflict: "Не сохранено: настройка уже изменена. Обновите и повторите.",
  reload: "Обновить",
  readonlyBadge: "Только чтение",
  gapBadge: "Нет канала",
  editableBadge: "Редактируется",
  importSource: "Однократный импорт из YAML (S7)",
  importNone: "Для этого проекта YAML ещё не импортировали.",
  importRouting: "routing.profile.yaml",
  importNight: "night-shift.yaml",
  casVersion: "Версия CAS",
  projectIsolation: "Значения хранятся отдельно для каждого проекта.",
  writerPicker: "Провайдер, модель и рассуждения писателя",
  jevEffort: "Переключатель Jev effort",
  jevOpencode: "Подсистема OpenCode Jev",
  languageField: "Язык интерфейса",
  detect: "Обнаружить",
  install: "Установить Lane Stack",
  connectOpencode: "Подключить OpenCode",
  rollback: "Откатить",
  confirmTitle: "Подтвердите внешние операции",
  confirmBody:
    "Откат не гарантированно вернёт систему в исходное состояние — будет зафиксировано состояние до и после, не восстановление.",
  confirmList: "Будут выполнены внешние операции:",
  confirmContinue: "Подтвердить и продолжить",
  confirmCancel: "Отмена",
  opNpm: "npm install -g @rama_nigg/open-cursor",
  opOpenCursor: "open-cursor install",
  opMarketplace: "claude plugin marketplace add/update",
  opPluginInstall: "claude plugin install lane-stack@claude-lane-stack",
  opPluginUninstall: "claude plugin uninstall fast-jev-compaction@*",
  toastOk: "Готово",
  toastError: "Операция не удалась",
  cancel: "Отменить",
  retry: "Повторить",
  resume: "Продолжить",
  runId: "Запуск",
  attempt: "Попытка",
  state: "Состояние",
  kind: "Тип",
  unapplied: "Настройки, не применённые к этому CLI-запуску",
  noUnapplied: "Все сохранённые настройки с типизированным каналом применены.",
  result: "Результат писателя",
  installReceipt: "Квитанция установки",
  receipt: "Квитанция",
  hostMissing: "Для проекта не задан host.",
  snapshotPath: "Путь снимка",
  lastReceipt: "Последняя квитанция",
  on: "Вкл",
  off: "Выкл",
  confirmConnectOps: "Будет изменён только список плагинов в OpenCode JSONC. Команды install.sh не запускаются.",
  confirmRollbackOps: "Будут восстановлены только файлы снимка. Команды install.sh повторно не выполняются.",
  unappliedNoChannel: "нет доказанного канала runtime",
  state_pending: "ожидание",
  state_queued: "в очереди",
  state_spawn_requested: "запрошен запуск",
  state_spawn_unknown: "запуск неизвестен",
  state_spawn_rejected: "запуск отклонён",
  state_running: "выполняется",
  state_provider_error: "ошибка провайдера",
  state_timeout: "таймаут",
  state_empty_output: "пустой вывод",
  state_validation_failed: "проверка не прошла",
  state_cancel_requested: "запрошена отмена",
  state_canceled: "отменено",
  state_accepted: "принято",
  state_blocked: "заблокировано",
};

export const en = { ...chromeEn, ...fieldEn };
export const ru: { [K in keyof typeof en]: string } = { ...chromeRu, ...fieldRu };

export type I18nKey = keyof typeof en;
export type Locale = "en" | "ru";

let localeOverride: Locale | null = null;

export function setLocaleOverride(next: Locale | null): void {
  localeOverride = next;
}

export function detectLocale(): Locale {
  if (localeOverride) return localeOverride;
  const lang = globalThis.document?.documentElement?.lang ?? "";
  return lang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export function t(key: I18nKey): string {
  return detectLocale() === "ru" ? ru[key] : en[key];
}

export function stateLabel(state: string): string {
  const key = `state_${state}` as I18nKey;
  return key in en ? t(key) : state;
}

export function unappliedReason(reason: string): string {
  if (reason === "no proven runtime channel") return t("unappliedNoChannel");
  return reason;
}

export function currentStrings(): { enable: string; enabling: string; failed: string; alreadyActive: string } {
  return {
    enable: t("enable"),
    enabling: t("enabling"),
    failed: t("failed"),
    alreadyActive: t("alreadyActive"),
  };
}
