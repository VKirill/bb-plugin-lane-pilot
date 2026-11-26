/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { LIVE_FALLBACK_MS, OFFLINE_POLL_MS } from "@lane-pilot/ui-kit/realtime-channel";

afterEach(() => cleanup());

type Helper = { id: string; title: string; status: string; role: string; detail: string | null; phase?: string | null };

async function mountBadge(state: { helpers: Helper[]; reads: number }, projectId = "proj_1") {
  const app = await loadPluginApp(() => import("../app"));
  const banner = app.composerCustomizations.find((row) => row.id === "lane-pilot-agent-badge")?.banners?.[0];
  if (!banner) throw new Error("missing agent badge banner");
  return renderSlot({ component: banner.component }, {}, {
    context: { projectId, threadId: "thr_pm" },
    composer: { scope: { kind: "thread", threadId: "thr_pm" }, text: "" },
    rpc: {
      get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
      native_thread: () => ({ token: "t", agentId: "dev-orchestrator", agentType: "dev-orchestrator", projectId, description: "Coordinator" }),
      list_helper_threads: () => { state.reads += 1; return { threads: state.helpers, queued: [] }; },
    },
  });
}

describe("helper squares follow the server's signals (H6)", () => {
  it("re-reads on a helpers signal for this chat and ignores other chats, kinds and projects", async () => {
    const state = { helpers: [] as Helper[], reads: 0 };
    const slot = await mountBadge(state);
    await waitFor(() => expect(state.reads).toBe(1));

    state.helpers = [{ id: "thr_w1", title: "Task 1", status: "active", role: "writer", detail: null, phase: "работает" }];
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "helpers", threadId: "thr_pm" });
    await slot.findByTestId("helper-chip-thr_w1");
    expect(state.reads).toBe(2);

    await slot.behavior.emitRealtime("lp:proj_1", { kind: "helpers", threadId: "thr_other_pm" });
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "workflow" });
    await slot.behavior.emitRealtime("lp:proj_2", { kind: "helpers", threadId: "thr_pm" });
    await slot.behavior.emitRealtime("lp:proj_1", "garbage");
    expect(state.reads).toBe(2);

    // A signal without a chat (an attempt of a run with no known PM) concerns every badge.
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "helpers" });
    await waitFor(() => expect(state.reads).toBe(3));
    slot.lifecycle.unmount();
  });

  it("reads again when the live connection comes back, and polls slowly only while it is up", async () => {
    expect(LIVE_FALLBACK_MS).toBeGreaterThanOrEqual(15_000);
    expect(OFFLINE_POLL_MS).toBeLessThan(LIVE_FALLBACK_MS);
    const state = { helpers: [] as Helper[], reads: 0 };
    const slot = await mountBadge(state);
    await waitFor(() => expect(state.reads).toBe(1));
    await slot.behavior.setRealtimeConnectionState("reconnecting");
    await slot.behavior.setRealtimeConnectionState("connected");
    await waitFor(() => expect(state.reads).toBeGreaterThanOrEqual(2));
    slot.lifecycle.unmount();
  });
});
