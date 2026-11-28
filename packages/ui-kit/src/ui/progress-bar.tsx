import { cn } from "../lib/utils";

export type ProgressTone = "ok" | "warn" | "bad" | "accent" | "muted";

export interface ProgressBarProps {
  /** 0 to 100; out-of-range values are clamped. */
  value: number;
  tone?: ProgressTone;
  label?: string;
  className?: string;
  testId?: string;
}

/** Thin progress bar (6 px): a hairline track and a fill in the tone of the status. */
export function ProgressBar({ value, tone = "muted", label, className, testId }: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
      data-testid={testId}
      data-tone={tone}
      className={cn("lp-progress w-full", className)}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}
