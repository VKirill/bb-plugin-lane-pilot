import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Badge, type BadgeProps } from "./badge";

export type StatusPillTone = "ok" | "warn" | "bad" | "accent" | "muted";

export interface StatusPillProps {
  tone: StatusPillTone;
  children: ReactNode;
  /** A 6 px dot in the tone colour before the text ("На смене"). */
  dot?: boolean;
  className?: string;
}

const TONE_TO_BADGE_VARIANT: Record<StatusPillTone, NonNullable<BadgeProps["variant"]>> = {
  ok: "success",
  warn: "warning",
  bad: "destructive",
  accent: "secondary",
  muted: "default",
};

/** Status pill mapping console semantic tones to existing Badge variants. */
export function StatusPill({ tone, children, dot, className }: StatusPillProps) {
  return (
    <Badge
      variant={TONE_TO_BADGE_VARIANT[tone]}
      data-tone={tone}
      className={cn(dot && "lp-pill-dot", className)}
    >
      {children}
    </Badge>
  );
}
