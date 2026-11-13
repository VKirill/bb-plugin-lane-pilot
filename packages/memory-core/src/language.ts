/**
 * The language of a text, as far as the vector bridge needs it (`memory.vector_mode = bridge`): the share of Cyrillic letters among all Latin and
 * Cyrillic letters. The owner writes Russian and the notes are mostly English, so «other language» is the pair that words cannot cross.
 * No model and no word list: a text of mostly Cyrillic letters is `ru`, of mostly Latin `en`, a text with no such letters (digits, code, symbols) is `none`.
 */
export type TextLanguage = "ru" | "en" | "none";

export function cyrillicShare(text: string): number | null {
  let cyrillic = 0, latin = 0;
  for (const char of text) {
    if (/\p{Script=Cyrillic}/u.test(char)) cyrillic++;
    else if (/[A-Za-z]/.test(char)) latin++;
  }
  const total = cyrillic + latin;
  return total === 0 ? null : cyrillic / total;
}

/** `ru` above one half Cyrillic, `en` otherwise; `none` when the text has no letters of either script. */
export function languageOf(text: string): TextLanguage {
  const share = cyrillicShare(text);
  return share === null ? "none" : share > 0.5 ? "ru" : "en";
}

/** True when a note is in another language than the question, the only notes the vector bridge may add. A question without letters bridges to every note. */
export function crossesLanguage(question: TextLanguage, note: TextLanguage): boolean {
  if (question === "none") return true;
  return note !== "none" && note !== question;
}
