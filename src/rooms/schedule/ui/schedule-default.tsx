import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { ERRAND_BUILTIN, SCHEDULE_ERRAND_DEFAULT_KEY } from "../errand-model";
import type { ErrandDefaultView } from "../views";
import { PRESET_SLUGS } from "@lane-pilot/models";
import { Surface, SurfaceBody } from "@lane-pilot/ui-kit";
import { errorText, fill } from "./schedule-parts";
import { defaultSeed, modelLine } from "./schedule-who";
import { useModelCatalog } from "../../workflow/ui";
import { NativeModelPicker } from "../../workflow/ui";

/**
 * «Default executor»: the model scheduled errands run on when the task names none. Collapsible, at the top of the schedule area. At the
 * global page it edits the global value; inside a project, that project's own value, with «Inherit» to drop it and let the global one show.
 * It reads and writes through the generic settings RPCs (`save_setting`, `reset_project_settings`); the versions come with `schedule_list`.
 */
type Value = NonNullable<ErrandDefaultView["effective"]>;
const NONE = "__none";

function summary(value: ErrandDefaultView["effective"]): string {
  if (!value) return `${modelLine({ providerId: ERRAND_BUILTIN.providerId, model: ERRAND_BUILTIN.model, reasoningEffort: ERRAND_BUILTIN.reasoningEffort, serviceTier: null })}`;
  if ("preset" in value) return value.preset;
  return modelLine({ providerId: value.provider, model: value.model, reasoningEffort: value.reasoning_effort ?? "", serviceTier: value.service_tier ?? null });
}

export function ScheduleDefaultBlock({ projectId, value, onChanged }: { projectId: string | null; value: ErrandDefaultView; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const catalog = useModelCatalog(projectId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const level = projectId ? "project" : "global";
  const own = level === "project" ? value.project : value.global;
  const version = level === "project" ? value.projectVersion : value.globalVersion;
  const target = projectId ?? GLOBAL_SETTINGS_PROJECT_ID;

  const run = async (work: () => Promise<{ ok: boolean; conflict: boolean; validation?: { params: string[] } | undefined }>) => {
    setBusy(true); setMessage(null);
    try {
      const result = await work();
      if (result.ok) setMessage({ tone: "ok", text: t("schDefSaved") });
      else setMessage({ tone: "error", text: result.conflict ? t("schDefConflict") : fill(t("schDefError"), { reason: result.validation?.params.join(": ") ?? "?" }) });
      onChanged();
    } catch (cause) { setMessage({ tone: "error", text: fill(t("schDefError"), { reason: errorText(cause) }) }); } finally { setBusy(false); }
  };
  const save = (next: Value) => run(() => rpc.call("save_setting", { projectId: target, key: SCHEDULE_ERRAND_DEFAULT_KEY, value: next, expectedVersion: version }));
  // Inside a project the row is dropped, so the global value shows through; at the global level there is nothing above, so the value is cleared.
  const drop = () => run(() => level === "project"
    ? rpc.call("reset_project_settings", { projectId: target, keys: [SCHEDULE_ERRAND_DEFAULT_KEY], expectedVersions: { [SCHEDULE_ERRAND_DEFAULT_KEY]: version } })
    : rpc.call("save_setting", { projectId: target, key: SCHEDULE_ERRAND_DEFAULT_KEY, value: null, expectedVersion: version }));

  const source = value.source ? t(value.source === "project" ? "schDefSource_project" : "schDefSource_global") : fill(t("schDefSource_none"), { source: summary(null) });
  const shown = value.source ? summary(value.effective) : null;
  const seed = defaultSeed(own ?? value.effective);

  return (
    <Surface testId="sch-default">
      <button type="button" className="lp-panel-head w-full min-w-0 flex-wrap justify-between gap-x-3 gap-y-1 text-left" aria-expanded={open} aria-controls="sch-default-body"
        data-testid="sch-default-toggle" onClick={() => setOpen((current) => !current)}>
        <span className="text-sm font-medium">{t("schDefTitle")}</span>
        <span className="min-w-0 break-words text-xs text-muted-foreground" data-testid="sch-default-summary">{shown ? fill(t("schDefNow"), { model: shown, source }) : source}</span>
      </button>
      {open ? (
        <SurfaceBody>
          <div id="sch-default-body" className="min-w-0 space-y-2" data-testid="sch-default-body">
            <p className="text-sm font-medium">{t("schDefLabel")}</p>
            <p className="text-xs text-muted-foreground">{t("schDefHelp")} {t(level === "project" ? "schDefScopeProject" : "schDefScopeGlobal")}</p>
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              {catalog ? <NativeModelPicker catalog={catalog} seed={seed} disabled={busy} testId="sch-default-picker" label={t("schDefLabel")} className="min-w-0"
                onChoose={(choice) => void save({ provider: choice.providerId, model: choice.model, ...(choice.effort ? { reasoning_effort: choice.effort } : {}), ...(choice.serviceTier === "fast" ? { service_tier: "fast" as const } : {}) })} /> : null}
              <div className="min-w-0 space-y-1">
                <span className="block text-xs font-medium" id="sch-default-preset-label">{t("schWhoPreset")}</span>
                <Select value={own && "preset" in own ? own.preset : NONE} disabled={busy} onValueChange={(slug) => { if (slug !== NONE) void save({ preset: slug }); }}>
                  <SelectTrigger aria-labelledby="sch-default-preset-label" className="h-8 w-full min-w-40 text-sm" data-testid="sch-default-preset"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{t("schWhoPresetNone")}</SelectItem>
                    {PRESET_SLUGS.map((slug) => <SelectItem key={slug} value={slug}>{slug}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {own ? <Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs" disabled={busy} data-testid="sch-default-drop" onClick={() => void drop()}>{t(level === "project" ? "schDefInherit" : "schDefClear")}</Button> : null}
            </div>
            {message ? <p className={`break-words text-xs ${message.tone === "error" ? "text-destructive-text" : "text-muted-foreground"}`} role={message.tone === "error" ? "alert" : "status"} data-testid="sch-default-message">{message.text}</p> : null}
          </div>
        </SurfaceBody>
      ) : null}
    </Surface>
  );
}
