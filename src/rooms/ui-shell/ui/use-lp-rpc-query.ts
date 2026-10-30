import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useRpcQuery, useRpc } from "@get-bb/plugin-sdk/app";
import { uiQueryContract } from "../../contracts/ui-query";
import type { rpcContract } from "../../contracts";

type Method = keyof typeof uiQueryContract & string;

export type LpRpcQueryState<T = unknown> = { data: T | undefined; error: unknown; isLoading: boolean; isFetching: boolean; refetch(): Promise<void> };

/**
 * One Lane Pilot read, replacing a hand-rolled rpc.call + setInterval. On BB 0.6+ it is
 * `experimental_useRpcQuery`: the host watches the read, pauses it while the panel is hidden and refreshes it on
 * server invalidations. An older BB gets the same read on a plain interval — the path every screen had before.
 * `pollMs` is the slow safety poll in both paths (signals and invalidations still refresh faster); `enabled: false`
 * disables the read entirely. For a read that is not one contract call (several calls, local math), pass `fetcher`
 * instead of `method`: the modern path then can't be watched, so it is the same visible-page interval in both paths.
 */
export function useLpRpcQuery<T = unknown>(
  method: Method | null,
  input: unknown,
  options?: { pollMs?: number; enabled?: boolean; fetcher?: () => Promise<T> },
): LpRpcQueryState<T> {
  return useRpcQueryAvailable() ? useModernRpcQuery<T>(method, input, options) : useLegacyRpcPoll<T>(method, input, options);
}

/** The runtime hook survives on any host that shipped SDK 0.6 reads; a stubbed/absent export means the legacy path. */
const useRpcQueryAvailable = () => typeof experimental_useRpcQuery === "function";

function useModernRpcQuery<T>(method: Method | null, input: unknown, options?: { pollMs?: number; enabled?: boolean; fetcher?: () => Promise<T> }): LpRpcQueryState<T> {
  const enabled = (options?.enabled ?? true) && (!!method || !!options?.fetcher);
  if (!options?.fetcher && !method) throw new Error("useLpRpcQuery: method or fetcher required");
  if (options?.fetcher) return useLegacyRpcPoll<T>(null, input, options);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- presence of the host hook is fixed for the session
  const query = experimental_useRpcQuery({ contract: uiQueryContract, method: method as never, input: (input ?? null) as never, enabled });
  const refetch = useRef(query.refetch);
  refetch.current = query.refetch;
  useInterval(options?.pollMs, enabled, () => { void refetch.current(); });
  return query as LpRpcQueryState<T>;
}

function useLegacyRpcPoll<T>(method: Method | null, input: unknown, options?: { pollMs?: number; enabled?: boolean; fetcher?: () => Promise<T> }): LpRpcQueryState<T> {
  const rpc = useRpc<typeof rpcContract>();
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean; fetching: boolean }>({ data: undefined, error: null, loading: enabled, fetching: enabled });
  const inputKey = input === undefined ? "" : JSON.stringify(input);
  const readNow = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!enabled || (!method && !options?.fetcher)) return;
    let live = true;
    const args = (inputKey === "" ? [] : [JSON.parse(inputKey)]) as unknown[];
    const read = async () => {
      try {
        const data = options?.fetcher ? await options.fetcher() : await (rpc.call as (...a: unknown[]) => Promise<unknown>)(method as string, ...args) as T;
        if (live) setState({ data, error: null, loading: false, fetching: false });
      } catch (error) {
        if (live) setState((prev) => ({ ...prev, error, loading: false, fetching: false }));
      }
    };
    readNow.current = read;
    void read();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, method, inputKey, enabled, options?.fetcher]);
  useInterval(options?.pollMs, enabled, () => { void readNow.current(); });
  return { data: state.data, error: state.error, isLoading: state.loading, isFetching: state.fetching, refetch: () => readNow.current() };
}

function useInterval(pollMs: number | undefined, enabled: boolean, tick: () => void) {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => {
    if (!pollMs || !enabled) return;
    const timer = setInterval(() => tickRef.current(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, enabled]);
}

/** The slow safety poll of the screens: a plain interval today, and the seam a host-driven refresh will later replace. */
export function useLpPoll(pollMs: number | undefined, tick: () => void): void {
  useInterval(pollMs, pollMs !== undefined, tick);
}
