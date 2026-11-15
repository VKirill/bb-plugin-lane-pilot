/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useCallback, StrictMode, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useLpRpcQuery } from "../src/rooms/ui-shell/ui/use-lp-rpc-query";

configure({ asyncUtilTimeout: 5_000 });
afterEach(() => cleanup());

/** 0.1.575: `enabled:false` means no read — a realtime/reconnect refetch must not fire the RPC on either query path. */
describe("useLpRpcQuery disabled contract", () => {
  it("a disabled query answers refetch without calling the RPC; enabling loads; unmount stays silent", async () => {
    const app = await loadPluginApp(() => import("../app"));
    void app;
    let reads = 0;
    let api: { refetch(): Promise<void> } | null = null;
    function Probe() {
      const [on, setOn] = useState(true);
      const query = useLpRpcQuery("list_helper_threads", { threadId: "thr_pm" }, { enabled: on });
      api = query;
      return <button type="button" data-testid="toggle" onClick={() => setOn((value) => !value)}>{String(on)}</button>;
    }
    const slot = await renderSlot({ component: Probe }, {}, {
      context: { projectId: "proj_a", threadId: "thr_pm" },
      rpc: { list_helper_threads: () => { reads += 1; return { threads: [], queued: [] }; } },
    });
    await waitFor(() => expect(reads).toBe(1));

    fireEvent.click(slot.getByTestId("toggle")); // enabled -> disabled: the stale read must die with the effect
    await api!.refetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(1);

    fireEvent.click(slot.getByTestId("toggle")); // disabled -> enabled loads again
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.click(slot.getByTestId("toggle")); // off, then unmount: no read from either
    slot.lifecycle.unmount();
    await api!.refetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(2);
  });

  it("StrictMode's setup-cleanup-setup leaves manual refetch alive", async () => {
    const app = await loadPluginApp(() => import("../app"));
    void app;
    let reads = 0;
    let api: { refetch(): Promise<void> } | null = null;
    function Probe() {
      const query = useLpRpcQuery("list_helper_threads", { threadId: "thr_pm" }, { enabled: true });
      api = query;
      return null;
    }
    await renderSlot({ component: () => <StrictMode><Probe /></StrictMode> }, {}, {
      context: { projectId: "proj_a", threadId: "thr_pm" },
      rpc: { list_helper_threads: () => { reads += 1; return { threads: [], queued: [] }; } },
    });
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(1));
    const before = reads;
    await api!.refetch(); // mountedRef must be true again after the remount, or this stays silent forever
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });
});

/**
 * The legacy poll path (`useLegacyRpcPoll`) is reached on this host through the `fetcher` option — the modern hook
 * delegates to it whenever a caller supplies one. The absent-`experimental_useRpcQuery` method branch cannot be
 * exercised here without mocking the module (that path only exists on pre-0.6 hosts); the disabled-read guard it
 * shares — the `live` flag and the `readNow` ref — is the same code the fetcher exercises below, including a real
 * `rpc.call` inside the fetcher.
 */
describe("useLpRpcQuery disabled contract (legacy poll via fetcher)", () => {
  it("a disabled or stale query answers refetch without calling the RPC; a new input loads", async () => {
    const app = await loadPluginApp(() => import("../app"));
    void app;
    let reads = 0;
    const seen: unknown[] = [];
    let api: { refetch(): Promise<void> } | null = null;
    let setId: ((id: string | null) => void) | null = null;
    function Probe() {
      const [id, set] = useState<string | null>(null);
      setId = set;
      const rpc = useRpc();
      const fetcher = useCallback(() => rpc.call("list_helper_threads", id ? { threadId: id } : {}) as Promise<unknown>, [rpc, id]);
      api = useLpRpcQuery<unknown>(null, null, { enabled: !!id, fetcher });
      return null;
    }
    const slot = await renderSlot({ component: Probe }, {}, {
      context: { projectId: "proj_a", threadId: "thr_pm" },
      rpc: { list_helper_threads: (input: unknown) => { reads += 1; seen.push(input); return { threads: [], queued: [] }; } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0); // null thread id: disabled from the start

    await api!.refetch(); // the realtime/reconnect call the SDK lets through
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0);

    await act(async () => { setId!("thr_a"); }); // enabling with a thread loads
    await waitFor(() => expect(reads).toBe(1));
    expect(seen[0]).toEqual({ threadId: "thr_a" });

    await api!.refetch(); // enabled: a real refetch reads
    await waitFor(() => expect(reads).toBe(2));

    await act(async () => { setId!(null); }); // thread switch to disabled: the stale read must not fire
    await api!.refetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(2);

    await act(async () => { setId!("thr_b"); }); // a new thread loads again
    await waitFor(() => expect(reads).toBe(3));
    expect(seen[2]).toEqual({ threadId: "thr_b" });

    await act(async () => { setId!(null); });
    slot.lifecycle.unmount();
    await api!.refetch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(3);
  });
});
