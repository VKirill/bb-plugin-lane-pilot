/** The owner's explicit locale preference in KV. */
export const OWNER_LOCALE_PREFERENCE_KEY = "preferences:locale";
/** Last locale the UI resolved (including Auto); written by preferences get/set. */
export const OWNER_RESOLVED_LOCALE_KEY = "preferences:resolved-locale";

export type OwnerLocale = "ru" | "en";

export const SELF_REPAIR_GO_AHEAD_EN = "Go ahead as the report proposes";
export const SELF_REPAIR_LEAVE_EN = "Leave it";
const SELF_REPAIR_OPTIONS_EN = [SELF_REPAIR_GO_AHEAD_EN, SELF_REPAIR_LEAVE_EN] as const;

function isOwnerLocale(value: unknown): value is OwnerLocale {
  return value === "ru" || value === "en";
}

/**
 * The language of owner-facing forms: an explicit ru/en preference, else the last locale the UI
 * resolved (Auto), else Russian.
 */
export async function ownerLocale(bb: { storage: { kv: { get: (key: string) => Promise<unknown> } } }): Promise<OwnerLocale> {
  const stored = await bb.storage.kv.get(OWNER_LOCALE_PREFERENCE_KEY).catch(() => null);
  if (isOwnerLocale(stored)) return stored;
  const resolved = await bb.storage.kv.get(OWNER_RESOLVED_LOCALE_KEY).catch(() => null);
  return isOwnerLocale(resolved) ? resolved : "ru";
}

export async function recordResolvedLocale(bb: { storage: { kv: { set: (key: string, value: string) => Promise<unknown> } } }, locale: OwnerLocale): Promise<void> {
  await bb.storage.kv.set(OWNER_RESOLVED_LOCALE_KEY, locale);
}

export function councilOwnerForm(locale: OwnerLocale, question: string): { question: string; decideLabel: string } {
  const clipped = question.replace(/\s+/g, " ").slice(0, 160);
  if (locale === "en") {
    return {
      question: `The council «${clipped}» waits for you. Add a point, or let the chair decide.`,
      decideLabel: "Let the chair decide",
    };
  }
  return {
    question: `Совет «${clipped}» ждёт вас. Добавьте свой довод или позвольте председателю решить.`,
    decideLabel: "Пусть решит председатель",
  };
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
