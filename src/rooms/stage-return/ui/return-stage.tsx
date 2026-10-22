import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, Disclosure } from "@lane-pilot/ui-kit";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";

type Answer = z.infer<(typeof rpcContract)["task_return_stage"]["output"]>;
type Reply = { ok?: boolean; state?: string; reason?: string; next?: string; paused?: string | null; stale?: Array<{ stage: string }>; reused?: string[]; restarted?: { note?: string } };
const STAGES = ["discussion", "planning", "writer"] as const;
type Stage = (typeof STAGES)[number];
const NOTE_MAX = 4000;

/**
 * «Return to a stage…» in the task card (atlas delta D0-2): the person picks where the task goes back to and writes what that stage did not
 * know. The note is an action, not a confirmation: sending it records the intervention, stops what runs and restarts from that stage with the
 * note in its input; the answer says what was stale, what was kept and who works on the task now.
 */
export function ReturnStage({ runId, taskId, onDone }: { runId: string; taskId: string; onDone?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [to, setTo] = useState<Stage>("planning");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const words = note.trim();

  const send = () => {
    if (!words || busy) return;
    setBusy(true);
    setReply(null);
    void rpc.call("task_return_stage", { ref: taskId, to, note: words, by: "owner" }).then((answer: Answer) => {
      setReply(answer as Reply);
      if ((answer as Reply).ok) { setNote(""); onDone?.(); }
    }).catch((cause: unknown) => setReply({ ok: false, reason: cause instanceof Error ? cause.message : String(cause) }))
      .finally(() => setBusy(false));
  };

  return (
    <section className="mt-4" data-testid="return-stage" data-run={runId}>
      <Disclosure compact testId="return-stage-open" summary={t("ret_title")}>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{t("ret_help")}</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("ret_title")}>
            {STAGES.map((stage) => (
              <Button key={stage} type="button" size="sm" variant={to === stage ? "default" : "outline"} role="radio" aria-checked={to === stage} disabled={busy}
                data-testid={`return-to-${stage}`} onClick={() => setTo(stage)}>{t(`ret_to_${stage}` as I18nKey)}</Button>
            ))}
          </div>
          {/* 16px text on phones keeps iOS from zooming into the field. */}
          <textarea aria-label={t("ret_note")} placeholder={t("ret_note")} value={note} maxLength={NOTE_MAX} disabled={busy} data-testid="return-note"
            className="min-h-20 w-full rounded-lg border border-[var(--lp-outline)] bg-[var(--lp-card)] p-2 text-base shadow-[var(--lp-drop)] sm:text-sm"
            style={{ overflowWrap: "anywhere" }} onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send(); }} />
          <div className="flex items-center justify-end gap-2">
            <Button type="button" disabled={busy || !words} className="h-10 sm:h-9" data-testid="return-send" onClick={send}>{busy ? t("ret_sending") : t("ret_send")}</Button>
          </div>
          {reply ? (
            <div className={`break-words text-xs ${reply.ok ? "text-muted-foreground" : "text-destructive"}`} data-testid="return-result" data-ok={reply.ok ? "true" : "false"}>
              {reply.ok ? (
                <>
                  <p>{t("ret_ok")}</p>
                  {reply.paused ? <p>{reply.paused}</p> : null}
                  {reply.restarted?.note ? <p>{reply.restarted.note}</p> : null}
                  <p>{t("ret_stale")}: {reply.stale?.length ? reply.stale.map((row) => row.stage).join(", ") : "–"} · {t("ret_kept")}: {reply.reused?.length ? reply.reused.join(", ") : "–"}</p>
                </>
              ) : (
                <>
                  <p>{reply.reason ?? t("ret_failed")}</p>
                  {reply.next ? <p>{reply.next}</p> : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </Disclosure>
    </section>
  );
}
