import {
  TelegramNotReadyError,
  TelegramSendError,
  TG_CHAT_NAME,
  TG_TOKEN_NAME,
  TG_TOPIC_NAME,
  type TelegramSend,
} from "../../models/telegram";

/** `ctx.secrets` (createSecrets) satisfies this. */
type SecretReader = { record(name: string): Promise<{ value: string | null } | null> };

export function createTelegramSender(deps: { secrets: SecretReader; fetchImpl?: typeof fetch }): TelegramSend {
  const doFetch = deps.fetchImpl ?? fetch;
  return async (text) => {
    const [token, chat, topic] = await Promise.all(
      [TG_TOKEN_NAME, TG_CHAT_NAME, TG_TOPIC_NAME].map(async (name) => (await deps.secrets.record(name))?.value?.trim() || ""),
    );
    const missing = [[TG_TOKEN_NAME, token], [TG_CHAT_NAME, chat], [TG_TOPIC_NAME, topic]]
      .filter(([, value]) => !value)
      .map(([name]) => name!);
    if (missing.length) throw new TelegramNotReadyError(missing);
    if (!/^\d+$/.test(topic!)) throw new TelegramNotReadyError([`${TG_TOPIC_NAME} (a number)`]);
    const body = new URLSearchParams({ chat_id: chat!, message_thread_id: topic!, text });
    const reply = await doFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!reply.ok) throw new TelegramSendError(reply.status, await reply.text().catch(() => ""));
  };
}
