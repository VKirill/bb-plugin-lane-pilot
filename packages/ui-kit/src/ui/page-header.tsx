import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Console page header strip with title, optional subtitle, and right-aligned actions slot. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "lp-strip flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0 space-y-0.5">
        <h1 className="text-base font-semibold leading-tight text-foreground">
          {title}
        </h1>
        {subtitle !== undefined && subtitle !== null ? (
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
