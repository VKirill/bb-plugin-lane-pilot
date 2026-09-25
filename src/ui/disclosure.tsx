import type { ReactNode } from "react";
import { Icon } from "../../components/ui/icon";
import { cn } from "../../lib/utils";

export function Disclosure({
  summary,
  children,
  open,
  testId,
  compact,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  testId?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <details
      data-testid={testId}
      className={cn("min-w-0 max-w-full [&[open]>summary_[data-disclosure-chevron]]:rotate-90", className)}
      {...(open === undefined ? {} : { open })}
    >
      <summary
        className={cn(
          "flex w-full cursor-pointer list-none items-center gap-2 rounded-md bg-muted text-foreground",
          "hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "[&::-webkit-details-marker]:hidden",
          compact ? "min-h-7 px-2 py-1 text-xs text-muted-foreground" : "min-h-8 px-2.5 py-1.5 text-sm",
        )}
      >
        <span data-disclosure-chevron className="inline-flex shrink-0 transition-transform">
          <Icon name="ChevronRight" className={cn("text-muted-foreground", compact ? "size-3" : "size-3.5")} />
        </span>
        <span className="min-w-0 flex-1 text-left">{summary}</span>
      </summary>
      <div className={cn("border-l border-border", compact ? "ml-2 mt-1.5 space-y-1 pl-2.5" : "ml-2 mt-2 space-y-2 pl-3")}>
        {children}
      </div>
    </details>
  );
}
