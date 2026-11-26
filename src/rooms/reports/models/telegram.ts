/**
 * Where the owner's Telegram reports go. Nothing secret lives in code or settings: the bot token, the chat and the topic are Env Catalog
 * records read per send (Lane Pilot's one door to the catalog is createSecrets). The names are fixed here; the values are the owner's.
 *  - TG_AIVECH_BOT        the bot (the one the daily report always used)
 *  - TG_OWNER_CHAT_ID     the owner's chat
 *  - LANE_PILOT_TG_TOPIC  the topic «BB-сервис» inside that chat (a record of its own: the catalog had no topic id)
 */
export const TG_TOKEN_NAME = "TG_AIVECH_BOT";
export const TG_CHAT_NAME = "TG_OWNER_CHAT_ID";
export const TG_TOPIC_NAME = "LANE_PILOT_TG_TOPIC";

export type TelegramSend = (text: string) => Promise<void>;

/** The plain reason a send cannot start, naming the catalog record the owner has to add; never a value. */
export class TelegramNotReadyError extends Error {
  constructor(readonly missing: string[]) {
    super(`Telegram is not set up: Env Catalog has no value for ${missing.join(", ")}`);
    this.name = "TelegramNotReadyError";
  }
}

/** A Telegram HTTP failure; the text never carries the token (the URL is not repeated). */
export class TelegramSendError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Telegram refused the message (HTTP ${status}): ${detail.slice(0, 200)}`);
    this.name = "TelegramSendError";
  }
}
