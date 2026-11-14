import { describe, expect, it } from "vitest";
import type { PrototypeConfig } from "../src/rooms/contracts";
import { pmPrompt } from "../src/rooms/platform/server/pm-spawn";

const config = { writerWorkspacePath: "/tmp/project" } as PrototypeConfig;

const FORBIDDEN = /fixture|production write|demonstrate the guard|lane_pilot_dispatch_writer|lane_pilot_wait_writer|read probes/i;

describe("PM activation prompt", () => {
  it("non-native activation waits for real work and assigns nothing", () => {
    for (const managed of [false, true]) {
      const prompt = pmPrompt("lprun_1", config, managed, false);
      expect(prompt).toContain("lprun_1");
      expect(prompt).toContain("/tmp/project");
      expect(prompt).toMatch(/Wait for the task/i);
      expect(prompt).not.toMatch(FORBIDDEN);
    }
  });

  it("keeps the workspace binding lines distinct", () => {
    expect(pmPrompt("lprun_1", config, false, false)).toContain("The project workspace is /tmp/project.");
    expect(pmPrompt("lprun_1", config, true, false)).toContain("BB-managed worktree");
    expect(pmPrompt("lprun_1", config, true, false)).not.toContain("The project workspace is");
  });

  it("keeps the native prompt free of write probes and fixture work", () => {
    const prompt = pmPrompt("lprun_1", config, false, true);
    expect(prompt).toContain("in the selected role");
    expect(prompt).toMatch(/Wait for the user's task/i);
    expect(prompt).not.toMatch(FORBIDDEN);
  });
});
