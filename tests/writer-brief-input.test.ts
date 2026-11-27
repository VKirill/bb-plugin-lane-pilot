import { describe, expect, it } from "vitest";
import { taskV2Schema } from "../src/rooms/contracts";
import { providerForwardsAgentOnly } from "@lane-pilot/models";
import { writerBriefInput, writerBriefSegments, stickyTurnPrompt } from "../src/rooms/writer/models/writer-task";
import { chatBriefSection } from "../src/rooms/brief";

const task = taskV2Schema.parse({
  schema_version: 2, id: "t-1", title: "Add the footer", risk: "low", lane: "ui", project_cwd: "/work/p",
  read_first: ["src/a.ts"], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/footer.ts"], owns_paths: ["src/footer.ts"],
  never_touch: [], depends_on: [], objective: "Add a footer", acceptance: ["it renders"], verify: "tests", verification: [{ command: "npm test", cwd: "/work/p" }],
});
const args = [task, "NOTE-MEMORY", "PACKET-FILES", undefined, "Lane Pilot writer"] as const;

describe("writer brief as BB input parts", () => {
  it("preserves unstructured heredoc checks in both the initial brief and a sticky resend", () => {
    const command = "cat <<'END'\nkey: literal\nverification_hidden_count: literal\n```\n- literal\nEND";
    const withCheck = taskV2Schema.parse({ ...task, verification: [{ command, cwd: task.project_cwd }] });
    const initial = writerBriefInput(withCheck, writerBriefSegments(withCheck), "codex").map((part) => part.text).join("\n");
    const sticky = stickyTurnPrompt({ kind: "next-task", task: withCheck });
    for (const text of [initial, sticky]) {
      expect(text).toContain(command);
      expect(text).not.toContain("**key:**");
      expect(text).toContain("````text\n");
    }
  });
  it("leaves literal content inside long backtick and tilde fences unchanged", () => {
    for (const fence of ["````", "~~~~"]) {
      const body = `${fence}text\n${fence.slice(1)}\nobjective: literal\nverification:\n- {\"command\":\"literal\"}\n${fence}`;
      expect(chatBriefSection(`<task_goal>\n${body}\n</task_goal>`)).toBe(`### Задача\n\n${body}`);
    }
  });
  it("keeps multiline commands, embedded fences and verification metadata intact", () => {
    const command = "python3 - <<'PY'\nprint('``` and <tag>')\nPY";
    const withCheck = taskV2Schema.parse({ ...task, verification: [{ command, cwd: "/work/p/tests", secrets: ["EXAMPLE_KEY"] }] });
    const text = writerBriefInput(withCheck, writerBriefSegments(withCheck), "codex").filter((part) => !part.visibility).map((part) => part.text).join("\n");
    expect(text).toContain(`\n${command}\n`);
    expect(text).toContain("````sh\n");
    expect(text).toContain('"EXAMPLE_KEY"');
    expect(text).toContain('"cwd": "/work/p/tests"');
    expect(text).toContain("**owns_paths:** src/footer.ts");
    expect(text).toContain("ASK_PM:");
  });
  it("keeps the task header and the contract visible and hides the memory and execution packet", () => {
    const parts = writerBriefInput(task, writerBriefSegments(...args), "claude-code");
    expect(parts[0]).toEqual({ type: "text", text: "## Lane Pilot task t-1: Add the footer", mentions: [] });
    const visible = parts.filter((part) => !part.visibility).map((part) => part.text).join("\n");
    const hidden = parts.filter((part) => part.visibility === "agent-only").map((part) => part.text).join("\n\n");
    expect(visible).toContain("### Задача");
    expect(visible).toContain("src/footer.ts");
    for (const secret of ["NOTE-MEMORY", "PACKET-FILES"]) {
      expect(hidden).toContain(secret);
      expect(visible).not.toContain(secret);
    }
    // Nothing is lost on the way to the agent, and the order is the brief's own (bar the break that opens the visible contract).
    expect(hidden).toBe(writerBriefSegments(...args).filter((segment) => segment.hidden).map((segment) => segment.text).join("\n\n"));
    for (const value of ["Add a footer", "it renders", "src/footer.ts", "npm test", "/work/p"]) expect(visible).toContain(value);
    expect(visible).not.toContain("<task_goal>");
    expect(visible).toContain("- npm test");
    expect(parts.every((part) => part.type === "text" && Array.isArray(part.mentions))).toBe(true);
  });

  it("opens the visible contract with a line break, so the chat does not run the title into the contract (H4)", () => {
    for (const providerId of ["claude-code", "codex", "opencode2", "acp-cursor"]) {
      const parts = writerBriefInput(task, writerBriefSegments(...args), providerId);
      const visible = parts.filter((part) => !part.visibility);
      expect(visible[0]!.text).toBe("## Lane Pilot task t-1: Add the footer");
      expect(visible[1]!.text.startsWith("\n\n### Задача")).toBe(true);
      // What the chat shows: the title, a blank line, then the contract.
      expect(visible.map((part) => part.text).join("")).toMatch(/^## Lane Pilot task t-1: Add the footer\n\n### Задача/);
    }
  });

  it("never opens with an agent-only part (BB reads such a message as a seed)", () => {
    for (const providerId of ["claude-code", "codex", "opencode2", "acp-cursor"]) expect(writerBriefInput(task, writerBriefSegments(...args), providerId)[0]!.visibility).toBeUndefined();
  });

  it("sends the whole brief visible to a provider not known to forward agent-only parts", () => {
    expect(providerForwardsAgentOnly("acp-cursor")).toBe(true);
    const parts = writerBriefInput(task, writerBriefSegments(...args), "mystery-provider");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.visibility).toBeUndefined();
    for (const value of ["### Задача", "NOTE-MEMORY", "PACKET-FILES", "ASK_PM:", "npm test"]) expect(parts[0]!.text).toContain(value);
  });
});

