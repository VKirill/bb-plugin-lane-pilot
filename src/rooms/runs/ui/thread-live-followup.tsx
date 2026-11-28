import { useState, type FormEvent } from "react";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import type { Strip } from "../../work-graph/ui";

export type ThreadLiveItem = {
  key: string; runId: string; taskId: string | null; title: string; column: "queued" | "running" | "checking" | "blocked" | "done"; phase: string;
  stage: string | null; model: string | null; since: number | null; threadId: string | null; updatedAt: number; detail: string | null; projectId?: string | null;
  kind?: "task" | "workflow" | "phase" | "batch"; state?: string;
};

export type ThreadLiveData = {
  role: "pm" | "writer" | "helper";
  pmThreadId: string | null;
  items: ThreadLiveItem[];
  strips: Record<string, Strip>;
  session: { runId: string; state: string; kind: string } | null;
} | null;

/** Follow-up message composer for the thread right panel (`threads.send`, `queue-if-active`). */
export function ThreadLiveFollowup({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      await sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: message, mentions: [] }],
      });
      setText("");
      setStatus({ kind: "ok", text: t("threadLiveSent") });
    } catch (cause) {
      setStatus({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-2" data-testid="thread-live-followup" onSubmit={(e) => void onSubmit(e)}>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("threadLivePlaceholder")}
        data-testid="thread-live-followup-input"
        className="w-full resize-none rounded-[10px] border border-[var(--lp-hairline)] bg-[var(--lp-card)] px-3 py-2 text-[12.5px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-xs">
          {status ? (
            <span className={status.kind === "error" ? "text-destructive" : "text-muted-foreground"} data-testid="thread-live-followup-status">
              {status.text}
            </span>
          ) : null}
        </div>
        <Button type="submit" size="sm" disabled={busy || !text.trim()} data-testid="thread-live-followup-send">
          {busy ? t("threadLiveSending") : t("threadLiveSend")}
        </Button>
      </div>
    </form>
  );
}
