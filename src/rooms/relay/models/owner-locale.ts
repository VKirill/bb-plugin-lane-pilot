/** The owner's explicit locale preference in KV. */
export const OWNER_LOCALE_PREFERENCE_KEY = "preferences:locale";
/** Last locale the UI resolved (including Auto); written by preferences get/set. */
export const OWNER_RESOLVED_LOCALE_KEY = "preferences:resolved-locale";

export type OwnerLocale = "ru" | "en";

export const SELF_REPAIR_GO_AHEAD_EN = "Go ahead as the report proposes";
export const SELF_REPAIR_LEAVE_EN = "Leave it";
const SELF_REPAIR_OPTIONS_EN = [SELF_REPAIR_GO_AHEAD_EN, SELF_REPAIR_LEAVE_EN] as const;

export function isOwnerLocale(value: unknown): value is OwnerLocale {
  return value === "ru" || value === "en";
}

export function selfRepairOwnerForm(locale: OwnerLocale, title: string): { question: string; options: [string, string] } {
  if (locale === "en") {
    return {
      question: `Self-repair of «${title}» needs your decision. Open the repair thread for its report.`,
      options: [SELF_REPAIR_GO_AHEAD_EN, SELF_REPAIR_LEAVE_EN],
    };
  }
  return {
    question: `Самоисправление «${title}» ждёт вашего решения. Откройте тред ремонта, чтобы прочитать отчёт.`,
    options: ["Делать, как предлагает отчёт", "Оставить как есть"],
  };
}

/** English option label for the repair-thread message; ids are 1-based as the form numbers them. */
export function englishSelfRepairChoice(choiceId: string): string | undefined {
  return SELF_REPAIR_OPTIONS_EN[Number(choiceId) - 1];
}

export function workflowHumanDetail(locale: OwnerLocale, runId: string, stepId: string): string {
  return locale === "en" ? `Workflow run ${runId}, step ${stepId}.` : `Запуск графа ${runId}, шаг ${stepId}.`;
}
