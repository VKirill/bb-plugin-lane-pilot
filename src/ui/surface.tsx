import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Surface({
  className,
  testId,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { testId?: string; children: ReactNode }) {
  return (
    <section
      data-testid={testId}
      className={cn("min-w-0 max-w-full rounded-lg border border-border bg-card text-card-foreground", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function SurfaceHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex min-w-0 items-center gap-2 px-3 pt-3", className)}>{children}</div>;
}

export function SurfaceBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-w-0 max-w-full space-y-3 px-3 pb-3 pt-2", className)}>{children}</div>;
}
