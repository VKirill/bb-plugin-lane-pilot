import { useEffect, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import { Input } from "./input";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "default";
  requireText?: string;
  onConfirm: () => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirmation dialog built on AlertDialog with async pending state,
 * inline rejection error display, and optional exact-text confirmation gating.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone = "default",
  requireText,
  onConfirm,
  onOpenChange,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (!open) {
      setPending(false);
      setError(null);
      setTyped("");
    }
  }, [open]);

  const requiresText = typeof requireText === "string" && requireText.length > 0;
  const confirmDisabled = pending || (requiresText && typed !== requireText);

  const handleOpenChange = (nextOpen: boolean) => {
    if (pending && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setError(null);
    setPending(true);
    try {
      await Promise.resolve(onConfirm());
      setPending(false);
      onOpenChange(false);
    } catch (err) {
      setPending(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {body !== undefined && body !== null ? (
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">{body}</div>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription className="sr-only">{title}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        {requiresText ? (
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={requireText}
            aria-label={requireText}
            disabled={pending}
          />
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            type="button"
            variant={tone === "danger" ? "destructive" : "default"}
            disabled={confirmDisabled}
            aria-busy={pending || undefined}
            data-pending={pending ? "true" : undefined}
            onClick={() => void handleConfirm()}
          >
            {pending ? (
              <span
                aria-hidden="true"
                className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              />
            ) : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
