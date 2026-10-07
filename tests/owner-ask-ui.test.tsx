/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { buildOwnerAskPayload } from "../src/owner-ask";

afterEach(() => cleanup());

async function mount(payload: unknown) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.pendingInteractions.find((row) => row.id === "lane-pilot-ask");
  if (!registration) throw new Error("the owner question renderer is not registered");
  const submitted: unknown[] = [];
  let cancelled = 0;
  const view = await renderSlot({ component: registration.component }, {
    interaction: { id: "int_1", threadId: "thr_pm", title: "t", payload: payload as never, createdAt: 1, expiresAt: null },
    submit: async (value: unknown) => { submitted.push(value); },
    cancel: async () => { cancelled += 1; },
  }, { context: { projectId: "proj_1", threadId: "thr_pm" } });
  return { view, submitted, cancelled: () => cancelled };
}

describe("the owner's question form (H8)", () => {
  it("shows the question, its context and the tappable answers; a tap submits the option", async () => {
    const { view, submitted } = await mount(buildOwnerAskPayload({ source: "gate", question: "Gate is red. What should the PM do?", detail: "log tail", options: ["Investigate", "Leave it"] }));
    expect(view.getByTestId("owner-ask-question").textContent).toBe("Gate is red. What should the PM do?");
    expect(view.getByTestId("owner-ask-detail").textContent).toContain("log tail");
    const options = view.getByTestId("owner-ask-options");
    fireEvent.click(Array.from(options.querySelectorAll("button")).find((button) => button.textContent === "Leave it")!);
    await waitFor(() => expect(submitted).toEqual([{ choice: "2" }]));
    view.lifecycle.unmount();
  });

  it("sends words of the owner's own, alone or with an option; Send needs text", async () => {
    const { view, submitted } = await mount(buildOwnerAskPayload({ source: "pm", question: "Which provider?", options: ["Stripe"] }));
    const send = Array.from(view.container.querySelectorAll("button")).find((button) => /Send|Отправить/.test(button.textContent ?? ""))! as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const field = view.container.querySelector("textarea")!;
    fireEvent.change(field, { target: { value: "  the cheaper one  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(submitted).toEqual([{ text: "the cheaper one" }]));
    fireEvent.click(Array.from(view.getByTestId("owner-ask-options").querySelectorAll("button"))[0]!);
    await waitFor(() => expect(submitted[1]).toEqual({ choice: "1", text: "the cheaper one" }));
    view.lifecycle.unmount();
  });

  it("can be dismissed, and a question without a free-text field offers only its options", async () => {
    const { view, cancelled } = await mount(buildOwnerAskPayload({ source: "repair", question: "Go ahead?", options: ["Yes", "No"], allowText: false }));
    expect(view.container.querySelector("textarea")).toBeNull();
    fireEvent.click(Array.from(view.container.querySelectorAll("button")).find((button) => /Not now|Не сейчас/.test(button.textContent ?? ""))!);
    await waitFor(() => expect(cancelled()).toBe(1));
    view.lifecycle.unmount();
  });

  it("says so, and can be dismissed, when the payload is not a Lane Pilot question", async () => {
    const { view, cancelled } = await mount({ nonsense: true });
    expect(view.getByTestId("owner-ask-broken")).toBeTruthy();
    fireEvent.click(view.container.querySelector("button")!);
    await waitFor(() => expect(cancelled()).toBe(1));
    view.lifecycle.unmount();
  });
});
