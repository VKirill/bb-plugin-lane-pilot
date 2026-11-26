import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Button, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";

type FirstRunState = {
  needed: boolean;
  steps: ReadonlyArray<{ id: "goal" | "writer" | "quality" | "words"; question: string }>;
  draft: { answers: Partial<Record<string, string>>; done?: number };
};

/** First-run onboarding card in Project Overview: four short setup questions plus one finish write into settings. */
export function FirstRunCard({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FirstRunState | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    let active = true;
    void rpc.call("first_run_get", { projectId })
      .then((next) => { if (active) { setState(next as FirstRunState); setError(null); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [rpc, projectId]);

  useEffect(() => reload(), [reload]);

  if (!state) return null;
  if (!state.needed && state.draft.done) return null;

  const step = state.steps.find((row) => !state.draft.answers[row.id]);
  const answered = state.steps.filter((row) => state.draft.answers[row.id]);
  if (!state.needed && answered.length === 0) return null;

  const submitAnswer = () => {
    if (!step || !answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    void rpc.call("first_run_answer", { projectId, step: step.id, answer: answer.trim() })
      .then(() => { setAnswer(""); reload(); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const finish = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void rpc.call("first_run_finish", { projectId })
      .then(() => reload())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <Surface testId="first-run-card">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("firstRunTitle")}</h2></SurfaceHeader>
      <SurfaceBody className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2" data-testid="first-run-interview">
          {step ? (
            <>
              <p className="text-sm font-medium">{state.steps.indexOf(step) + 1}/{state.steps.length} · {step.question}</p>
              <textarea
                rows={2}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                aria-label={step.id}
                data-testid="first-run-answer-input"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-base sm:text-sm"
              />
              <Button type="button" size="sm" disabled={!answer.trim() || busy} data-testid="first-run-send" onClick={submitAnswer}>
                {t("firstRunSend")}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" disabled={busy} data-testid="first-run-finish" onClick={finish}>
              {t("firstRunFinish")}
            </Button>
          )}
          {error ? <p className="text-xs text-destructive" data-testid="first-run-error">{error}</p> : null}
        </div>
        <div data-testid="first-run-ready">
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t("firstRunReady")}</p>
          <ul className="space-y-1 text-sm">
            {answered.map((row) => <li key={row.id}>✓ {row.id}: {state.draft.answers[row.id]}</li>)}
          </ul>
        </div>
      </SurfaceBody>
    </Surface>
  );
}
