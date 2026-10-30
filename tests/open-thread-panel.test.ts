import { describe, expect, it } from "vitest";
import { openThreadPanelTab } from "../src/rooms/ui-shell/ui";

describe("openThreadPanelTab", () => {
  const options = { actionId: "lane-helper-thread", title: "Helper", params: { threadId: "t1" } };

  it("opens the action tab through the panel controller when openTab is there", () => {
    const calls: unknown[] = [];
    const opened = openThreadPanelTab(
      { openTab: (tab) => { calls.push(tab); return true; } },
      { openThreadPanel: () => { throw new Error("retired path must not run"); } },
      options,
    );
    expect(opened).toBe(true);
    expect(calls).toEqual([{ tab: { id: "lane-helper-thread", context: { kind: "thread" }, availability: "action" }, params: { threadId: "t1" }, title: "Helper" }]);
  });

  it("uses the retired navigate.openThreadPanel on a BB without openTab", () => {
    const calls: unknown[] = [];
    const opened = openThreadPanelTab(
      { openFixedTab: () => true } as never,
      { openThreadPanel: (o) => { calls.push(o); return true; } },
      options,
    );
    expect(opened).toBe(true);
    expect(calls).toEqual([options]);
  });

  it("reports a declined openTab and does not fall through to the retired call", () => {
    const legacy: string[] = [];
    const opened = openThreadPanelTab(
      { openTab: () => false },
      { openThreadPanel: () => { legacy.push("called"); return true; } },
      options,
    );
    expect(opened).toBe(false);
    expect(legacy).toEqual([]);
  });

  it("reports false when neither API can open", () => {
    expect(openThreadPanelTab(undefined, {}, options)).toBe(false);
  });
});
