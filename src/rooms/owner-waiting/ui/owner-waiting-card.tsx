import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, Disclosure, Icon } from "@lane-pilot/ui-kit";
import { DEFERRAL_KINDS } from "../../deferral";
import type { OwnerAction, OwnerEvidence, OwnerItem } from "../models/owner-item";

const KIND_KEYS: Record<string, I18nKey> = {
  attempt: "ow_kind_attempt",
  task: "ow_kind_task",
  run: "ow_kind_run",
  file: "ow_kind_file",
  note: "ow_kind_note",
  message: "ow_kind_message",
  command: "ow_kind_command",
  text: "ow_kind_text",
};
const DEFERRAL_KIND_SET = new Set<string>(DEFERRAL_KINDS);

export const kindLabel = (kind: string) => (KIND_KEYS[kind] ? t(KIND_KEYS[kind]!) : kind);
/** An attempt id is long and the same prefix every time: its first eight characters tell it apart, the whole id stays in the tooltip. */
export const shortRef = (kind: string, ref: string) => (kind === "attempt" ? ref.replace(/^[a-z]+_/, "").slice(0, 8) : ref);
export const foldLabel = (label: string) => <span className="text-[11px] text-muted-foreground">{label}</span>;
export const ownerChipClass = "inline-flex max-w-full items-center gap-1 break-all rounded-md border border-border px-1.5 text-[11px] leading-5 text-muted-foreground";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export type DeferTarget = { what: string; kind?: string };

/** Resolves whether an owner item can be deferred via `deferral_defer`, returning its deferral target id/summary. */
export function resolveDeferTarget(item: OwnerItem): DeferTarget | null {
  if (item.key.startsWith("deferral:")) {
    const target = item.key.slice("deferral:".length).trim();
    if (target) {
      const stripped = item.kind.replace(/^deferral_/, "");
      return target.startsWith("dfr_") ? { what: target } : { what: target, ...(DEFERRAL_KIND_SET.has(stripped) ? { kind: stripped } : {}) };
    }
  }
  for (const evidence of item.evidence) {
    const candidate = evidence.label?.trim() || evidence.ref.trim();
    if (/^dfr_[A-Za-z0-9_]+$/.test(candidate)) return { what: candidate };
  }
  for (const action of item.actions) {
    const match = /\bdefer\s+(dfr_[A-Za-z0-9_]+)/.exec(action.cli);
    if (match?.[1]) return { what: match[1] };
  }
  const normalizedKind = item.kind.replace(/^deferral_/, "");
  if (DEFERRAL_KIND_SET.has(normalizedKind)) {
    return { what: item.what.slice(0, 500), kind: normalizedKind };
  }
  return null;
}

export function isTaskWordNo(action: OwnerAction): boolean {
  return action.rpc?.method === "task_word" && action.rpc.input?.decision === "no";
}

export function isClosingAction(action: OwnerAction): boolean {
  const method = action.rpc?.method;
  return method === "finish_run" || method === "schedule_pause" || isTaskWordNo(action);
}

export function confirmTitleFor(action: OwnerAction): string {
  if (isTaskWordNo(action)) return t("consoleDecisionsConfirmReject");
  if (action.rpc?.method === "finish_run") return t("consoleDecisionsConfirmFinish");
  return t("consoleDecisionsConfirmPause");
}

