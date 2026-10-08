import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/contracts";
import { providerForwardsAgentOnly, writerBriefInput, writerBriefSegments, writerPrompt } from "../src/server/writer-task";

const task = taskV2Schema.parse({
  schema_version: 2, id: "t-1", title: "Add the footer", risk: "low", lane: "ui", project_cwd: "/work/p",
  read_first: ["src/a.ts"], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/footer.ts"], owns_paths: ["src/footer.ts"],
  never_touch: [], depends_on: [], objective: "Add a footer", acceptance: ["it renders"], verify: "tests", verification: [{ command: "npm test", cwd: "/work/p" }],
});
const args = [task, "NOTE-MEMORY", "PACKET-FILES", undefined, "Lane Pilot writer", "", "- RULE-ONE"] as const;

describe("writer brief as BB input parts", () => {
  it("is the same text as before, only cut into pieces", () => {
    expect(writerBriefSegments(...args).map((segment) => segment.text).join("\n\n")).toBe(writerPrompt(...args));
  });

  it("keeps the task header and the contract visible and hides the memory, rules and execution packet", () => {
    const parts = writerBriefInput(task, writerBriefSegments(...args), "claude-code");
    expect(parts[0]).toEqual({ type: "text", text: "Lane Pilot task t-1: Add the footer", mentions: [] });
    const visible = parts.filter((part) => !part.visibility).map((part) => part.text).join("\n");
    const hidden = parts.filter((part) => part.visibility === "agent-only").map((part) => part.text).join("\n");
    expect(visible).toContain("Task contract:");
    expect(visible).toContain("src/footer.ts");
    for (const secret of ["NOTE-MEMORY", "PACKET-FILES", "RULE-ONE"]) {
      expect(hidden).toContain(secret);
      expect(visible).not.toContain(secret);
    }
    // Nothing is lost on the way to the agent, and the order is the brief's own (bar the break that opens the visible contract).
    expect(parts.slice(1).map((part) => part.text.replace(/^\n\n/, "")).join("\n\n")).toBe(writerPrompt(...args));
    expect(parts.every((part) => part.type === "text" && Array.isArray(part.mentions))).toBe(true);
  });

  it("opens the visible contract with a line break, so the chat does not run the title into «Task contract:» (H4)", () => {
    for (const providerId of ["claude-code", "codex", "acp-opencode"]) {
      const parts = writerBriefInput(task, writerBriefSegments(...args), providerId);
      const visible = parts.filter((part) => !part.visibility);
      expect(visible[0]!.text).toBe("Lane Pilot task t-1: Add the footer");
      expect(visible[1]!.text.startsWith("\n\nTask contract:")).toBe(true);
      // What the chat shows: the title, a blank line, then the contract.
      expect(visible.map((part) => part.text).join("")).toMatch(/^Lane Pilot task t-1: Add the footer\n\nTask contract:/);
    }
  });

  it("never opens with an agent-only part (BB reads such a message as a seed)", () => {
    for (const providerId of ["claude-code", "codex", "acp-opencode"]) expect(writerBriefInput(task, writerBriefSegments(...args), providerId)[0]!.visibility).toBeUndefined();
  });

  it("sends the whole brief visible to a provider not known to forward agent-only parts", () => {
    expect(providerForwardsAgentOnly("acp-cursor")).toBe(true);
    const parts = writerBriefInput(task, writerBriefSegments(...args), "mystery-provider");
    expect(parts).toEqual([{ type: "text", text: writerPrompt(...args), mentions: [] }]);
  });
});
