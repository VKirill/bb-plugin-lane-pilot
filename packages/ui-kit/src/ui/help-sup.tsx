import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * The «?» after a title: a small circle raised to the top of the text line,
 * like the 2 in x², that opens the help. The touch target reaches past the circle.
 */
export function HelpSup({ label, children, testId, contentTestId }: { label: string; children: ReactNode; testId?: string; contentTestId?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          className="relative -top-1.5 ml-0.5 inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--lp-outline)] bg-[var(--lp-card)] align-top text-[9px] font-semibold leading-none text-muted-foreground transition-colors before:absolute before:-inset-2.5 before:content-[''] hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >?</button>
      </PopoverTrigger>
      <PopoverContent align="start" data-testid={contentTestId} aria-label={label} className="max-w-xs space-y-1 text-xs leading-relaxed text-foreground">
        {children}
      </PopoverContent>
    </Popover>
  );
}
