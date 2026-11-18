import type { ReactNode } from "react";
import { experimental_Icon as BbIcon } from "@get-bb/plugin-sdk/app";
import { cn } from "@lane-pilot/ui-kit";

export type PanelTone = "live" | "done" | "error" | "idle";

export function PanelSection({
  title,
  aside,
  label,
  className,
  children,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4", className)}
    >
      {(title || aside) && (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          {title && <h3 className="m-0 text-xs font-medium text-muted-foreground">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function PanelDisclosure({
  summary,
  className,
  defaultOpen,
  children,
}: {
  summary: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={cn("group min-w-0", className)} open={defaultOpen}>
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-foreground outline-none hover:text-foreground/80 focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <BbIcon
          name="ChevronRight"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90"
        />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pt-2 pl-[22px]">{children}</div>
    </details>
  );
}

export function StatusDot({ tone }: { tone: PanelTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex size-2 shrink-0 rounded-full",
        tone === "live" && "bg-primary",
        tone === "done" && "bg-foreground",
        tone === "error" && "bg-destructive",
        tone === "idle" && "bg-muted-foreground/60",
      )}
    >
      {tone === "live" && (
        <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
      )}
    </span>
  );
}

export function PanelCallout({
  tone = "info",
  role,
  children,
}: {
  tone?: "info" | "error";
  role?: "status" | "alert";
  children: ReactNode;
}) {
  return (
    <p
      role={role}
      className={cn(
        "m-0 rounded-md border px-3 py-2 text-xs",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-border bg-muted/40 text-foreground",
      )}
    >
      {children}
    </p>
  );
}

const InfoCircleSvg = () => (
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6.75" />
    <path d="M6.2 6.1a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.6-1.9 2.8" />
    <circle cx="8" cy="11.6" r="0.4" fill="currentColor" />
  </svg>
);

export function HelpMark({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="ml-1 inline-flex -translate-y-0.5 cursor-pointer rounded-full border-0 bg-transparent p-0.5 align-middle text-muted-foreground hover:text-foreground"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
    >
      <InfoCircleSvg />
    </button>
  );
}
