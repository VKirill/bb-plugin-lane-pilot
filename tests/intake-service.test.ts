import { describe, expect, it } from "vitest";
import { intakeByRules, isMachineMessage } from "../src/rooms/phase/intake";

describe("intake service request", () => {
  it("a plain cancel line is a service request with its sub-kind", () => {
    expect(intakeByRules("отмени задачу X")).toEqual({ kind: "service", confident: true, service: "cancel" });
  });
  it("system frames and other threads' messages are never the owner's request", () => {
    expect(isMachineMessage("[system] thread started")).toBe(true);
    expect(isMachineMessage("[bb message from thread:thr_x] cancel task")).toBe(true);
    expect(isMachineMessage("Workflow run wfrun_1 of foo ended")).toBe(true);
    expect(isMachineMessage("отмени задачу X")).toBe(false);
  });
});
