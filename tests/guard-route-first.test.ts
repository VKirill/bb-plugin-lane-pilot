import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hookEnv } from "./hook-env";

// thr_n6ukbhcv9t, 2026-10-09: the PM searched the web for «discussed posts» instead of starting insights-post.
const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const owner = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const route = { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__bb-bridge__lane_pilot_route", input: {} }] } };
const result = { type: "user", message: { content: [{ type: "tool_result", content: "no workflow fits" }] } };

function verdict(tool: string, input: Record<string, unknown>, lines: unknown[] | null, agentType = "lane-pilot-pm") {
  let transcript = "/nonexistent/transcript.jsonl";
  if (lines) {
    transcript = join(mkdtempSync(join(tmpdir(), "route-first-")), "t.jsonl");
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));
  }
  const res = spawnSync("python3", [guard], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, agent_type: agentType, transcript_path: transcript, cwd: "/tmp" }),
    encoding: "utf8", env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
  });
  return res.stdout.includes("lane_pilot_route with the owner's request first") ? "deny" : "allow";
}

it("refuses the PM a web search or tavily before lane_pilot_route in the turn, and says what to do", () => {
  expect(verdict("WebSearch", { query: "vibe coding" }, [owner("найди обсуждаемые посты")])).toBe("deny");
  expect(verdict("WebFetch", { url: "https://x" }, [owner("найди")])).toBe("deny");
  expect(verdict("mcp__bb-bridge__lane_pilot_helpers", { action: "specialist", role: "tavily" }, [owner("найди")])).toBe("deny");
  // A route in an earlier turn does not count for the next owner message.
  expect(verdict("WebSearch", {}, [owner("a"), route, result, owner("b")])).toBe("deny");
});

it("allows the search once the router answered, other specialists and roles, and an unreadable transcript", () => {
  expect(verdict("WebSearch", {}, [owner("найди"), route, result])).toBe("allow");
  expect(verdict("mcp__bb-bridge__lane_pilot_helpers", { action: "specialist", role: "copy-lead" }, [owner("найди")])).toBe("allow");
  expect(verdict("WebSearch", {}, [owner("найди")], "errand")).toBe("allow");
  expect(verdict("WebSearch", {}, null)).toBe("allow");
});
