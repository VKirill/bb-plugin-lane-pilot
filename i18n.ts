import { UNAPPLIED_REASON } from "./src/channels";
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
  validationInvalidChoice: "Invalid value for {key}. Allowed values: {allowed}",
  validationIncompatibleSetting: "Invalid {key} with {otherKey}={value}. Allowed values for {key}: {allowed}",
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
  writerEffortAdjusted: "Reasoning effort changed from {from} to {to} for provider {provider}.",
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
  unappliedNoConsumer: "stored key has no runtime consumer",
  unappliedInstallNotCli: "INSTALL-ENV applies on install.sh/host-worker, not this CLI binary",
  unappliedNotValid: "{channel} flag {flag} is not valid on {target}",
  unappliedPlanCritiqueMode: "plan-critique argparse has no --mode; task-v2 has no such field (E1)",
  unappliedPlanCritiqueEnabled: "plan-critique argparse has no --enabled flag",
  unappliedPlanCritiqueProvider: "plan-critique argparse has no --provider",
  unappliedPlanCritiqueModel: "plan-critique argparse has no --model",
  unappliedNightReviewModel: "night-shift has --provider but no --model",
  unappliedNightReviewEffort: "night-shift has no --reasoning-effort",
  unappliedBooleanOff: "upstream argparse is store_true; false has no off flag (bin/run-controller:1703-1707, bin/lane-ctl:3196-3200)",
  channelOffLimitation: "Off is not applied: run-controller/lane-ctl accept only --fast-mode (store_true). Saved false is listed as unapplied.",
  openReceipt: "Open CLI receipt",
  cliReceipt: "CLI receipt",
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
  validationInvalidChoice: "Недопустимое значение для {key}. Допустимые значения: {allowed}",
  validationIncompatibleSetting: "Недопустимое значение {key} при {otherKey}={value}. Допустимые значения для {key}: {allowed}",
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
  writerEffortAdjusted: "Уровень рассуждений изменён с {from} на {to} для провайдера {provider}.",
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
  unappliedNoConsumer: "сохранённый ключ не имеет потребителя runtime",
  unappliedInstallNotCli: "INSTALL-ENV применяется в install.sh/host-worker, не в этом CLI",
  unappliedNotValid: "флаг {channel} {flag} недопустим для {target}",
  unappliedPlanCritiqueMode: "у plan-critique нет argparse --mode; в task-v2 такого поля нет (E1)",
  unappliedPlanCritiqueEnabled: "у plan-critique нет флага --enabled",
  unappliedPlanCritiqueProvider: "у plan-critique нет argparse --provider",
  unappliedPlanCritiqueModel: "у plan-critique нет argparse --model",
  unappliedNightReviewModel: "у night-shift есть --provider, но нет --model",
  unappliedNightReviewEffort: "у night-shift нет --reasoning-effort",
  unappliedBooleanOff: "у argparse только store_true; флага выключения нет (bin/run-controller:1703-1707, bin/lane-ctl:3196-3200)",
  channelOffLimitation: "Выключение не применяется: run-controller/lane-ctl принимают только --fast-mode (store_true). Сохранённое false попадает в неприменённые.",
  openReceipt: "Открыть квитанцию CLI",
  cliReceipt: "Квитанция CLI",
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

export function validationMessage(code: "invalid_choice" | "incompatible_setting", params: string[]): string {
  if (code === "invalid_choice") {
    return t("validationInvalidChoice").replace("{key}", params[0] ?? "setting").replace("{allowed}", params[1] ?? "");
  }
  return t("validationIncompatibleSetting")
    .replace("{key}", params[0] ?? "setting")
    .replace("{otherKey}", params[1] ?? "setting")
    .replace("{value}", params[2] ?? "")
    .replace("{allowed}", params[3] ?? "");
}

export function stateLabel(state: string): string {
  const key = `state_${state}` as I18nKey;
  return key in en ? t(key) : state;
}

export function unappliedReason(reason: string): string {
  const exact: Record<string, I18nKey> = {
    [UNAPPLIED_REASON.noChannel]: "unappliedNoChannel",
    [UNAPPLIED_REASON.noConsumer]: "unappliedNoConsumer",
    [UNAPPLIED_REASON.installNotCli]: "unappliedInstallNotCli",
    [UNAPPLIED_REASON.planCritiqueMode]: "unappliedPlanCritiqueMode",
    [UNAPPLIED_REASON.planCritiqueEnabled]: "unappliedPlanCritiqueEnabled",
    [UNAPPLIED_REASON.planCritiqueProvider]: "unappliedPlanCritiqueProvider",
    [UNAPPLIED_REASON.planCritiqueModel]: "unappliedPlanCritiqueModel",
    [UNAPPLIED_REASON.nightReviewModel]: "unappliedNightReviewModel",
    [UNAPPLIED_REASON.nightReviewEffort]: "unappliedNightReviewEffort",
    [UNAPPLIED_REASON.booleanOffUnsupported]: "unappliedBooleanOff",
  };
  const key = exact[reason];
  if (key) return t(key);
  const invalid = /^(W-DIRECT|OPS-DIRECT|ENV-PASSTHROUGH|INSTALL-ENV) flag (.+) is not valid on (.+)$/.exec(reason);
  if (invalid) {
    return t("unappliedNotValid")
      .replace("{channel}", invalid[1] ?? "")
      .replace("{flag}", invalid[2] ?? "")
      .replace("{target}", invalid[3] ?? "");
  }
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
