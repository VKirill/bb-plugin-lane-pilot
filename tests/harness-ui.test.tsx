/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { en, setLocaleOverride } from "@lane-pilot/i18n";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const arm = (attempts: number, acceptanceRate: number) => ({ attempts, tasks: attempts, accepted: 0, acceptanceRate, retries: 0, retriesPerTask: 0, blockingFindings: 0, blockingPerAttempt: 0 });
const status = {
  config: {
    enabled: true, minAttempts: 5, windowDays: 7, maxKeysPerNight: 2, editor: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
    roles: { reflect: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low" } },
  },
  roleModels: {
    inv: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
    dom: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
    compose: { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" },
    reflect: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low" },
  },
  keys: [{ area: "src/ui", writerKey: "codex", attempts: 9 }],
  active: [{ id: "h1", area: "src/ui", writerKey: "codex", state: "adopted", version: 2, inventory: "2 files: skills/ui.md, memory.md", tree: { "memory.md": "Prefer the kit Button." } }],
  trials: [{ id: "h2", area: "src/ui", writerKey: "codex", since: Date.UTC(2026, 9, 10), decision: { action: "wait", reason: "3/6 new, 4/6 old", arms: { new: arm(3, 0.66), old: arm(4, 0.5) } } }],
  retired: [], running: [],
};

afterEach(() => { cleanup(); setLocaleOverride(null); vi.clearAllMocks(); });

type PickerValue = { providerId: string; model: string; reasoningLevel: string };
type PickerNode = HTMLElement & { __onChange?: (next: PickerValue) => void };

/** BB's own picker stands in as a node that shows its value and lets the test answer as the owner would. */
function installPickerStandIn() {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & { __bbPluginRuntime?: { pluginSdkApp: Record<string, unknown> } };
  const sdk = host.__bbPluginRuntime!.pluginSdkApp;
  host.__bbPluginRuntime!.pluginSdkApp = {
    ...sdk,
    experimental_useProviders: () => ({ status: "ready", providers: [{ id: "claude-code" }, { id: "codex" }] }),
    experimental_ProviderModelPicker: (props: { value: PickerValue; onChange: (next: PickerValue) => void; routing?: { hostId?: string } }) => React.createElement("div", {
      "data-testid": "bb-provider-model-picker", "data-model": props.value.model, "data-host": props.routing?.hostId ?? "",
      ref: (node: PickerNode | null) => { if (node) node.__onChange = props.onChange; },
    }),
  };
}

async function mount(rpc: Record<string, (args: unknown) => unknown>, hostId: string | null = "h1") {
  installPickerStandIn();
  // The SDK shim reads the runtime once, when the app is first imported: the stand-in goes in before that.
  await loadPluginApp(await import("../app"));
  // Loaded after the app: the SDK test runtime installs the app module the card hooks into.
  const { HarnessCard } = await import("../src/rooms/harness/ui");
  return renderSlot({ component: () => <HarnessCard projectId="p1" hostId={hostId} /> }, {}, { context: { projectId: "p1", threadId: null }, rpc });
}
const pickerIn = (slot: Awaited<ReturnType<typeof mount>>, testId: string) => slot.getByTestId(testId).querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;

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

  it("shows the model of every role, marks the ones on the default, and saves a role's own model", async () => {
    const calls: Array<[string, unknown]> = [];
    const slot = await mount({
      harness_status: () => status,
      harness_configure: (args) => { calls.push(["harness_configure", args]); return {}; },
    });
    await slot.findByTestId("harness-models");
    for (const key of ["harnessRole_inv", "harnessRole_dom", "harnessRole_compose", "harnessRole_reflect"] as const) expect(slot.getByTestId("harness-models").textContent).toContain(en[key]);
    expect(slot.getByTestId("harness-model-compose-default").textContent).toBe(en.harnessAsDefault);
    expect(slot.queryByTestId("harness-model-reflect-default")).toBeNull();
    expect(pickerIn(slot, "harness-model-reflect").getAttribute("data-model")).toBe("gpt-6-luna");
    expect(pickerIn(slot, "harness-model-compose").getAttribute("data-host")).toBe("h1");

    // A picker that reports its own value on mount saves nothing.
    pickerIn(slot, "harness-model-compose").__onChange!({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" });
    pickerIn(slot, "harness-model-compose").__onChange!({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "medium" });
    await waitFor(() => expect(calls).toEqual([["harness_configure", { projectId: "p1", patch: { roles: { compose: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "medium" } } } }]]));

    pickerIn(slot, "harness-model-editor").__onChange!({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" });
    await waitFor(() => expect(calls[1]).toEqual(["harness_configure", { projectId: "p1", patch: { editor: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" } } }]));

    fireEvent.click(slot.getByRole("button", { name: en.harnessResetRole }));
    await waitFor(() => expect(calls[2]).toEqual(["harness_configure", { projectId: "p1", patch: { roles: { reflect: null } } }]));
  });

  it("shows a failed model save inline, and plain text with a note when no host is known", async () => {
    const failing = await mount({ harness_status: () => status, harness_configure: () => { throw new Error("hub refused"); } });
    await failing.findByTestId("harness-models");
    pickerIn(failing, "harness-model-dom").__onChange!({ providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low" });
    expect((await failing.findByTestId("harness-error")).textContent).toContain("hub refused");
    cleanup();

    const bare = await mount({ harness_status: () => status }, null);
    await bare.findByTestId("harness-models");
    expect(bare.getByTestId("harness-no-host").textContent).toBe(en.harnessNoHost);
    expect(bare.queryByTestId("bb-provider-model-picker")).toBeNull();
    expect(bare.getByTestId("harness-model-reflect").textContent).toContain("gpt-6-luna (low)");
  });

  it("shows an RPC failure inline instead of crashing", async () => {
    const slot = await mount({ harness_status: () => { throw new Error("hub is down"); } });
    expect((await slot.findByTestId("harness-error")).textContent).toContain("hub is down");
  });
});
