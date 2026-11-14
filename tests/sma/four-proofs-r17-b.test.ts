// Region 17 · Agent roles (subagents), batch b (n1400, n1401): the foreground rule of a subagent call, run through the real session hook as a program,
// and what a role is given before it is spawned: its skills and its model.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleDefaultModel } from "@lane-pilot/models";
import { ROLE_PROFILES, effectiveGroup } from "../../src/rooms/contracts/helper-context";
import { resolveSpawnModel } from "../../src/rooms/platform/server/spawn-model";

const HOOK = join(__dirname, "../../src/rooms/session-hooks/cli.ts");
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const DENY = "[subagent-foreground] in a lane session a subagent runs in the foreground: call it again without run_in_background.";

/** The real PreToolUse hook on one Task call of a session with a given role. */
function task(home: string, cwd: string, role: string, session: string, input: Record<string, unknown>) {
  const ran = spawnSync(process.execPath, ["--experimental-strip-types", HOOK], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: session, cwd, tool_name: "Task", tool_input: input }), encoding: "utf8",
    env: { ...process.env, HOME: home, LANE_PILOT_ROLE: role, BB_CLI: "/nonexistent-bb" },
  });
  const out = ran.stdout.trim() ? JSON.parse(ran.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } : {};
  return { status: ran.status, decision: out.hookSpecificOutput?.permissionDecision, reason: out.hookSpecificOutput?.permissionDecisionReason };
}
const spawned = (home: string, session: string) => {
  const file = join(home, ".lane-pilot/session-hooks", session, "spawned.txt");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
};

describe("region 17 batch b", () => {
  it("[sma:k_ag_foreground] a subagent call with run_in_background is refused with the foreground reason for the PM and the writer and is not counted; the same call in the foreground is let through and counted", () => {
    const home = tmp("r17b-fg-");
    const cwd = tmp("r17b-fg-cwd-");
    for (const role of ["pm", "writer"]) {
      const session = `bg-${role}`;
      const refused = task(home, cwd, role, session, { subagent_type: "Explore", prompt: "map the code", run_in_background: true });
      expect(refused).toEqual({ status: 0, decision: "deny", reason: DENY });
      expect(spawned(home, session)).toBeNull();
      const rows = readFileSync(join(home, ".lane-pilot/session-hooks", session, "subagents.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { deny: string | null });
      expect(rows.map((row) => row.deny)).toEqual([DENY]);
      // Without the flag, or with it false, the same call is not refused and the count moves by one.
      const fg = task(home, cwd, role, session, { subagent_type: "Explore", prompt: "map the code" });
      expect(fg.decision).not.toBe("deny");
      expect(spawned(home, session)).toBe("1");
      expect(task(home, cwd, role, session, { subagent_type: "Explore", prompt: "again", run_in_background: false }).decision).not.toBe("deny");
      expect(spawned(home, session)).toBe("2");
    }
  }, 60_000);

  it("[sma:k_ag_resolve] before a role is spawned its skills come from its profile (an owner's list wins) and its model from the role table (a pin wins)", () => {
    const skills = (role: Parameters<typeof effectiveGroup>[0]) => effectiveGroup(role, "skills");
    expect(skills("writer")).toEqual({ names: ["lp-writer", "karpathy-guidelines"], source: "role" });
    expect(skills("docs-maintainer")).toEqual({ names: ["lp-docs", "docs-methodology"], source: "role" });
    expect(skills("browser-qa")).toEqual({ names: ["browser-automation"], source: "role" });
    expect(skills("specialist:tavily")).toEqual({ names: ["env-catalog", "tavily"], source: "role" });
    expect(skills("plan-critic")).toEqual({ names: [], source: "role" });
    expect(effectiveGroup("writer", "skills", { skills: { mode: "allow", names: ["only-this"] } })).toEqual({ names: ["only-this"], source: "owner" });
    expect(effectiveGroup("writer", "skills", { skills: { mode: "all" } })).toEqual({ names: null, source: "owner" });
    expect(ROLE_PROFILES.writer.skills).toEqual(["lp-writer", "karpathy-guidelines"]);
    // The model: each role takes its own row of the table; a pin overrides the row and says so.
    const model = (role: string, over: Record<string, unknown> = {}) => resolveSpawnModel({ role, settings: {}, pm: null, catalog: null, ...over } as never);
    for (const role of ["writer", "docs-maintainer", "plan-critic"] as const) {
      const row = roleDefaultModel(role as never);
      expect(model(role)).toMatchObject({ providerId: row.providerId, model: row.model, reasoningEffort: row.effort, source: "role-default" });
    }
    expect(model("writer").model).not.toBe(model("plan-critic").model);
    expect(model("docs-maintainer", { pinned: { provider: "codex", model: "gpt-x" } })).toMatchObject({ providerId: "codex", model: "gpt-x", source: "pinned" });
  });
});
