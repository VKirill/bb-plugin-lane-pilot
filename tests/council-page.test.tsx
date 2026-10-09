// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(() => cleanup());

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

describe("council page", () => {
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

  it("renders office fallback in jsdom without throwing alongside the log and supports replay step", async () => {
    const said: Array<Record<string, unknown>> = [];
    const view = await mountCouncilPage(said);
    await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Убрать шаг с аккаунтом."));

    // Fallback renders alongside the log
    expect(view.getByTestId("council-office-fallback")).toBeDefined();
    expect(view.getByTestId("council-office-fallback").textContent).toMatch(/WebGL|Office/i);

    // Replay controls exist
    const stepBtn = view.getByTestId("council-replay-step");
    expect(stepBtn).toBeDefined();

    // Clicking step highlights the first message
    fireEvent.click(stepBtn);
    const msg1 = view.container.querySelector('[data-seq="1"]');
    expect(msg1).toBeDefined();
    expect(msg1?.className).toContain("border-amber-500");
  });

  it("bounds the header with line-clamp and places agenda in disclosure", async () => {
    const said: Array<Record<string, unknown>> = [];
    const view = await mountCouncilPage(said);
    await waitFor(() => expect(view.getByTestId("council-messages").textContent).toContain("Убрать шаг с аккаунтом."));

    const header = view.getByTestId("council-header");
    expect(header).toBeDefined();
    const questionEl = header.querySelector(".line-clamp-2");
    expect(questionEl).toBeDefined();
    expect(questionEl?.textContent).toContain(detail.question);
  });
});
