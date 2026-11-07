import { describe, expect, it, afterEach } from "vitest";
import { roleSpec } from "../src/rooms/workflow/server/workflow-agent";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { agentPickerLabel } from "../src/rooms/native-agent/agent-display";
import { MAIN_AGENT_PROFILE_IDS } from "../src/rooms/contracts/server";
import { compileMainAgentProfile } from "../src/rooms/native-agent/agent-profile";
import { BB_AGENT_SUMMARIES } from "../src/rooms/contracts/server";
import { laneSessionOverlayPrompt, overlaySessionTools } from "../src/rooms/native-agent/native-agent-overlay";
import { NATIVE_LP_BRIDGE_LEAD_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { LEAD_ID, LEAD_LAUNCH, LEAD_SESSION, LEAD_TICK } from "../src/rooms/contracts/lead-agent";
import {BUILTIN_SOURCES} from "../src/rooms/workflow/builtin";

afterEach(() => setLocaleOverride(null));

describe("the lead («Штурман») profile", () => {
  it("is a selectable main agent next to the architect, named in English and Russian", () => {
    expect(MAIN_AGENT_PROFILE_IDS).toContain(LEAD_ID);
    const profile = compileMainAgentProfile(LEAD_ID);
    expect(profile.description).toBe("Shturman (the lead)");
    setLocaleOverride("en");
    expect(agentPickerLabel({ id: LEAD_ID, description: profile.description }, t)).toBe("Shturman (the lead)");
    setLocaleOverride("ru");
    expect(agentPickerLabel({ id: LEAD_ID, description: profile.description }, t)).toBe("Штурман");
    expect(agentPickerLabel({ id: LEAD_ID, description: "Lane Pilot lead" }, t)).toBe("Штурман");
    expect(BB_AGENT_SUMMARIES[LEAD_ID]).toContain("road tree");
    expect(LEAD_LAUNCH).toMatchObject({ agentId: LEAD_ID, rpc: "lead_chat_start" });
  });

  it("keeps the road and the journal and nothing else: reading, the web and lane_pilot_lead; no write, no dispatch, no schedule", () => {
    const profile = compileMainAgentProfile(LEAD_ID);
    const tools = profile.tools ?? [];
    expect(tools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "mcp__bb-bridge__lane_pilot_lead", "mcp__bb-bridge__lane_pilot_read"]));
    for (const forbidden of ["Write", "Edit", "Bash", "mcp__bb-bridge__lane_pilot_dispatch_writer", "mcp__bb-bridge__lane_pilot_schedule", "mcp__bb-bridge__lane_pilot_errand", "mcp__bb-bridge__lane_pilot_browser", "mcp__bb-bridge__lane_pilot_workflow_draft"]) expect(tools).not.toContain(forbidden);
    expect(tools.filter((tool) => tool.startsWith("mcp__bb-bridge__lane_pilot_")).map((tool) => tool.replace("mcp__bb-bridge__", "")).sort()).toEqual([...NATIVE_LP_BRIDGE_LEAD_TOOLS].sort());
    // A saved definition that lists other bridge tools gets exactly the lead's.
    expect(overlaySessionTools(LEAD_ID, ["Read", "mcp__bb-bridge__lane_pilot_dispatch_writer", "mcp__bb-bridge__lane_pilot_schedule"])).not.toContain("mcp__bb-bridge__lane_pilot_dispatch_writer");
    expect(overlaySessionTools(LEAD_ID, ["Read"])).toContain("mcp__bb-bridge__lane_pilot_lead");
    expect(profile.prompt).toBe(laneSessionOverlayPrompt(LEAD_ID));
    expect(profile.prompt).toContain(LEAD_SESSION);
  });

  it("says in its session what it never does and where the identity comes from; its tick graph ships with the plugin", () => {
    for (const line of ["<lead_identity>", "LEAD.md on the hub", "Write code, dispatch writers", "no sentence in a chat", "write to PM chats"]) expect(LEAD_SESSION).toContain(line);
    expect(LEAD_SESSION.length).toBeLessThanOrEqual(2_000); // tests/prompt-budget.test.ts: every non-PM overlay
    expect(BUILTIN_SOURCES.map((source) => source.name)).toContain(`${LEAD_TICK}.json`);
  });
});

describe("the lead's own sessions are read-only (roadmap WP4: isolation)", () => {
  it("the tick's role edits nothing of a repository: only the chat's own storage; the same for the specialist spelling", () => {
    for (const role of ["lead", "specialist:lead"]) {
      const spec = roleSpec(role);
      expect(spec).toMatchObject({ readOnly: true, specialist: "lead", metadata: "lead" });
      expect(spec.editable("src/index.ts")).toBe(false);
      expect(spec.editable(".agents/plans/road.md")).toBe(false);
      expect(spec.editable("LEAD.md")).toBe(false);
      expect(spec.editable(".bb/chats/thr_1/notes/a.md")).toBe(true);
    }
  });
});
