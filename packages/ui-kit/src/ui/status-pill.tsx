import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "./badge";

export type StatusPillTone = "ok" | "warn" | "bad" | "accent" | "muted";

export interface StatusPillProps {
  tone: StatusPillTone;
  children: ReactNode;
  className?: string;
}

const TONE_TO_BADGE_VARIANT: Record<StatusPillTone, NonNullable<BadgeProps["variant"]>> = {
  ok: "success",
  warn: "outline",
  bad: "destructive",
  accent: "secondary",
  muted: "default",
};

/** Status pill mapping console semantic tones to existing Badge variants. */
export function StatusPill({ tone, children, className }: StatusPillProps) {
  return (
    <Badge
      variant={TONE_TO_BADGE_VARIANT[tone]}
      data-tone={tone}
      className={className}
    >
      {children}
    </Badge>
  );
}
