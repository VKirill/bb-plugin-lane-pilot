import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { GLOBAL_SETTINGS_PROJECT_ID, VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import type { rpcContract } from "../../contracts";

export type Tier = "night_decides" | "night_proposes" | "owner_only";
export type ImprovementView = {
  generatedAt: number;
  values: Record<string, unknown>;
  versions: Record<string, number>;
  status: {
    night: { enabled: boolean; hour: number; lastRunAt: number | null; lastDryRun: boolean; lastSpend: number | null; lastCap: number | null; nextRunAt: number | null; openClasses: number };
    bench: { version: string; tasks: number; candidates: number; createdAt: number; sets: number } | null;
    policy: { version: number; frozenAt: string; unseen: number; needed: number; enough: boolean; passed: boolean };
    waiting: { total: number; wake: number };
  };
  policy: {
    version: number;
    frozenAt: string;
    minAccuracy: number;
    verdict: string;
    accuracy: number | null;
    inSplit: number;
    seenExcluded: number;
    lastRun: { at: number; correct: number; total: number; passed: boolean } | null;
    tiers: Array<{ tier: Tier; entries: Array<{ id: string; description: string }> }>;
    prohibitions: Array<{ id: string; description: string }>;
  };
  deferrals: { open: number; overdue: number; needsTerm: number };
};

export type SaveError = { kind: "conflict" } | { kind: "validation"; code: "invalid_choice" | "incompatible_setting"; params: string[] } | { kind: "failed"; message: string };
export type DryRun = {
  night: string; dryRun: boolean; classesSeen: number; picked: Array<{ classKey: string; why: string; round: number }>;
  morning: Array<{ classKey: string; why: string }>; hunts: string[]; backlog: string[]; stoppedBy: string | null;
};

/**
 * The screen's one source: `improvement_view` for what to show, `save_setting` on the global level for every change, the same call and the same
 * versions as any other setting. A change is shown at once and the view is read again behind it, so the status strip catches up.
 */
export function useImprovement() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<ImprovementView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dry, setDry] = useState<{ state: "idle" | "running" | "failed" | "done"; result?: DryRun; message?: string }>({ state: "idle" });
  const latest = useRef<ImprovementView | null>(null);
  latest.current = view;

  const load = useCallback(async () => {
    try {
      setView(await rpc.call("improvement_view", {}) as ImprovementView);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);

  const displayed = (key: string): unknown => (key in drafts ? drafts[key] : view?.values[key]);
  const setDraft = (key: string, value: unknown) => setDrafts((current) => ({ ...current, [key]: value }));

  const save = async (key: string, value: unknown) => {
    const current = latest.current;
    if (!current) return;
    // A value the field already has is not a change (a blur without typing).
    const unchanged = value === current.values[key] || (current.values[key] == null && (value === "" || String(value) === VISIBLE_CATALOG.find((row) => row.storageKey === key)?.defaultValue));
    if (unchanged) {
      setDrafts((all) => { const { [key]: _gone, ...rest } = all; return rest; });
      return;
    }
    setBusyKey(key);
    setSaveError(null);
    try {
      const result = await rpc.call("save_setting", { projectId: GLOBAL_SETTINGS_PROJECT_ID, key, value, expectedVersion: current.versions[key] ?? 0 }) as
        { ok: boolean; conflict: boolean; version: number; validation?: { code: "invalid_choice" | "incompatible_setting"; params: string[] } };
      if (result.ok) {
        setView((now) => now ? { ...now, values: { ...now.values, [key]: value }, versions: { ...now.versions, [key]: result.version } } : now);
        setDrafts((all) => { const { [key]: _gone, ...rest } = all; return rest; });
        void load();
      } else if (result.conflict) {
        setSaveError({ kind: "conflict" });
        setDrafts((all) => { const { [key]: _gone, ...rest } = all; return rest; });
        await load();
      } else if (result.validation) {
        setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
        setDrafts((all) => { const { [key]: _gone, ...rest } = all; return rest; });
      }
    } catch (cause) {
      setSaveError({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusyKey(null);
    }
  };

  const dryRun = async () => {
    setDry({ state: "running" });
    try {
      setDry({ state: "done", result: await rpc.call("wall_night", { dryRun: true }) as DryRun });
    } catch (cause) {
      setDry({ state: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return { view, error, saveError, displayed, setDraft, save, busyKey, dry, dryRun, reload: load };
}
export type Improvement = ReturnType<typeof useImprovement>;
