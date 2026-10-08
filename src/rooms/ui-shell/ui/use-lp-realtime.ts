import { useEffect, useRef } from "react";
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { LIVE_FALLBACK_MS, OFFLINE_POLL_MS, lpChannel, parseLpSignal, type LpRealtimeKind, type LpRealtimeSignal } from "@lane-pilot/ui-kit/realtime-channel";

/**
 * Calls `onChange` when the server says one of `kinds` changed in the project, and once more when the live connection
 * comes back after a drop (signals sent meanwhile are lost). `signal` is null for that reconnect read.
 * Returns how often the screen should still poll: slow while signals arrive, fast while they cannot.
 */
export function useLpRealtime(projectId: string | null, kinds: readonly LpRealtimeKind[], onChange: (signal: LpRealtimeSignal | null) => void): number {
  const latest = useRef(onChange);
  latest.current = onChange;
  const wanted = useRef(kinds);
  wanted.current = kinds;
  useRealtime(lpChannel(projectId ?? "-"), (payload) => {
    if (!projectId) return;
    const signal = parseLpSignal(payload);
    if (signal && wanted.current.includes(signal.kind)) latest.current(signal);
  });
  const connection = useRealtimeConnectionState();
  const dropped = useRef(false);
  useEffect(() => {
    if (connection === "reconnecting") dropped.current = true;
    else if (connection === "connected" && dropped.current) { dropped.current = false; latest.current(null); }
  }, [connection]);
  return connection === "connected" ? LIVE_FALLBACK_MS : OFFLINE_POLL_MS;
}
