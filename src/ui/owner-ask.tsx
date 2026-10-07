import { useMemo, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { t } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { ownerAskPayloadSchema, type OwnerAskResponse } from "../owner-ask";
import { Disclosure } from "./disclosure";

/**
 * A question Lane Pilot (the PM, the integration gate, a repair thread, a council) puts to the owner: what the owner is
 * asked, the tappable answers, and a field for words of their own. It renders in the chat's composer as BB's pending
 * interaction; the same question reaches the phone as a push. Touch-sized rows, the Pokecut card and accent from app.css.
 */
export function OwnerAsk({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const parsed = useMemo(() => ownerAskPayloadSchema.safeParse(interaction.payload), [interaction.payload]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = (response: OwnerAskResponse) => {
    setBusy(true);
    void submit(response as never).catch(() => undefined).finally(() => setBusy(false));
  };
  const dismiss = () => { void cancel().catch(() => undefined); };

  if (!parsed.success) {
    return (
      <div className="lp-card flex flex-col gap-3 p-3" data-bb-plugin="lane-pilot" data-testid="owner-ask-broken">
        <p className="text-sm text-muted-foreground">{t("ownerAskBroken")}</p>
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={dismiss}>{t("ownerAskDismiss")}</Button>
      </div>
    );
  }
  const { question, detail, options, allowText } = parsed.data;
  const words = text.trim();
  return (
    <div className="lp-card flex min-w-0 flex-col gap-3 p-3" data-bb-plugin="lane-pilot" data-bb-ru-skip data-testid="owner-ask" data-source={parsed.data.source}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name="MessageQuestion" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{t("ownerAskHeading")}</span>
      </div>
      <p className="whitespace-pre-wrap text-sm font-medium leading-snug" style={{ overflowWrap: "anywhere" }} data-testid="owner-ask-question">{question}</p>
      {detail ? (
        <Disclosure summary={t("ownerAskContext")} compact testId="owner-ask-detail">
          <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{detail}</p>
        </Disclosure>
      ) : null}
      {options.length ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-testid="owner-ask-options">
          {options.map((option) => (
            <Button key={option.id} type="button" variant="outline" disabled={busy} className="h-10 min-w-0 justify-start whitespace-normal text-left sm:h-9"
              onClick={() => send({ choice: option.id, ...(words ? { text: words } : {}) })}>
              {option.label}
            </Button>
          ))}
        </div>
      ) : null}
      {allowText ? (
        <div className="flex flex-col gap-2">
          {/* 16px text on phones keeps iOS from zooming into the field. */}
          <textarea aria-label={t("ownerAskPlaceholder")} placeholder={t("ownerAskPlaceholder")} value={text} maxLength={4000} disabled={busy}
            className="min-h-16 w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-base shadow-[var(--lp-drop)] sm:text-sm"
            style={{ overflowWrap: "anywhere" }}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && words && !busy) send({ text: words }); }} />
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={dismiss}>{t("ownerAskDismiss")}</Button>
            <Button type="button" disabled={busy || !words} className="h-10 sm:h-9" onClick={() => send({ text: words })}>{t("ownerAskSend")}</Button>
          </div>
        </div>
      ) : (
        <Button type="button" variant="ghost" size="sm" className="self-start" disabled={busy} onClick={dismiss}>{t("ownerAskDismiss")}</Button>
      )}
    </div>
  );
}
