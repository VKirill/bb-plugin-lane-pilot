import { t, type I18nKey } from "../../i18n";
import { Disclosure } from "./disclosure";
import { Pill } from "./pill";

const STEPS = ["order", "pm", "workflow", "writer", "checks", "accept", "learn"] as const;
const LEVELS = ["Defaults", "Project", "Section"] as const;

/** A collapsed explainer: how a project inherits settings and how an order travels to the merged result. */
export function HowItWorks({ open }: { open?: boolean }) {
  return (
    <Disclosure testId="how-it-works" summary={<span className="text-sm font-medium">{t("howTitle")}</span>} open={open}>
      <div className="space-y-4 py-1">
        <section className="space-y-1.5" data-testid="how-inherit">
          <h3 className="text-sm font-medium">{t("howInheritTitle")}</h3>
          <p className="max-w-xl text-xs text-muted-foreground">{t("howInheritBody")}</p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {LEVELS.map((level, index) => (
              <span key={level} className="flex items-center gap-1.5">
                {index > 0 ? <span aria-hidden className="text-muted-foreground">→</span> : null}
                <Pill>{t(`howLevel${level}` as I18nKey)}</Pill>
              </span>
            ))}
          </div>
        </section>
        <section className="space-y-1.5" data-testid="how-flow">
          <h3 className="text-sm font-medium">{t("howFlowTitle")}</h3>
          <ol className="max-w-xl space-y-1.5">
            {STEPS.map((step, index) => (
              <li key={step} className="flex min-w-0 items-start gap-2 text-xs">
                <span className="lp-tile size-6 shrink-0 text-xs font-semibold" aria-hidden>{index + 1}</span>
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{t(`howStep_${step}` as I18nKey)}</span>
                  <span className="text-muted-foreground"> — {t(`howStepBody_${step}` as I18nKey)}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </Disclosure>
  );
}
