import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export type PillTone = "success" | "info" | "warning" | "danger" | "neutral" | "muted";

/** A soft tinted status pill (DESIGN.md): the word carries the meaning, the tint only supports it. */
export function Pill({ tone = "neutral", children, className, testId, title }: { tone?: PillTone; children: ReactNode; className?: string; testId?: string; title?: string }) {
  return (
    <span data-testid={testId} title={title} data-tone={tone}
      className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", `lp-pill-${tone}`, className)}>
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
