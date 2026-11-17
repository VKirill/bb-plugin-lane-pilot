import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chain, runHomeWorld } from "../workflow/run-home-world";

const TRACK = chain({
  inputs: [{ name: "phase_id", type: "string" }, { name: "pr_url", type: "string" }],
  outputs: [{ name: "marked", type: "boolean" }, { name: "path", type: "string" }],
  nodes: [
    { id: "state_mark", type: "action", action: "lp.ship_state_mark", params: { phase_id: "{{$inputs.phase_id}}", pr_url: "{{$inputs.pr_url}}" }, out: { marked: "bool", path: "string" } },
    { id: "done", type: "action", action: "emit", map: { marked: "state_mark.marked", path: "state_mark.path" } },
  ],
  edges: [{ from: "start", to: "state_mark" }, { from: "state_mark", to: "done" }],
});

describe("ship state mark", () => {
  it("[sma:k_ws_track] persists the shipped state in the registered handler and preserves a person's text", async () => {
    const world = await runHomeWorld();
    const path = ".agents/planning/STATE.md";
    const before = `---\nphase: "old-phase"\nstatus: "active"\n---\n# Planning\n\n## Notes\n\n- keep this person's note\n`;
    mkdirSync(join(world.checkout, ".agents/planning"), { recursive: true });
    writeFileSync(join(world.checkout, path), before);
    try {
      const result = await world.start(TRACK, { phase_id: "phase-7", pr_url: "https://git.example/pr/7" }).done;
      expect(result.status, result.error ?? undefined).toBe("succeeded");
      expect(result.output).toMatchObject({ marked: true, path });
      const after = readFileSync(join(world.checkout, path), "utf8");
      expect(after).toMatch(/^---\nphase: "phase-7"\nstatus: "shipped"\nupdated: "\d{4}-\d{2}-\d{2}"\n---\n/);
      expect(after).toMatch(/## Session\n- activity .* — shipped phase-7 https:\/\/git\.example\/pr\/7/);
      expect(after).toContain("# Planning\n\n## Notes\n\n- keep this person's note\n");
    } finally {
      world.dispose();
    }
  });
});
