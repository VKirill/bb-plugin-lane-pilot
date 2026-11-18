import { useState } from "react";
import { experimental_Icon as BbIcon } from "@get-bb/plugin-sdk/app";
import { Button, cn } from "@lane-pilot/ui-kit";
import {
  nextPilotReadinessStep,
  pilotReadinessComplete,
  pilotReadinessHelp,
  type PilotPanelAction,
  type PilotPanelSnapshot,
  type PilotReadinessStep,
} from "../index";
import { HelpMark, PanelDisclosure, PanelSection } from "./layout";

export function PilotReadinessSection({
  snapshot,
  busy,
  sending,
  onRunAction,
  onToggleSkip,
}: {
  snapshot: PilotPanelSnapshot;
  busy: boolean;
  sending: boolean;
  onRunAction: (action: PilotPanelAction) => void;
  onToggleSkip: (stepId: "quality" | "ci", skipped: boolean) => Promise<void>;
}) {
  const [helpId, setHelpId] = useState<string | null>(null);
  const [pendingSkip, setPendingSkip] = useState<string | null>(null);

  const steps = snapshot.readiness;
  if (!steps.length) return null;

  const next = nextPilotReadinessStep(steps);
  const findAction = (step: PilotReadinessStep) =>
    snapshot.actions.find((a) => a.id === step.actionId);

  const iconName = (step: PilotReadinessStep) =>
    step.state === "done" ? "CircleCheck" : step.state === "skipped" ? "CircleDashed" : "Circle";

  const stateLabel = (step: PilotReadinessStep) =>
    step.state === "done" ? "Выполнен" : step.state === "skipped" ? "Пропущен" : "Ожидает выполнения";

  async function toggleSkip(step: PilotReadinessStep, skipped: boolean) {
    if (pendingSkip) return;
    setPendingSkip(step.id);
    try {
      await onToggleSkip(step.id as "quality" | "ci", skipped);
    } finally {
      setPendingSkip(null);
    }
  }

  function renderStep(step: PilotReadinessStep, index: number, isNext: boolean) {
    const action = isNext || step.id === "install" ? findAction(step) : undefined;
    const isDirectServerAction = action?.id === "prepare-project";
    const skipButton =
      step.state === "skipped" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendingSkip !== null}
          onClick={() => void toggleSkip(step, false)}
        >
          Вернуть
        </Button>
      ) : step.skippable && step.state === "todo" ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pendingSkip !== null}
          onClick={() => void toggleSkip(step, true)}
        >
          Пропустить
        </Button>
      ) : null;

    return (
      <li key={step.id} className="flex min-w-0 items-start gap-2" data-testid={`pilot-readiness-${step.id}`}>
        <BbIcon
          name={iconName(step)}
          aria-label={stateLabel(step)}
          className={cn(
            "mt-0.5 size-4 shrink-0",
            step.state === "done" ? "text-primary" : "text-muted-foreground",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-xs tabular-nums text-muted-foreground">{index}.</span>
            <span className={cn("min-w-0 text-sm font-medium", step.state === "done" && "text-muted-foreground")}>
              {step.label}
              <HelpMark
                label={`Что делает шаг «${step.label}»`}
                open={helpId === step.id}
                onToggle={() => setHelpId(helpId === step.id ? null : step.id)}
              />
            </span>
            {skipButton && <span className="ml-auto shrink-0">{skipButton}</span>}
          </div>
          {helpId === step.id && (
            <p className="m-0 rounded-md bg-muted px-3 py-2 text-xs text-foreground">
              {pilotReadinessHelp[step.id]}
            </p>
          )}
          {step.state === "todo" && step.missing.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {step.anyOf ? "любой из" : "нет"}: {step.missing.join(", ")}
            </span>
          )}
          {step.state === "todo" && action && (
            <div className="pt-0.5">
              <span className="inline-flex" title={action.reason}>
                <Button
                  type="button"
                  size="sm"
                  disabled={sending || (!isDirectServerAction && busy) || !action.available}
                  onClick={() => onRunAction(action)}
                >
                  {action.label}
                </Button>
              </span>
            </div>
          )}
        </div>
      </li>
    );
  }

  const list = (
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
      {steps.map((step, idx) => renderStep(step, idx + 1, next?.id === step.id))}
    </ol>
  );

  if (pilotReadinessComplete(steps)) {
    return (
      <PanelDisclosure summary="Проект готов к работе с Lane Pilot">
        {list}
      </PanelDisclosure>
    );
  }

  return (
    <PanelSection label="Подготовка проекта" title="Подготовка проекта">
      <p className="m-0 text-xs text-muted-foreground">
        Скиллы и правила хранятся прямо внутри проекта (`.bb/skills/` и `.agents/pilot/`), чтобы будущие сессии и чистые субтреды работали автономно.
      </p>
      {list}
    </PanelSection>
  );
}
