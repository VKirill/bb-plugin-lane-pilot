import { useEffect, useState } from "react";
import {
  experimental_Icon as BbIcon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  useBbNavigate,
  type ExperimentalProviderModelPickerValue as PickerValue,
} from "@get-bb/plugin-sdk/app";
import { Badge, Button, cn } from "@lane-pilot/ui-kit";
import type { PilotChildThread, PilotDelegationChoice, PilotDelegationView } from "../index";
import { PanelCallout, PanelSection, StatusDot, type PanelTone } from "./layout";

const CHILD_STATUS: Record<string, { label: string; tone: PanelTone }> = {
  pending: { label: "в очереди", tone: "idle" },
  starting: { label: "запускается", tone: "live" },
  active: { label: "работает", tone: "live" },
  running: { label: "работает", tone: "live" },
  verifying: { label: "проверяет", tone: "live" },
  critiquing: { label: "ревью", tone: "live" },
  stopping: { label: "останавливается", tone: "live" },
  idle: { label: "готово", tone: "done" },
  accepted: { label: "принято", tone: "done" },
  error: { label: "ошибка", tone: "error" },
  failed: { label: "ошибка", tone: "error" },
  blocked: { label: "блокер", tone: "error" },
};

const PICKER_SEED: PickerValue = {
  providerId: "claude-code",
  model: "",
  reasoningLevel: "" as PickerValue["reasoningLevel"],
};

const toPickerValue = (c: Extract<PilotDelegationChoice, { mode: "bb-subthreads" }>): PickerValue => ({
  providerId: c.providerId,
  model: c.model,
  reasoningLevel: (c.reasoning ?? "") as PickerValue["reasoningLevel"],
});

const fromPickerValue = (v: PickerValue): PilotDelegationChoice => ({
  mode: "bb-subthreads",
  providerId: v.providerId,
  model: v.model,
  ...(v.reasoningLevel ? { reasoning: v.reasoningLevel } : {}),
});

export function PilotDelegationSection({
  view,
  environmentId,
  hasWorkspace,
  onSave,
}: {
  view: PilotDelegationView;
  environmentId: string | null;
  busy?: boolean;
  hasWorkspace: boolean;
  onSave: (choice: PilotDelegationChoice) => Promise<void>;
}) {
  const navigate = useBbNavigate();
  const [mode, setMode] = useState<PilotDelegationChoice["mode"]>(view.choice.mode);
  const [pick, setPick] = useState<PickerValue | null>(
    view.choice.mode === "bb-subthreads" ? toPickerValue(view.choice) : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const choiceKey = JSON.stringify(view.choice);

  useEffect(() => {
    setMode(view.choice.mode);
    if (view.choice.mode === "bb-subthreads") setPick(toPickerValue(view.choice));
  }, [choiceKey]);

  const proposed: PilotDelegationChoice | null =
    mode === "pilot-lanes"
      ? { mode: "pilot-lanes" }
      : mode === "self"
        ? { mode: "self" }
        : pick?.model
          ? fromPickerValue(pick)
          : null;

  const dirty = Boolean(proposed && JSON.stringify(proposed) !== JSON.stringify(view.choice));
  const providerLabel = (id: string | null) => view.providers.find((p) => p.id === id)?.name ?? id;

  const activeBadge =
    view.choice.mode === "pilot-lanes"
      ? "Дорожки Pilot"
      : view.choice.mode === "self"
        ? "Этот чат"
        : [providerLabel(view.choice.providerId), view.choice.model, view.choice.reasoning].filter(Boolean).join(" · ");

  async function handleSave() {
    if (!proposed) return;
    setSaving(true);
    setError("");
    try {
      await onSave(proposed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setMode(view.choice.mode);
    setPick(view.choice.mode === "bb-subthreads" ? toPickerValue(view.choice) : null);
    setError("");
  }

  const modeOptions: Array<{ id: PilotDelegationChoice["mode"]; label: string }> = [
    { id: "pilot-lanes", label: "Дорожки Pilot" },
    { id: "bb-subthreads", label: "Чистые субтреды" },
    { id: "self", label: "Этот агент" },
  ];

  return (
    <PanelSection
      label="Делегирование и субтреды"
      title="Исполнение и чистые субтреды"
      aside={<Badge variant="secondary" className="max-w-[55%] truncate font-medium">{activeBadge}</Badge>}
    >
      {view.error && <PanelCallout tone="error">{view.error}</PanelCallout>}
      <div
        role="radiogroup"
        aria-label="Режим делегирования задач"
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {modeOptions.map((opt) => (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={mode === opt.id}
            disabled={saving || !hasWorkspace}
            onClick={() => {
              setError("");
              setMode(opt.id);
              if (opt.id === "bb-subthreads" && !pick) setPick(PICKER_SEED);
            }}
            className={cn(
              "min-h-8 cursor-pointer truncate rounded-md px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
              mode === opt.id
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {mode === "bb-subthreads" && pick && typeof ProviderModelPicker === "function" && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Провайдер и модель субтредов (Standard tier)</span>
          <ProviderModelPicker
            value={pick}
            onChange={setPick}
            disabled={saving || !hasWorkspace}
            routing={environmentId ? { kind: "environment", environmentId } : undefined}
          />
        </div>
      )}

      {dirty && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={saving || !hasWorkspace} onClick={() => void handleSave()}>
            {saving ? "Сохраняю…" : "Сохранить в проект"}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={reset}>
            Отменить
          </Button>
        </div>
      )}

      {error && <PanelCallout tone="error" role="alert">{error}</PanelCallout>}

      <p className="m-0 text-xs text-muted-foreground">
        Все субтреды запускаются чистыми сессиями на тарифе <b>standard</b> без лишних глобальных скиллов и плагинов; правила и скиллы берутся из `.bb/skills/` и `.agents/pilot/`.
      </p>

      {view.children.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="pilot-panel-children">
          <h4 className="m-0 text-xs font-medium text-muted-foreground">
            Дочерние субтреды и дорожки · {view.children.length}
          </h4>
          <ul className="m-0 flex list-none flex-col divide-y divide-border rounded-md border border-border p-0">
            {view.children.map((child: PilotChildThread) => {
              const st = CHILD_STATUS[child.status] ?? { label: child.status, tone: "idle" as const };
              const subtitle = [
                child.role,
                providerLabel(child.providerId),
                st.label,
                child.cleanSession ? "чистая сессия" : null,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li
                  key={child.id}
                  className="grid min-h-10 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2"
                >
                  <StatusDot tone={st.tone} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{child.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => navigate.toThread(child.id, { split: true })}
                  >
                    Открыть
                    <BbIcon name="ExternalLink" className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </PanelSection>
  );
}
