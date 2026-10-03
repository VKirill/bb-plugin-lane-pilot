import { expect, it } from "vitest";
import bundledAgents from "../src/bundled-agents.json";
import { buildCapabilityRegistry, chooseRecipient, describeRegistry } from "@lane-pilot/handoff";
import { BB_AGENT_SESSIONS, LANE_PILOT_PM_SESSION, laneSessionOverlayPrompt } from "../src/native-agent-overlay";
import { bundledAgentDefinitions } from "../src/server/handoff";

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
    expect(agent.prompt).toBe(laneSessionOverlayPrompt(id));
  }
});

it("describes every handoff recipient by what it does, not by its header line", () => {
  const registry = buildCapabilityRegistry(bundledAgentDefinitions());
  const text = describeRegistry(registry);
  expect(text).not.toMatch(/: You are \*\*/);
  expect(text).toMatch(/copy-lead \([^)]*\): Copywriter: headlines \(H1\)/);
  expect(chooseRecipient(registry, "rewrite the H1 and the landing headlines")?.agentId).toBe("copy-lead");
});
