import { t } from "@lane-pilot/i18n";
import { modelShort, providerShort } from "./model-names";
import type { StepExecutor } from "../../contracts";

export function sourceText(executor: Pick<StepExecutor, "source" | "sourceKey" | "settingsKey">): string {
  switch (executor.source) {
    case "table": return t("wfModelSrc_table");
    case "pinned": return t("wfModelSrc_pinned");
    case "stage": return t("wfModelSrc_stage").replace("{key}", executor.sourceKey ?? executor.settingsKey ?? "");
    case "pm": return t("wfModelSrc_pm");
    case "role-default": return t("wfModelSrc_role_default");
    case "writer": return `${t("wfModelSrc_writer")}${executor.sourceKey ? ` (${executor.sourceKey})` : ""}`;
    case "helper": return t("wfModelSrc_helper");
    case "session": return t("wfModelSrc_session").replace("{step}", executor.sourceKey ?? "");
    default: return t("wfModelSrc_none");
  }
}

/** «codex · gpt-6-luna · high · fast», the badge text and the read-only cell. */
export const executorLine = (executor: StepExecutor): string =>
  [providerShort(executor.providerId), modelShort(executor.model), executor.reasoningEffort, executor.serviceTier === "fast" ? t("wfModelFast") : null].filter(Boolean).join(" · ") || t("wfModelSrc_none");