function resolveTaskPair(item: OwnerItem, evidence: OwnerEvidence): { runId: string; taskId: string | null } | null {
  let runId: string | null = evidence.kind === "run" ? evidence.ref : null;
  let taskId: string | null = evidence.kind === "task" ? evidence.ref : null;
  if (taskId && taskId.includes(":")) {
    const [r, tId] = taskId.split(":", 2);
    if (r && tId) { runId = r; taskId = tId; }
  }
  for (const ev of item.evidence) {
    if (!runId && ev.kind === "run") runId = ev.ref;
    if (!taskId && ev.kind === "task") {
      if (ev.ref.includes(":")) {
        const [r, tId] = ev.ref.split(":", 2);
        if (r && tId) { runId = runId ?? r; taskId = tId; }
      } else {
        taskId = ev.ref;
      }
    }
  }
  for (const action of item.actions) {
    const input = action.rpc?.input;
    if (!input) continue;
    if (!runId && typeof input.runId === "string" && input.runId) runId = input.runId;
    if (!taskId && typeof input.taskId === "string" && input.taskId) taskId = input.taskId;
  }
  if (item.key.startsWith("task-word:")) {
    const parts = item.key.split(":");
    if (!runId && parts[1]) runId = parts[1];
    if (!taskId && parts[2]) taskId = parts[2];
  }
  return runId ? { runId, taskId } : null;
}

function resolveFileTarget(evidence: OwnerEvidence): { kind: "host"; hostId: string; path: string } {
  const hostMatch = /^([^:\s]+):(\/.*)$/.exec(evidence.ref);
  if (hostMatch) return { kind: "host", hostId: hostMatch[1]!, path: hostMatch[2]! };
  const labelHost = evidence.label?.startsWith("host:") ? evidence.label.slice("host:".length).trim() : "";
  return { kind: "host", hostId: labelHost || "local", path: evidence.ref };
}

function CopyGlyph({ copied }: { copied: boolean }) {
  if (copied) return <Icon name="Check" className="size-3" aria-hidden />;
  return (
    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="5" y="5" width="8" height="9" rx="1.5" />
      <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" strokeLinecap="round" />
    </svg>
  );
}

