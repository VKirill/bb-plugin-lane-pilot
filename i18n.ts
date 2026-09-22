export const strings = {
  en: {
    enable: "Enable Lane Pilot",
    enabling: "Starting Lane Pilot…",
    failed: "Lane Pilot could not start",
    alreadyActive: "Lane Pilot is already active in this project",
  },
  ru: {
    enable: "Включить Lane Pilot",
    enabling: "Lane Pilot запускается…",
    failed: "Не удалось запустить Lane Pilot",
    alreadyActive: "Lane Pilot уже активен в этом проекте",
  },
} as const;

export type LocaleStrings = { enable:string; enabling:string; failed:string; alreadyActive:string };

export function currentStrings(): LocaleStrings {
  const language = typeof document === "undefined" ? "en" : document.documentElement.lang;
  return language.toLowerCase().startsWith("ru") ? strings.ru : strings.en;
}
