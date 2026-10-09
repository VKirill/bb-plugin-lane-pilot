/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    await slot.behavior.emitRealtime("lp:proj_1", { kind: "council" });
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

const detail = {
  id: "cncl_1", question: "Q?", state: "discussion", round: 1, maxRounds: 3, agenda: [], criteria: [], decisionPath: null, reason: null, recommendation: null,
  speaking: null, speakingSince: null,
  seats: [{ id: "product", title: "Product director", providerId: "codex", model: "m" }],
  messages: [{ seq: 1, seatId: "owner", round: 0, kind: "owner", text: "Q?", at: 1 }],
};

describe("the council page follows the server's signals (H6)", () => {
  it("shows a new message at once on a council signal for its project", async () => {
    // A narrow window renders the chat-only council page, where the feed is always visible.
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 800 });
    try {
      const state = { messages: detail.messages, detailReads: 0 };
      const app = await loadPluginApp(() => import("../app"));
      const panel = app.navPanels.find((item) => item.id === "lane-pilot-council")!;
      const view = await renderSlot(panel, { subPath: "" }, {
        context: { projectId: "proj_ui", threadId: null },
        providers: { status: "ready", providers: [] as never },
        rpc: {
          get_preferences: (input: unknown) => ({ locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale, preference: "auto", lastProjectId: null }),
          list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI" }], lastProjectId: "proj_ui" }),
          list_councils: () => ({ councils: [{ id: "cncl_1", runId: "r", question: "Q?", state: "discussion", round: 1, maxRounds: 3, decisionPath: null, updatedAt: 1 }] }),
          get_council: () => { state.detailReads += 1; return { ...detail, messages: state.messages }; },
        },
      });
      await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Q?"));
      const before = state.detailReads;
      state.messages = [...detail.messages, { seq: 2, seatId: "product", round: 1, kind: "position", text: "Drop the account step.", at: 2 }];
      await view.behavior.emitRealtime("lp:proj_ui", { kind: "council" });
      await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Drop the account step."));
      expect(state.detailReads).toBeGreaterThan(before);
      view.lifecycle.unmount();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: originalWidth });
    }
  });
});
