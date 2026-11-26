// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { FirstRunCard } from "../src/rooms/pages/ui/first-run";

afterEach(() => cleanup());

describe("FirstRunCard", () => {
  it("walks through the first-run interview RPCs and hides once finished", async () => {
    let stepIndex = 0;
    const steps = [
      { id: "goal", question: "Goal?" },
      { id: "writer", question: "Writer?" },
    ] as const;
    const answers: Record<string, string> = {};
    let done: number | undefined;
    const answerCalls: Array<{ projectId: string; step: string; answer: string }> = [];
    const finishCalls: Array<{ projectId: string }> = [];

    const rpc = {
      first_run_get: vi.fn(async () => ({
        needed: !done,
        steps,
        draft: { projectId: "proj_1", answers: { ...answers }, at: 1, ...(done ? { done } : {}) },
      })),
      first_run_answer: vi.fn(async (input: { projectId: string; step: string; answer: string }) => {
        answerCalls.push(input);
        answers[input.step] = input.answer;
        stepIndex += 1;
        return { projectId: input.projectId, answers: { ...answers }, at: 2 };
      }),
      first_run_finish: vi.fn(async (input: { projectId: string }) => {
        finishCalls.push(input);
        done = 3;
        return { written: ["writer.provider"], goal: true };
      }),
    };

    const rendered = renderSlot(
      { component: () => <FirstRunCard projectId="proj_1" /> } as never,
      {},
      { context: { projectId: "proj_1", threadId: null }, rpc: rpc as never },
    );

    await waitFor(() => expect(rendered.getByTestId("first-run-interview").textContent).toContain("Goal?"));

    fireEvent.change(rendered.getByTestId("first-run-answer-input"), { target: { value: "Build MVP" } });
    fireEvent.click(rendered.getByTestId("first-run-send"));
    await waitFor(() => expect(rendered.getByTestId("first-run-interview").textContent).toContain("Writer?"));
    expect(rendered.getByTestId("first-run-ready").textContent).toContain("goal: Build MVP");

    fireEvent.change(rendered.getByTestId("first-run-answer-input"), { target: { value: "codex / gpt-6-luna" } });
    fireEvent.click(rendered.getByTestId("first-run-send"));

    await waitFor(() => expect(rendered.getByTestId("first-run-finish")).toBeTruthy());
    fireEvent.click(rendered.getByTestId("first-run-finish"));

    await waitFor(() => expect(rendered.queryByTestId("first-run-card")).toBeNull());
    expect(stepIndex).toBe(2);
    expect(answerCalls).toEqual([
      { projectId: "proj_1", step: "goal", answer: "Build MVP" },
      { projectId: "proj_1", step: "writer", answer: "codex / gpt-6-luna" },
    ]);
    expect(finishCalls).toEqual([{ projectId: "proj_1" }]);
  });
});
