import type { Hub } from "./hub";

/**
 * The owner card in the PM's prompt (A5; audit 2026-10-08 round 4, item 19). `renderCard` (src/anamnesis/whoami.ts) is the card of
 * the confirmed, non-sensitive records, nothing else: a draft, a candidate, a rejected record and everything marked sensitive or
 * private-to-the-owner stay out until the owner has confirmed them. This only fetches it for a PM that is starting:
 * - at most `PM_CARD_MAX_CHARS` characters, cut again here as a belt for a store that answers with more;
 * - nothing at all (not even a header) when there is no confirmed record, so a PM of an owner who has not used anamnesis sees no change;
 * - never an error and never a wait: a store that is not set up, a machine that is off or an answer that takes over `timeoutMs` give "".
 */
export const PM_CARD_MAX_CHARS = 1800;
const CARD_WAIT_MS = 4_000;

export async function ownerCardBlock(hub: Pick<Hub, "ask">, timeoutMs: number = CARD_WAIT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const card = await Promise.race([
      hub.ask({ op: "card", maxChars: PM_CARD_MAX_CHARS }, timeoutMs),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
    if (!card || card.records < 1) return "";
    return `\n\n${card.text.slice(0, PM_CARD_MAX_CHARS)}`;
  } catch {
    return "";
  } finally { clearTimeout(timer); }
}
