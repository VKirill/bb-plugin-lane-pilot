/**
 * What `lane_pilot_ask_owner` returns: the text the PM reads and BB shows the owner in the chat (a delivered tool result renders as
 * markdown). It was a JSON object, which the chat showed as raw `{ "answered": true, … }` lines (owner, 2026-10-27).
 */
export type OwnerAnswerLocale = "ru" | "en";
export type OwnerAnswerResult =
  | { answered: true; choice: string | null; text: string | null }
  | { answered: false; reason: string };

const T = {
  ru: { answered: "Владелец ответил", choice: "Выбор", reply: "Ответ", none: "без текста", timeout: "Владелец не ответил вовремя", dismissed: "Владелец закрыл вопрос",
    nextTimeout: "Реши сам, если это безопасно, или спроси ещё раз в ответе.", nextDismissed: "Реши сам, если это безопасно, или спроси в ответе." },
  en: { answered: "The owner answered", choice: "Choice", reply: "Reply", none: "no text", timeout: "The owner did not answer in time", dismissed: "The owner dismissed the question",
    nextTimeout: "Decide yourself if it is safe, or ask again in your reply.", nextDismissed: "Decide yourself if it is safe, or ask in your reply." },
} as const;

const quote = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n");

export function ownerAnswerText(result: OwnerAnswerResult, locale: OwnerAnswerLocale): string {
  const t = T[locale];
  if (!result.answered) {
    const timeout = result.reason === "timeout";
    return `**${timeout ? t.timeout : t.dismissed}.**\n\n${timeout ? t.nextTimeout : t.nextDismissed}`;
  }
  const lines = [`**${t.answered}**`];
  if (result.choice) lines.push(`**${t.choice}:** ${result.choice}`);
  const text = result.text?.trim();
  if (text) lines.push(`**${t.reply}:**\n\n${quote(text)}`);
  else if (!result.choice) lines.push(`_${t.none}_`);
  return lines.join("\n\n");
}
