export const strings = {
  en: {
    enable: "Enable Lane Pilot",
    enabling: "Starting Lane Pilot…",
    failed: "Lane Pilot could not start",
  },
  ru: {
    enable: "Включить Lane Pilot",
    enabling: "Lane Pilot запускается…",
    failed: "Не удалось запустить Lane Pilot",
  },
} as const;

export type LocaleStrings = { enable:string; enabling:string; failed:string };

export function currentStrings(): LocaleStrings {
  const language = typeof document === "undefined" ? "en" : document.documentElement.lang;
  return language.toLowerCase().startsWith("ru") ? strings.ru : strings.en;
}
