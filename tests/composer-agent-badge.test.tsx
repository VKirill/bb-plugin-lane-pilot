/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { findComposerPromptBox, promptBoxFrameStyle, PROMPT_BOX_AGENT_LABEL_LEFT } from "../src/ui/composer-prompt-box";
import { setPendingNativeAgent } from "../src/ui/pending-native-agent";

afterEach(() => {
  cleanup();
  setLocaleOverride(null);
  setPendingNativeAgent(null);
});

async function mountBadge(input: {
  scope: { kind: "new-thread"; projectId: string | null } | { kind: "thread"; threadId: string };
  preference?: "en" | "ru" | "auto";
  nativeThread?: {
    token: string;
    agentId: string;
    agentType: string;
    projectId: string;
    description: string;
  } | null;
  helpers?: Array<{ id: string; title: string; status: string; role: string; detail: string | null; phase?: string | null }>;
  queued?: string[];
  openThreadPanel?: (options: unknown) => boolean;
}) {
  const preference = input.preference ?? "en";
  const app = await loadPluginApp(() => import("../app"));
  const banner = app.composerCustomizations.find((row) => row.id === "lane-pilot-agent-badge")?.banners?.[0];
  if (!banner) throw new Error("missing agent badge banner");
  return renderSlot({ component: banner.component }, {}, {
    context: {
      projectId: input.scope.kind === "new-thread" ? input.scope.projectId : null,
      threadId: input.scope.kind === "thread" ? input.scope.threadId : null,
    },
    composer: { scope: input.scope, text: "" },
    rpc: {
      get_preferences: () => ({
        locale: preference === "auto" ? "en" : preference,
        preference,
        lastProjectId: null,
      }),
      native_thread: () => input.nativeThread ?? null,
      list_helper_threads: () => ({ threads: input.helpers ?? [], queued: input.queued ?? [] }),
    },
    ...(input.openThreadPanel ? { openThreadPanel: input.openThreadPanel as never } : {}),
  });
}

