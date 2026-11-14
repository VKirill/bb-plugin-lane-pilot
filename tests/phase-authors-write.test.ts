import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The planner writes PLAN.md and .agents/plans/, the analyst its phase's CONTEXT.md (workflow-agent.ts PHASE_AUTHORS):
// the helper write guard must not deny them, or every phase stops at its first document.
describe("phase authors stay outside the helper write guard", () => {
  for (const file of ["lane-stack/hooks/guard_shell.py", "src/rooms/contracts/native-hook-sources.ts"]) {
    it(file, () => {
      const text = readFileSync(file, "utf8");
      const list = text.slice(text.indexOf("LANE_PILOT_HELPER_ROLES = {"), text.indexOf("}", text.indexOf("LANE_PILOT_HELPER_ROLES = {")));
      expect(list).toContain("auditor");
      expect(list).not.toMatch(/\\?"planner\\?"/);
      expect(list).not.toMatch(/\\?"analyst\\?"/);
    });
  }
});
