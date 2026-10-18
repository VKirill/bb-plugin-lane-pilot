/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { en, setLocaleOverride } from "@lane-pilot/i18n";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const arm = (attempts: number, acceptanceRate: number) => ({ attempts, tasks: attempts, accepted: 0, acceptanceRate, retries: 0, retriesPerTask: 0, blockingFindings: 0, blockingPerAttempt: 0 });
const status = {
  config: { enabled: true, minAttempts: 5, windowDays: 7, maxKeysPerNight: 2, editor: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" } },
  keys: [{ area: "src/ui", writerKey: "codex", attempts: 9 }],
  active: [{ id: "h1", area: "src/ui", writerKey: "codex", state: "adopted", version: 2, inventory: "2 files: skills/ui.md, memory.md", tree: { "memory.md": "Prefer the kit Button." } }],
  trials: [{ id: "h2", area: "src/ui", writerKey: "codex", since: Date.UTC(2026, 9, 10), decision: { action: "wait", reason: "3/6 new, 4/6 old", arms: { new: arm(3, 0.66), old: arm(4, 0.5) } } }],
  retired: [], running: [],
};

afterEach(() => { cleanup(); setLocaleOverride(null); vi.clearAllMocks(); });

async function mount(rpc: Record<string, (args: unknown) => unknown>) {
  await loadPluginApp(() => import("../app"));
  // Loaded after the app: the SDK test runtime installs the app module the card hooks into.
  const { HarnessCard } = await import("../src/rooms/harness/ui");
  return renderSlot({ component: () => <HarnessCard projectId="p1" /> }, {}, { context: { projectId: "p1", threadId: null }, rpc });
}

describe("HarnessCard", () => {
  it("shows the trial, the tree and the key, and runs the editor for a key", async () => {
    const calls: Array<[string, unknown]> = [];
    const slot = await mount({
      harness_status: () => status,
      harness_edit: (args) => { calls.push(["harness_edit", args]); return { status: "started", detail: "in the background", threadIds: [] }; },
    });
    expect((await slot.findByTestId("harness-trial-h2")).textContent).toContain("src/ui");
    expect(slot.getByTestId("harness-trial-h2").textContent).toContain("3/6 new, 4/6 old");
    expect(slot.getByTestId("harness-tree-h1").textContent).toContain("2 files: skills/ui.md, memory.md");
    expect(slot.getByTestId("harness-tree-h1").textContent).toContain("Prefer the kit Button.");
    fireEvent.click(slot.getByRole("button", { name: en.harnessRunEditor }));
    await waitFor(() => expect(calls).toEqual([["harness_edit", { projectId: "p1", area: "src/ui", writerKey: "codex", wait: false }]]));
    expect((await slot.findByTestId("harness-note")).textContent).toContain("started");
  });

  it("shows an RPC failure inline instead of crashing", async () => {
    const slot = await mount({ harness_status: () => { throw new Error("hub is down"); } });
    expect((await slot.findByTestId("harness-error")).textContent).toContain("hub is down");
  });
});
