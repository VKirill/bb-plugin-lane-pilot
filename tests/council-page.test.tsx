// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

/** Node's experimental localStorage is undefined here, so each test gets an in-memory Storage. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => { data.clear(); },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const detail = {
  id: "cncl_1", question: "Как поднять повторные покупки?", state: "discussion", round: 2, maxRounds: 3,
  agenda: ["Где покупатели останавливаются?"], criteria: ["эффект", "простота"], decisionPath: null, reason: null, recommendation: null,
  speaking: "skeptic", speakingSince: 1,
  seats: [{ id: "product", title: "Product director", providerId: "codex", model: "m" }, { id: "skeptic", title: "Skeptic", providerId: "agy", model: "g" }],
  messages: [
    { seq: 1, seatId: "owner", round: 0, kind: "owner", text: "Как поднять повторные покупки?", at: 1 },
    { seq: 2, seatId: "chair", round: 0, kind: "agenda", text: "Agenda: 1. Где покупатели останавливаются?", at: 2 },
    { seq: 3, seatId: "product", round: 1, kind: "position", text: "Убрать шаг с аккаунтом.", at: 3 },
  ],
};

/** The block width the page measures: below 1024 the chat page, at or above it the office. */
function setBlockWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
}

async function mountCouncilPage(said: Array<Record<string, unknown>>) {
  const app = await loadPluginApp(() => import("../app"));
  const panel = app.navPanels.find((item) => item.id === "lane-pilot-council")!;
  return renderSlot(panel, { subPath: "" }, {
    context: { projectId: "proj_ui", threadId: null },
    providers: { status: "ready", providers: [] as never },
    rpc: {
      get_preferences: (input: unknown) => ({ locale: (input as { suggestedLocale: "en" | "ru" }).suggestedLocale, preference: "auto", lastProjectId: null }),
      list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: "proj_ui" }),
      list_councils: () => ({ councils: [{ id: "cncl_1", runId: "r", question: detail.question, state: "discussion", round: 2, maxRounds: 3, decisionPath: null, updatedAt: 1 }] }),
      get_council: () => detail,
      council_say: (input: unknown) => { said.push(input as Record<string, unknown>); return { seq: 4, decideRequested: Boolean((input as { decide?: boolean }).decide) }; },
      council_stop: () => ({ stopRequested: true }),
    },
  });
}

describe("council page on the chat layout (below 1024 px)", () => {
  beforeEach(() => setBlockWidth(800));

  it("shows the council as a chat with presence and lets the owner speak and ask for the decision", async () => {
    const said: Array<Record<string, unknown>> = [];
    const view = await mountCouncilPage(said);
    await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Убрать шаг с аккаунтом."));
    expect(view.getByTestId("council-typing").textContent).toContain("Skeptic");
    expect(view.getByTestId("council-list").textContent).toMatch(/in session|идёт/);
    const input = view.getByLabelText(/Say|Сказать/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Скептик, что с ценами?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]).toEqual({ councilId: "cncl_1", text: "Скептик, что с ценами?" });
    fireEvent.click(view.getByText(/Decide now|Решать/));
    await waitFor(() => expect(said).toHaveLength(2));
    expect(said[1]).toEqual({ councilId: "cncl_1", decide: true });
  });

  it("has no office, no canvas and no drawer on the chat page", async () => {
    const view = await mountCouncilPage([]);
    await waitFor(() => expect(view.getByTestId("council-messages")).toBeDefined());
    expect(view.queryByTestId("council-office")).toBeNull();
    expect(view.queryByTestId("council-drawer")).toBeNull();
    expect(view.queryByTestId("council-peek")).toBeNull();
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(view.getByTestId("council-page").getAttribute("data-council-layout")).toBe("chat");
  });

  it("bounds the header with line-clamp and replays the cursor message in the feed", async () => {
    const view = await mountCouncilPage([]);
    await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Убрать шаг с аккаунтом."));

    const header = view.getByTestId("council-header");
    expect(header.querySelector(".line-clamp-3")?.textContent).toContain(detail.question);

    fireEvent.click(view.getByTestId("council-replay-step"));
    const msg1 = view.container.querySelector('[data-seq="1"]');
    expect(msg1?.className).toContain("border-amber-500");
  });
});

describe("council page on the desktop layout (1024 px and up)", () => {
  beforeEach(() => setBlockWidth(1280));

  it("renders the office with the chat drawer collapsed and the last message as a peek card", async () => {
    const view = await mountCouncilPage([]);
    await waitFor(() => expect(view.getByTestId("council-office-fallback")).toBeDefined());
    expect(view.getByTestId("council-page").getAttribute("data-council-layout")).toBe("desktop");
    expect(view.queryByTestId("council-messages")).toBeNull();
    expect(view.getByTestId("council-peek").textContent).toContain("Убрать шаг с аккаунтом.");
    expect(view.getByTestId("council-topbar")).toBeDefined();
  });

  it("opens the drawer with the feed and the composer, and remembers the state", async () => {
    const said: Array<Record<string, unknown>> = [];
    const view = await mountCouncilPage(said);
    await waitFor(() => expect(view.getByTestId("council-peek")).toBeDefined());

    fireEvent.click(view.getByTestId("council-drawer-toggle"));
    await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Убрать шаг с аккаунтом."));
    expect(view.getByTestId("council-composer")).toBeDefined();
    expect(view.queryByTestId("council-peek")).toBeNull();
    expect(localStorage.getItem("lane-pilot:council:drawer")).toBe("open");
  });

  it("starts the drawer closed when nothing is stored, and opens it when the stored state says so", async () => {
    localStorage.setItem("lane-pilot:council:drawer", "open");
    const view = await mountCouncilPage([]);
    await waitFor(() => expect(view.getByTestId("council-messages")).toBeDefined());
    expect(view.getByTestId("council-drawer")).toBeDefined();
  });

  it("replays from the drawer feed and shows the council as a select in the top bar", async () => {
    const view = await mountCouncilPage([]);
    await waitFor(() => expect(view.getByTestId("council-peek")).toBeDefined());
    fireEvent.click(view.getByTestId("council-drawer-toggle"));
    await waitFor(() => expect(view.getByTestId("council-messages")).toBeDefined());

    expect(view.getByTestId("council-list").tagName).toBe("SELECT");
    fireEvent.click(view.getByTestId("council-replay-step"));
    expect(view.container.querySelector('[data-seq="1"]')?.className).toContain("border-amber-500");
  });
});
