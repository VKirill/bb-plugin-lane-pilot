import { useState } from "react";
import { experimental_SourceCode as SourceCode, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Disclosure } from "@lane-pilot/ui-kit";

/** One stage's result body: the screen lists stages without it, so it is fetched when the owner opens this. */
export function StageResult({ runId, taskId, stageId }: { runId: string; taskId: string; stageId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{ status: "idle" | "loading" | "failed" } | { status: "ready"; result: unknown }>({ status: "idle" });
  const open = (isOpen: boolean) => {
    if (!isOpen || state.status === "loading") return;
    setState({ status: "loading" });
    void rpc.call("get_stage_result", { runId, taskId, stageId })
      .then((loaded) => setState({ status: "ready", result: loaded.result }))
      .catch(() => setState({ status: "failed" }));
  };
  return (
    <Disclosure compact testId={`stage-result-${runId}-${taskId}-${stageId}`} summary={t("stageResult")} onToggle={open}>
      {state.status === "ready"
        ? state.result != null
          ? <SourceCode content={JSON.stringify(state.result, null, 2)} path={`${stageId}-receipt.json`} overflow="scroll" />
          : <p className="text-xs text-muted-foreground">{t("stageNoEvidence")}</p>
        : <p className="text-xs text-muted-foreground">{state.status === "failed" ? t("stageResultFailed") : t("stageResultLoading")}</p>}
    </Disclosure>
  );
}
