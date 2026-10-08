import { expect, it } from "vitest";
import bundledAgents from "../src/rooms/native-agent/bundled-agents.json";
import { buildCapabilityRegistry, chooseRecipient, describeRegistry } from "@lane-pilot/handoff";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION, laneSessionOverlayPrompt } from "../src/rooms/native-agent/native-agent-overlay";
import { bundledAgentDefinitions } from "../src/rooms/relay/server/handoff";
import { SESSION_MAX_MS, SESSION_MAX_TURNS } from "../src/rooms/runs/failure-class";
import { LIVE_FOLDER_FILE_CAP } from "../src/rooms/writer/live-folder";
import { STICKY_WINDOW_MS } from "../src/rooms/writer/server/sticky";

it("defines shipping as push, bring the project up its own way, and prove it is live", () => {
  const ship = LANE_PILOT_PM_SESSION.split("## Ship")[1]!.split("## Docs")[0]!;
  expect(ship).toContain("git push origin");
  expect(ship).toContain("the guard refuses a force-push");
  expect(ship).toMatch(/docker compose/);
  expect(ship).toMatch(/systemd/);
  expect(ship).toMatch(/healthcheck/);
  expect(ship).toMatch(/no way to run it/);
});

it("gives the PM a done criterion and no route to agents it cannot spawn", () => {
  expect(LANE_PILOT_PM_SESSION).toMatch(/## Done\nCode work: every task accepted, main pushed/);
  expect(LANE_PILOT_PM_SESSION).not.toMatch(/run-supervisor|lane-supervisor|night-reviewer/);
  expect(LANE_PILOT_PM_SESSION).toMatch(/shell redirects into project files/);
});

it("states the docs rule once, with its reason, in every session that must not write docs", () => {
  for (const id of ["copy-lead", "seo-specialist", "design-lead", "project-onboarder", "browser-qa"]) {
    expect(BB_AGENT_SESSIONS[id]).toContain("reverts other edits there");
  }
  expect(LANE_PILOT_PM_SESSION).toContain("reverts other edits there");
});

it("keeps the bundled copy byte-identical to the overlay", () => {
  for (const [id, agent] of Object.entries(bundledAgents as Record<string, { prompt: string }>)) {
    const overlay = laneSessionOverlayPrompt(id);
    // The PM too: an older 11.5 KB copy used to sit in the JSON next to the live prompt (instructions audit 2, 2026-10-08).
    // Fix a failure with `node_modules/.bin/tsx scripts/sync-bundled-prompts.ts`.
    expect(overlay, id).not.toBe("");
    expect(agent.prompt, id).toBe(overlay);
  }
});

it("tells the PM to retry a tool only when retryable is true and sideEffects is none", () => {
  expect(LANE_PILOT_PM_SESSION).toContain("{ok:false,error:{code,retryable,sideEffects}}");
  expect(LANE_PILOT_PM_SESSION).toContain("retry only when retryable is true and sideEffects is \"none\"");
});

it("describes every handoff recipient by what it does, not by its header line", () => {
  const registry = buildCapabilityRegistry(bundledAgentDefinitions());
  const text = describeRegistry(registry);
  expect(text).not.toMatch(/: You are \*\*/);
  expect(text).toMatch(/copy-lead \([^)]*\): Copywriter: headlines \(H1\)/);
  expect(chooseRecipient(registry, "rewrite the H1 and the landing headlines")?.agentId).toBe("copy-lead");
});

// Instructions audit 2026-10-08: numbers the PM prompt states about the writer are code constants; a copy in prose drifts when one changes.
it("states the writer limits the code enforces", () => {
  expect(LANE_PILOT_PM_SESSION).toContain(`at most ${SESSION_MAX_TURNS} turns or ${SESSION_MAX_MS / 60_000} minutes`);
  expect(LANE_PILOT_PM_SESSION).toContain(`for ${STICKY_WINDOW_MS / 3_600_000 === 3 ? "three" : "?"} hours after its last accepted task`);
  expect(LANE_PILOT_PM_SESSION).toContain(`over ${String(LIVE_FOLDER_FILE_CAP).replace(/(\d)(?=(\d{3})$)/, "$1 ")} files`);
});