function EvidenceChip({
  item,
  evidence,
  index,
  onOpenTask,
  onOpenWork,
}: {
  item: OwnerItem;
  evidence: OwnerEvidence;
  index: number;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
}) {
  const navigate = useBbNavigate();
  const [copied, setCopied] = useState(false);

  const copyRef = () => {
    void navigator.clipboard?.writeText(evidence.ref).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  const openEvidence = () => {
    if (evidence.kind === "file") {
      navigate?.experimental_openFilePreview?.({ target: resolveFileTarget(evidence), location: null });
      return;
    }
    if (evidence.kind === "task" || evidence.kind === "run" || evidence.kind === "attempt") {
      const pair = resolveTaskPair(item, evidence);
      if (pair?.taskId) {
        if (onOpenTask) onOpenTask(pair.runId, pair.taskId);
        else navigate?.toPluginPanel?.("lane-pilot", { subPath: `work/task/${pair.runId}/${pair.taskId}` });
        return;
      }
      if (pair?.runId) {
        if (onOpenWork) onOpenWork();
        else navigate?.toPluginPanel?.("lane-pilot", { subPath: "work/tasks" });
        return;
      }
    }
    if ((evidence.kind === "message" || /^thr_/.test(evidence.ref)) && evidence.ref) {
      const threadId = evidence.ref.split(/[#:]/)[0];
      if (threadId) {
        navigate?.toThread?.(threadId);
        return;
      }
    }
    copyRef();
  };

  const labelText = `${kindLabel(evidence.kind)}: ${shortRef(evidence.kind, evidence.ref)}${evidence.label ? ` (${evidence.label})` : ""}`;
  return (
    <span className={ownerChipClass} data-testid={`owner-evidence-chip-${item.key}-${index}`}>
      <button
        type="button"
        className="text-left hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        title={`${evidence.ref}${evidence.label ? ` (${evidence.label})` : ""}`}
        data-testid={`owner-evidence-open-${item.key}-${index}`}
        onClick={openEvidence}
      >
        {labelText}
      </button>
      <button
        type="button"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={copied ? t("ow_copied") : t("ow_copy")}
        title={copied ? t("ow_copied") : t("ow_copy")}
        data-testid={`owner-evidence-copy-${item.key}-${index}`}
        onClick={copyRef}
      >
        <CopyGlyph copied={copied} />
      </button>
    </span>
  );
}

function CommandLine({ action, itemKey }: { action: OwnerAction; itemKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(action.cli).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  return (
    <div className="min-w-0 space-y-1" data-testid={`owner-command-${itemKey}-${action.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{action.label}</span>
        {action.needsOwnerMessage ? <span className={ownerChipClass}>{t("ow_needs_message")}</span> : null}
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-secondary/60 px-2 py-1 text-[11px] leading-5">{action.cli}</code>
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={copy}>{copied ? t("ow_copied") : t("ow_copy")}</Button>
      </div>
      {action.hint ? <Disclosure summary={foldLabel(t("ow_how"))} compact><p className="pt-1 text-[11px] leading-4 text-muted-foreground">{action.hint}</p></Disclosure> : null}
    </div>
  );
}

/** Single decision card on the Waiting board with actions, defer button, inline error, and folded details. */
export function OwnerItemCard({
  item,
  projectName,
  busy,
  error,
  onRun,
  onDefer,
  onOpenTask,
  onOpenWork,
}: {
  item: OwnerItem;
  projectName: string | null;
  busy: boolean;
  error?: string;
  onRun: (action: OwnerAction) => void;
  onDefer?: () => void;
  onOpenTask?: (runId: string, taskId: string) => void;
  onOpenWork?: () => void;
}) {
  const buttons = item.actions.filter((action) => action.rpc);
  const commands = item.actions.filter((action) => !action.rpc);
  const hasActionButtons = buttons.length > 0 || Boolean(onDefer);
  return (
    <li className="lp-card min-w-0 space-y-3 p-5" data-testid={`owner-item-${item.key}`}>
      {projectName ? <p className="text-[13px] text-[var(--lp-muted)]">{projectName}</p> : null}
      <p className="min-w-0 break-words text-base font-semibold leading-snug text-[var(--lp-ink)]">{item.what}</p>
      <p className="text-[13.5px] leading-relaxed text-[var(--lp-body)]"><span className="font-medium text-[var(--lp-ink)]">{t("ow_why")}:</span> {item.why}</p>
      {hasActionButtons ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {buttons.map((action, index) => (
            <Button key={action.id} type="button" size="sm" variant={index === 0 || action.id === "accept" || action.id === "yes" ? "default" : "outline"} disabled={busy} data-testid={`owner-run-${item.key}-${action.id}`} onClick={() => onRun(action)}>{action.label}</Button>
          ))}
          {onDefer ? (
            <Button type="button" size="sm" variant="ghost" className="ml-auto text-[var(--lp-muted)]" disabled={busy} data-testid={`owner-defer-${item.key}`} onClick={onDefer}>
              {t("consoleDecisionsDefer")}
            </Button>
          ) : null}
        </div>
      ) : commands.length ? (
        <p className="text-xs leading-5"><span className="font-medium">{t("ow_do")}:</span> {commands.map((action) => action.label).join(" · ")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive" data-testid={`owner-error-${item.key}`}>
          {error}
        </p>
      ) : null}
      <Disclosure summary={foldLabel(t("ow_details"))} compact>
        <div className="space-y-2 pt-1" data-testid={`owner-details-${item.key}`}>
          <p className="text-[11px] text-muted-foreground">{t("ow_since")}: {when(item.since)} · {t("ow_key")}: <code className="break-all">{item.key}</code></p>
          {item.evidence.length ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid={`owner-evidence-${item.key}`}>
              <span className="text-xs text-muted-foreground">{t("ow_evidence")}:</span>
              {item.evidence.map((evidence, index) => (
                <EvidenceChip
                  key={`${evidence.kind}${index}`}
                  item={item}
                  evidence={evidence}
                  index={index}
                  onOpenTask={onOpenTask}
                  onOpenWork={onOpenWork}
                />
              ))}
            </div>
          ) : null}
          {item.actions.length ? (
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("ow_dev")}</p>
              {item.actions.map((action) => <CommandLine key={action.id} action={action} itemKey={item.key} />)}
            </div>
          ) : null}
        </div>
      </Disclosure>
    </li>
  );
}
