import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils";

export type KpiTileTone = "ok" | "warn" | "bad" | "accent" | "muted";

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: KpiTileTone;
  onClick?: () => void;
  className?: string;
  testId?: string;
}

/** The tone colours the caption under the number, as in the prototype; the number itself stays ink. */
const TONE_CLASS: Record<KpiTileTone, string> = {
  ok: "lp-text-success",
  warn: "lp-text-warning",
  bad: "text-destructive",
  accent: "text-primary",
  muted: "text-muted-foreground",
};

/** Summary metric tile; renders a button when clickable, otherwise a static card. */
export function KpiTile({
  label,
  value,
  note,
  tone = "muted",
  onClick,
  className,
  testId,
}: KpiTileProps) {
  const noteId = useId();
  const hasNote = note !== undefined && note !== null;
  const accessibleName =
    typeof value === "string" || typeof value === "number"
      ? `${label} ${value}`
      : label;

  const content = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-2xl font-[650] tabular-nums leading-tight text-[var(--lp-ink)]">
        {value}
      </span>
      {hasNote ? (
        <span id={noteId} className={cn("text-[11.5px] font-medium", TONE_CLASS[tone])}>
          {note}
        </span>
      ) : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={accessibleName}
        aria-describedby={hasNote ? noteId : undefined}
        data-testid={testId}
        data-tone={tone}
        className={cn(
          "lp-card flex min-w-0 cursor-pointer flex-col gap-1 px-4 py-3.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      data-testid={testId}
      data-tone={tone}
      className={cn("lp-card flex min-w-0 flex-col gap-1 px-4 py-3.5 text-left", className)}
    >
      {content}
    </div>
  );
}
