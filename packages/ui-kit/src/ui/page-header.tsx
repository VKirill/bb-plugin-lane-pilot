import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Console page header (title 26 px, subtitle, no card) with title, optional subtitle, and right-aligned actions slot. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        "lp-page-head flex flex-wrap justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="lp-page-title">
          {title}
        </h1>
        {subtitle !== undefined && subtitle !== null ? (
          <p className="lp-page-sub">{subtitle}</p>
        ) : null}
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
