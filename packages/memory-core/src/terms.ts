/** Words of a text as the search sees them: letters and digits, three characters or more, lower case. */
export function memoryTokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
}

/**
 * The part of a word that survives its ending (`ошибки`, `ошибка`, `ошибок` share `ошиб`; `calculateTotalPrice` still contains
 * `totalpri`): two letters off a word of six or more, never below four. Cheap enough for Russian morphology without a stemmer.
 */
export function memoryStem(token: string): string {
  return token.length >= 6 ? token.slice(0, Math.max(4, token.length - 2)) : token;
}
