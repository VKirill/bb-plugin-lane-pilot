import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

export function Surface({
  className,
  testId,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & { testId?: string; children: ReactNode }) {
  return (
    <section
      data-testid={testId}
      className={cn("lp-panel text-card-foreground", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function SurfaceHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("lp-panel-head", className)}>{children}</div>;
}

export function SurfaceBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("lp-panel-body space-y-3", className)}>{children}</div>;
}
