import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export const useCockpitRpc = () => useRpc<typeof rpcContract>();

/** Fill a string's `{name}` slots. */
export const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));

/** One read: its data, its error, and a reload; `deps` change it. Waiting instead of a blank page while it loads. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const reload = useCallback(() => {
    setState((prev) => ({ ...prev, loading: true }));
    load().then((data) => setState({ data, error: null, loading: false }), (cause: unknown) => setState({ data: null, error: cause instanceof Error ? cause.message : String(cause), loading: false }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/** Waiting rings instead of a blank page; the error when the read failed. */
export function Loaded<T>({ state, children }: { state: { data: T | null; error: string | null; loading: boolean }; children: (data: T) => ReactNode }) {
  if (state.error) return <p className="text-sm text-destructive" role="alert">{fill("ckError", { e: state.error })}</p>;
  if (state.data === null) return <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="ck-waiting"><span className="size-3 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />{t("ckLoading")}</p>;
  return <>{children(state.data)}</>;
}

export function Panel({ title, testId, actions, children }: { title: string; testId: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Surface testId={testId}>
      <SurfaceHeader><div className="flex min-w-0 items-center justify-between gap-2"><h3 className="min-w-0 truncate text-sm font-medium">{title}</h3>{actions}</div></SurfaceHeader>
      <SurfaceBody>{children}</SurfaceBody>
    </Surface>
  );
}

export const RefreshButton = ({ onClick }: { onClick: () => void }) => <Button size="sm" variant="ghost" onClick={onClick}>{t("ckRefresh")}</Button>;

/** A small text input in the kit's look. */
export function Field({ label, value, onChange, multiline, testId }: { label: string; value: string; onChange: (value: string) => void; multiline?: boolean; testId?: string }) {
  const cls = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-base sm:text-sm";
  return (
    <label className="block space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {multiline ? <textarea className={`${cls} min-h-20`} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        : <input className={cls} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId} />}
    </label>
  );
}

/** Time the card was visible: how long the screen stayed in view, sent when it leaves. */
export function useSeen(rpc: Rpc, screen: string) {
  const since = useRef(Date.now());
  useEffect(() => {
    since.current = Date.now();
    return () => { void rpc.call("cockpit_seen", { screen, ms: Math.round(Date.now() - since.current) }).catch(() => undefined); };
  }, [rpc, screen]);
}

/** Window picture cache: an image fetched once per URL, then served from memory while the window lives. */
const pictures = new Map<string, string>();
export function CachedImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [url, setUrl] = useState(pictures.get(src) ?? null);
  useEffect(() => {
    if (pictures.has(src)) { setUrl(pictures.get(src)!); return; }
    let live = true;
    void fetch(src).then((answer) => answer.blob()).then((blob) => { const made = URL.createObjectURL(blob); pictures.set(src, made); if (live) setUrl(made); }).catch(() => undefined);
    return () => { live = false; };
  }, [src]);
  return url ? <img src={url} alt={alt} className={className} /> : null;
}

export const day = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
