import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { type ExperimentalProviderModelPickerValue, type useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../contracts";
import { type CatalogRow } from "@lane-pilot/settings-catalog";
import { t } from "@lane-pilot/i18n";
import { type ScreenPayload } from "../../ui-shell/ui";
import { type StackDetectResult, WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER, WRITER_SERVICE_TIER } from "./page-model";
import { selectionKeys, SELECTION_SPECS, type SelectionId } from "./picker-selections";
import { type WriterFallbackSlot, writerFallbackKeys } from "@lane-pilot/models";

export type SaveError =
  | { kind: "cas" }
  | { kind: "validation"; code: "invalid_choice" | "incompatible_setting" | "setup_required" | "writer_binding_ambiguous" | "writer_host_offline" | "catalog_unavailable"; params: string[] }
  | null;

type SaversArgs = {
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  projectId: string | null;
  selectedSectionId: string | null;
  scoped: { sectionId?: string };
  routeThreadId: string | null | undefined;
  selectedBinding: { hostId: string; path: string } | null;
  snapshotPath: string;
  dataRef: MutableRefObject<ScreenPayload | null>;
  setData: Dispatch<SetStateAction<ScreenPayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  drafts: Record<string, unknown>;
  setDrafts: Dispatch<SetStateAction<Record<string, unknown>>>;
  draftsRef: MutableRefObject<Record<string, unknown>>;
  writerDraftRef: MutableRefObject<ExperimentalProviderModelPickerValue | null>;
  setWriterDraft: Dispatch<SetStateAction<ExperimentalProviderModelPickerValue | null>>;
  pickerDraftsRef: MutableRefObject<Record<string, ExperimentalProviderModelPickerValue>>;
  setPickerDrafts: Dispatch<SetStateAction<Record<string, ExperimentalProviderModelPickerValue>>>;
  reload: () => Promise<void>;
};

export function useLpPageSavers(args: SaversArgs) {
  const {
    rpc, projectId, selectedSectionId, scoped, routeThreadId, selectedBinding, snapshotPath,
    dataRef, setData, setError, drafts, setDrafts, draftsRef,
    writerDraftRef, setWriterDraft, pickerDraftsRef, setPickerDrafts, reload,
  } = args;

  const [saveError, setSaveError] = useState<SaveError>(null);
  const [detectResult, setDetectResult] = useState<StackDetectResult | null>(null);
  const [writerRejected, setWriterRejected] = useState(false);
  const saveTailRef = useRef<Record<string, Promise<unknown>>>({});
  const writerSaveTail = useRef(Promise.resolve());
  const pickerQueues = useRef<Record<string, { ticket: number; tail: Promise<unknown> }>>({});

  const writeDraft = (key: string, value: unknown) => {
    draftsRef.current = { ...draftsRef.current, [key]: value };
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  const save = async (row: CatalogRow, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const expectedVersion = snapshot.versions[row.storageKey] ?? 0;
    const result = await rpc.call("save_setting", { ...scoped,
      projectId,
      key: row.storageKey,
      value,
      expectedVersion,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [row.storageKey]: result.value },
          versions: { ...current.versions, [row.storageKey]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [row.storageKey]: result.value },
        versions: { ...current.versions, [row.storageKey]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, row.storageKey])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const saveKey = async (key: string, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_setting", { ...scoped,
      projectId, key, value, expectedVersion: snapshot.versions[key] ?? 0,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [key]: result.value },
          versions: { ...current.versions, [key]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [key]: result.value },
        versions: { ...current.versions, [key]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, key])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const applySetting = async (row: CatalogRow, value: unknown) => {
    writeDraft(row.storageKey, value);
    const key = row.storageKey;
    const queued = (saveTailRef.current[key] ?? Promise.resolve()).then(async () => {
      const latest = draftsRef.current[key];
      if (latest === undefined) return true;
      const ok = await save(row, latest);
      if (ok && Object.is(draftsRef.current[key], latest)) {
        const next = { ...draftsRef.current };
        delete next[key];
        draftsRef.current = next;
        setDrafts((current) => {
          if (!Object.is(current[key], latest)) return current;
          const copy = { ...current };
          delete copy[key];
          return copy;
        });
      }
      return ok;
    });
    saveTailRef.current[key] = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const resetInherited = async (keys: string[]) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot || snapshot.projectId !== projectId) return;
    try {
      const result = await rpc.call("reset_project_settings", { ...scoped, projectId, keys, expectedVersions: Object.fromEntries(keys.map((key) => [key, snapshot.versions[key] ?? 0])) });
      if (dataRef.current?.projectId !== projectId) return;
      if (!result.ok) { setSaveError(result.validation ? { kind: "validation", code: result.validation.code, params: result.validation.params } : { kind: "cas" }); return; }
      const next = await rpc.call("get_screen", { ...scoped, projectId }) as ScreenPayload;
      if (dataRef.current?.projectId !== projectId) return;
      setData(next); dataRef.current = next;
      const remaining = { ...draftsRef.current }; for (const key of keys) delete remaining[key];
      setDrafts(remaining); draftsRef.current = remaining;
      if (keys.includes(WRITER_PROVIDER)) { setWriterDraft(null); writerDraftRef.current = null; }
      setSaveError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const displayedValue = (key: string) => (
    Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : dataRef.current?.values[key]
  );

  const persistWriterSelection = async (selection: ExperimentalProviderModelPickerValue) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_writer_selection", { ...scoped,
      projectId,
      threadId: routeThreadId ?? null,
      ...(selectedBinding ? { selectedBinding } : {}),
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel as "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra",
      serviceTier: (selection.serviceTier ?? null) as "default" | "fast" | null,
      expectedVersions: {
        "writer.provider": snapshot.versions[WRITER_PROVIDER] ?? 0,
        "writer.model": snapshot.versions[WRITER_MODEL] ?? 0,
        "writer.reasoning_effort": snapshot.versions[WRITER_EFFORT] ?? 0,
        "writer.service_tier": snapshot.versions[WRITER_SERVICE_TIER] ?? 0,
      },
    });
    const applyScreen = (values: Record<string, unknown>, versions: Record<string, number>, markExplicit = false) => {
      const current = dataRef.current;
      if (!current) return;
      const next = {
        ...current,
        values: { ...current.values, ...values },
        versions: { ...current.versions, ...versions },
        explicitKeys: markExplicit
          ? [...new Set([...current.explicitKeys, WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER])]
          : current.explicitKeys,
      };
      dataRef.current = next;
      setData(next);
    };
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      applyScreen(result.values, result.versions);
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    applyScreen(result.values, result.versions, true);
    return true;
  };

  const saveWriterSelection = (selection: ExperimentalProviderModelPickerValue) => {
    writerDraftRef.current = selection;
    setWriterDraft(selection);
    writerSaveTail.current = writerSaveTail.current
      .catch(() => undefined)
      .then(async () => {
        const latest = writerDraftRef.current;
        if (!latest) return;
        const ok = await persistWriterSelection(latest);
        setWriterRejected(!ok);
        if (ok && writerDraftRef.current === latest) {
          writerDraftRef.current = null;
          setWriterDraft(null);
        }
      })
      .then(() => undefined, () => undefined);
  };

  /**
   * A role picker saves as the writer's does: it shows its latest choice at once and its saves go one after another, each on the versions
   * the one before left. The host's picker reports the provider and then the model within moments; two saves on one read of the versions
   * lost the race, reloaded the whole screen (every picker read «loading» meanwhile) and dropped the second choice.
   */
  const queueSelection = (id: string, selection: ExperimentalProviderModelPickerValue | null, persist: () => Promise<boolean>) => {
    const queue = pickerQueues.current[id] ?? { ticket: 0, tail: Promise.resolve() };
    pickerQueues.current[id] = queue;
    const ticket = ++queue.ticket;
    const setDraft = (next: ExperimentalProviderModelPickerValue | null) => {
      const { [id]: _replaced, ...rest } = pickerDraftsRef.current;
      pickerDraftsRef.current = next ? { ...rest, [id]: next } : rest;
      setPickerDrafts(pickerDraftsRef.current);
    };
    if (selection) setDraft(selection);
    const run = queue.tail.then(async () => {
      if (queue.ticket !== ticket) return false; // a later choice replaces this one
      try { return await persist(); } finally { if (queue.ticket === ticket) setDraft(null); }
    });
    queue.tail = run.catch(() => undefined);
    return run.catch(() => false);
  };

  /** The screen the saves read their versions from, as long as it is still the one the choice was made on. */
  const heldScreen = () => {
    const held = dataRef.current;
    return held && held.projectId === projectId && (held.sectionId ?? null) === selectedSectionId ? held : null;
  };

  /** What a picker's save answered: a refusal says why; a lost race keeps the answer's current values and versions instead of reloading the screen. */
  const settleSelection = (result: {
    ok: boolean; conflict: boolean; values: Record<string, unknown>; versions: Record<string, number>;
    validation?: { code: Extract<NonNullable<typeof saveError>, { kind: "validation" }>["code"]; params: string[] };
  }) => {
    if (result.ok) setSaveError(null);
    else if (!result.conflict && result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
    else setSaveError({ kind: "cas" });
    const current = dataRef.current;
    if (current && (result.ok || result.conflict)) {
      // A key without a row at this level answers null: what it inherits stays on show.
      const stored = Object.fromEntries(Object.entries(result.values).filter(([, value]) => value !== null));
      const next = {
        ...current,
        values: { ...current.values, ...stored },
        versions: { ...current.versions, ...result.versions },
        explicitKeys: result.ok ? [...new Set([...current.explicitKeys, ...Object.keys(stored)])] : current.explicitKeys,
      };
      dataRef.current = next;
      setData(next);
    }
    return result.ok;
  };

  /** One picker-saved role (memory, night review, docs, project log, PM reads, critics, specialist): the same CAS tuple through its own RPC. */
  const saveSelection = (id: SelectionId, selection: ExperimentalProviderModelPickerValue) => queueSelection(id, selection, async () => {
    const snapshot = heldScreen();
    if (!projectId || !snapshot) return false;
    const spec = SELECTION_SPECS[id];
    const keys = Object.values(selectionKeys(id));
    return settleSelection(await (rpc.call as unknown as (name: string, input: unknown) => Promise<Parameters<typeof settleSelection>[0]>)(spec.rpc, { ...scoped,
      projectId, providerId: selection.providerId, model: selection.model, reasoningLevel: selection.reasoningLevel, serviceTier: selection.serviceTier ?? null,
      expectedVersions: Object.fromEntries(keys.map((key) => [key, snapshot.versions[key] ?? 0])),
    }));
  });

  const saveWriterFallback = (slot: WriterFallbackSlot, selection: ExperimentalProviderModelPickerValue | null) => queueSelection(`writer.fallback${slot}`, selection, async () => {
    const snapshot = heldScreen();
    if (!projectId || !snapshot) return false;
    const keys = writerFallbackKeys(slot);
    return settleSelection(await rpc.call("save_writer_fallback_selection", { ...scoped, projectId, slot,
      ...(selection ? { providerId: selection.providerId, model: selection.model, reasoningLevel: selection.reasoningLevel as "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra" } : { off: true }),
      expectedVersions: Object.fromEntries(Object.values(keys).map((key) => [key, snapshot.versions[key] ?? 0])),
    }));
  });

  const runStack = async (op: "detect" | "install" | "connect" | "rollback", confirm = false) => {
    if (!projectId) return;
    try {
      if (op === "detect") setDetectResult(await rpc.call("stack_detect", { projectId }) as StackDetectResult);
      if (op === "install") await rpc.call("stack_install", { projectId, confirmExternalOps: confirm });
      if (op === "connect") await rpc.call("stack_connect", { projectId, confirmExternalOps: confirm });
      if (op === "rollback") await rpc.call("stack_rollback", { projectId, ...(snapshotPath || dataRef.current?.lastSnapshotPath ? { snapshotPath: snapshotPath || dataRef.current?.lastSnapshotPath || undefined } : {}) });
      toast.success(<span data-bb-ru-skip>{t("toastOk")}</span>);
      await reload();
    } catch (cause) {
      toast.error(<span data-bb-ru-skip>{cause instanceof Error ? cause.message : t("toastError")}</span>);
    }
  };

  return {
    saveError, setSaveError, detectResult, setDetectResult, writerRejected, setWriterRejected,
    saveTailRef, writerSaveTail, writeDraft, save, saveKey, applySetting, resetInherited, displayedValue,
    persistWriterSelection, saveWriterSelection, saveSelection, saveWriterFallback, runStack,
  };
}
