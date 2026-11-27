import { describe, expect, it } from "vitest";
import { parseLpSignal } from "@lane-pilot/ui-kit/realtime-channel";

describe("the workflow draft realtime signal", () => {
  it("carries the draft id on the signal and drops a malformed one", () => {
    expect(parseLpSignal({ kind: "workflow-draft", draftId: "wfd_1", threadId: "thr_1" })).toEqual({ kind: "workflow-draft", threadId: "thr_1", draftId: "wfd_1" });
    expect(parseLpSignal({ kind: "workflow-draft", draftId: 7 })).toEqual({ kind: "workflow-draft" });
    expect(parseLpSignal({ kind: "workflows" })).toBeNull();
  });
});
