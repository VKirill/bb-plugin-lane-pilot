import { describe, expect, it } from "vitest";
import { chromeIsCompact, contentStacksControls, CONTENT_STACK_MAX, SHELL_COMPACT_MAX } from "../src/ui/panel-layout";

describe("panel-width chrome", () => {
  it("uses the mobile Select at 448px plugin area (viewport 768 minus BB sidebar 320)", () => {
    expect(SHELL_COMPACT_MAX).toBe(448);
    expect(chromeIsCompact(448)).toBe(true);
    expect(chromeIsCompact(320)).toBe(true);
    expect(chromeIsCompact(0)).toBe(false);
    expect(chromeIsCompact(449)).toBe(false);
    expect(chromeIsCompact(768)).toBe(false);
  });

  it("stacks controls when the form column is 200–350px leftover after rail", () => {
    expect(CONTENT_STACK_MAX).toBe(350);
    expect(contentStacksControls(200)).toBe(true);
    expect(contentStacksControls(350)).toBe(true);
    expect(contentStacksControls(351)).toBe(false);
    expect(contentStacksControls(0)).toBe(false);
  });
});
