import { useMemo, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { readOwnerAskPayload, type OwnerAskResponse } from "../models/owner-ask-shared";
import { Disclosure } from "@lane-pilot/ui-kit";

/**
 * A question Lane Pilot (the PM, the integration gate, a repair thread) puts to the owner: what the owner is
 * asked, the tappable answers, and a field for words of their own. It renders in the chat's composer as BB's pending
 * interaction; the same question reaches the phone as a push. Touch-sized rows, the Pokecut card and accent from app.css.
 */
export function OwnerAsk({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const payload = useMemo(() => readOwnerAskPayload(interaction.payload), [interaction.payload]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ownAnswer, setOwnAnswer] = useState(false);
  const send = (response: OwnerAskResponse) => {
    setBusy(true);
    void submit(response as never).catch(() => undefined).finally(() => setBusy(false));
  };
  const dismiss = () => { void cancel().catch(() => undefined); };

  if (!payload) {
    return (
      <div className="lp-chat lp-card flex flex-col gap-3 p-4" data-bb-plugin="lane-pilot" data-testid="owner-ask-broken">
        <p className="text-sm text-muted-foreground">{t("ownerAskBroken")}</p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={dismiss}>{t("ownerAskDismiss")}</Button>
      </div>
    );
  }
  const { question, detail, options, allowText } = payload;
  const words = text.trim();
  // With tappable answers the text field waits behind «Your own answer»; a question with no answers shows it at once.
  const showText = allowText && (ownAnswer || options.length === 0);
  const optionClass = "h-10 min-w-0 justify-start whitespace-normal px-3.5 text-left text-[12.5px] sm:h-[33px]";
  return (
    <div className="lp-chat lp-card flex min-w-0 flex-col gap-2.5 border-[var(--lp-chat-accent)] p-4" data-bb-plugin="lane-pilot" data-bb-ru-skip data-testid="owner-ask" data-source={payload.source}>
      <div className="min-w-0 truncate text-xs font-bold text-[var(--lp-chat-accent)]">{t("ownerAskHeading")}</div>
      <p className="whitespace-pre-wrap text-[13.5px] font-medium leading-snug text-foreground" style={{ overflowWrap: "anywhere" }} data-testid="owner-ask-question">{question}</p>
      {detail ? (
        <Disclosure summary={t("ownerAskContext")} compact testId="owner-ask-detail">
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{detail}</p>
        </Disclosure>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="owner-ask-options">
        {options.map((option, index) => (
          <Button key={option.id} type="button" size="sm" variant={index === 0 ? "default" : "outline"} disabled={busy} className={optionClass}
            onClick={() => send({ choice: option.id, ...(words ? { text: words } : {}) })}>
            {option.label}
          </Button>
        ))}
        {allowText && options.length > 0 ? (
          <Button type="button" size="sm" variant="outline" disabled={busy} aria-expanded={ownAnswer} data-testid="owner-ask-own" className={optionClass} onClick={() => setOwnAnswer((open) => !open)}>
            {t("ownerAskOwnAnswer")}
          </Button>
        ) : null}
        {!showText ? <Button type="button" variant="ghost" size="sm" className="self-start text-muted-foreground sm:ml-1" disabled={busy} onClick={dismiss}>{t("ownerAskDismiss")}</Button> : null}
      </div>
      {showText ? (
        <div className="flex flex-col gap-2">
          {/* 16px text on phones keeps iOS from zooming into the field. */}
          <textarea aria-label={t("ownerAskPlaceholder")} placeholder={t("ownerAskPlaceholder")} value={text} maxLength={4000} disabled={busy}
            className="min-h-16 w-full rounded-lg border border-[var(--lp-hairline)] bg-[var(--lp-well)]/40 p-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:text-sm"
            style={{ overflowWrap: "anywhere" }}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && words && !busy) send({ text: words }); }} />
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" disabled={busy} onClick={dismiss}>{t("ownerAskDismiss")}</Button>
            <Button type="button" size="sm" disabled={busy || !words} className="h-10 sm:h-[33px]" onClick={() => send({ text: words })}>{t("ownerAskSend")}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