describe("Lane Pilot composer agent badge", () => {
  it("registers a bare banner on thread and new-thread composers", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const row = app.composerCustomizations.find((item) => item.id === "lane-pilot-agent-badge");
    expect(row?.scopes).toEqual(["thread", "new-thread"]);
    expect(row?.banners?.[0]).toMatchObject({ id: "native-agent", chrome: "bare" });
  });

  it("renders nothing when the thread has no native agent", async () => {
    const slot = await mountBadge({
      scope: { kind: "thread", threadId: "thr_plain" },
      nativeThread: null,
    });
    expect(slot.queryByLabelText("Lane Pilot agent")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows the localized specialist name on a bound thread", async () => {
    const slot = await mountBadge({
      scope: { kind: "thread", threadId: "thr_copy" },
      preference: "ru",
      nativeThread: {
        token: "11111111-1111-1111-1111-111111111111",
        agentId: "copy-lead",
        agentType: "copy-lead",
        projectId: "proj_a",
        description: "Lane Pilot copy lead",
      },
    });
    await waitFor(() => expect(slot.getByLabelText("Агент Lane Pilot")).toBeTruthy());
    expect(slot.getByText("Редактор текстов")).toBeTruthy();
    expect(slot.getByLabelText("Агент Lane Pilot").querySelector("[data-chart]")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("shows the pending agent on a new thread after Enable", async () => {
    setPendingNativeAgent({ agentId: "copy-lead", description: "Lane Pilot copy lead" });
    const slot = await mountBadge({
      scope: { kind: "new-thread", projectId: "proj_a" },
    });
    expect(slot.getByText("Copy editor")).toBeTruthy();
    expect(slot.getByLabelText("Lane Pilot agent").querySelector("[data-chart]")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("copies the prompt box stroke so the label matches the chat frame", () => {
    const box = document.createElement("form");
    box.style.border = "1px dashed rgb(20, 30, 40)";
    box.style.backgroundColor = "rgb(5, 6, 7)";
    box.style.borderRadius = "14px";
    document.body.append(box);
    // The stroke and fill are copied; the radius is not (0.1.50: the box's 14px made the 20px label a pill).
    expect(promptBoxFrameStyle(box)).toMatchObject({
      borderStyle: "dashed",
      borderColor: "rgb(20, 30, 40)",
      backgroundColor: "rgb(5, 6, 7)",
    });
    expect(promptBoxFrameStyle(box)).not.toHaveProperty("borderRadius");
    box.remove();
  });

  it("finds the prompt box inside the composer shell", () => {
    const shell = document.createElement("div");
    shell.setAttribute("data-promptbox-shell", "");
    const marker = document.createElement("span");
    const box = document.createElement("form");
    box.setAttribute("data-promptbox", "");
    shell.append(marker, box);
    document.body.append(shell);
    expect(findComposerPromptBox(marker)).toBe(box);
    shell.remove();
  });

  it("portals the badge onto the prompt box frame", async () => {
    const slot = await mountBadge({
      scope: { kind: "thread", threadId: "thr_copy" },
      nativeThread: {
        token: "11111111-1111-1111-1111-111111111111",
        agentId: "copy-lead",
        agentType: "copy-lead",
        projectId: "proj_a",
        description: "Lane Pilot copy lead",
      },
    });
    const marker = await waitFor(() => {
      const node = document.querySelector("[data-lane-pilot-agent-marker]");
      if (!node) throw new Error("missing marker");
      return node;
    });
    const shell = document.createElement("div");
    shell.setAttribute("data-promptbox-shell", "");
    const box = document.createElement("form");
    box.setAttribute("data-promptbox", "");
    box.className = "relative";
    box.style.border = "1px dashed rgb(20, 30, 40)";
    box.style.backgroundColor = "rgb(5, 6, 7)";
    box.style.borderRadius = "14px";
    const root = marker.parentElement;
    if (!root) throw new Error("missing marker parent");
    root.parentElement?.insertBefore(shell, root);
    shell.append(root, box);
    await waitFor(() => expect(box.querySelector("[aria-label='Lane Pilot agent']")).toBeTruthy());
    expect(box.textContent).toContain("Copy editor");
    const label = box.querySelector("[aria-label='Lane Pilot agent']") as HTMLElement;
    // The wrapper sits on the border and also carries the working helpers' squares.
    const wrapper = label.parentElement as HTMLElement;
    expect(wrapper.style.left).toBe(PROMPT_BOX_AGENT_LABEL_LEFT);
    expect(wrapper.style.position).toBe("absolute");
    expect(label.style.borderStyle).toBe("dashed");
    expect(label.style.borderColor).toBe("rgb(20, 30, 40)");
    expect(label.style.backgroundColor).toBe("rgb(5, 6, 7)");
    expect(label.style.borderRadius).toBe("0.375rem");
    slot.lifecycle.unmount();
  });

  it("shows a square per working helper next to the agent and opens it in the side panel", async () => {
    const opened: unknown[] = [];
    const slot = await mountBadge({
      scope: { kind: "thread", threadId: "thr_pm" },
      nativeThread: { token: "11111111-1111-1111-1111-111111111111", agentId: "dev-orchestrator", agentType: "dev-orchestrator", projectId: "proj_a", description: "Development coordinator" },
      helpers: [
        { id: "thr_writer", title: "Blog look-card chooser modal", status: "active", role: "writer", detail: null },
        { id: "thr_design", title: "Wizard mockup", status: "active", role: "specialist", detail: "design-lead" },
      ],
      openThreadPanel: (options) => { opened.push(options); return true; },
    });
    const writer = await slot.findByTestId("helper-chip-thr_writer");
    expect(writer.getAttribute("title")).toBe("Writer: Blog look-card chooser modal");
    expect(slot.getByTestId("helper-chip-thr_design").getAttribute("title")).toBe("Specialist · design-lead: Wizard mockup");
    fireEvent.click(writer);
    expect(opened).toEqual([{ actionId: "lane-helper-thread", title: "Blog look-card chooser modal", params: { threadId: "thr_writer" } }]);
    slot.lifecycle.unmount();
  });

  it("goes to the helper's thread where the surface has no side panel", async () => {
    const slot = await mountBadge({
      scope: { kind: "thread", threadId: "thr_pm" },
      nativeThread: { token: "11111111-1111-1111-1111-111111111111", agentId: "dev-orchestrator", agentType: "dev-orchestrator", projectId: "proj_a", description: "Development coordinator" },
      helpers: [{ id: "thr_writer", title: "Task", status: "active", role: "writer", detail: null }],
      openThreadPanel: () => false,
    });
    fireEvent.click(await slot.findByTestId("helper-chip-thr_writer"));
    expect(slot.inspection.navigateCalls).toContainEqual(expect.objectContaining({ method: "toThread" }));
    slot.lifecycle.unmount();
  });
});
