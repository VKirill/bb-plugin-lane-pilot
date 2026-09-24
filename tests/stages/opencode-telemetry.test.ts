import { describe, expect, it } from "vitest";
import { parseOpenCodeToolTelemetry } from "../../src/stages/opencode-telemetry";

describe("OpenCode tool telemetry adapter", () => {
  it("correlates only the requested session, deduplicates by source-line hash, and drops tool arguments/output", () => {
    const event = JSON.stringify({
      t: 1790200000, src: "tool.execute.after", mod: "budget", ok: true,
      data: { tool: "read", chars: 381, dup: false, n: 1, fp: "d7a091", args: { path: "/private/example" }, output: "private content" },
      task: "TASK.md", session: "opencode-session-1",
    });
    const otherSession = JSON.stringify({ t: 1790200001, mod: "budget", ok: true,
      data: { tool: "bash", chars: 2, dup: false, n: 2, fp: "9a" }, session: "another-session" });
    const otherEvent = JSON.stringify({ t: 1790200002, mod: "model", ok: true, data: { tool: "read" }, session: "opencode-session-1" });
    const otherTask = JSON.stringify({ t: 1790200003, mod: "budget", ok: true,
      data: { tool: "read", chars: 1, dup: false, n: 1, fp: "t1" }, task: "OTHER.yml", session: "opencode-session-1" });
    const result = parseOpenCodeToolTelemetry([event, event, otherSession, otherEvent, otherTask, "{broken"].join("\n"), "opencode-session-1", "TASK.md");

    expect(result.lineCount).toBe(6);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ timestamp: 1790200000, source: "tool.execute.after", tool: "read", succeeded: true, chars: 381, duplicate: false, invocation: 1, fingerprint: "d7a091" });
    expect(result.events[0]).not.toHaveProperty("args");
    expect(result.events[0]).not.toHaveProperty("output");
    expect(result.unmatchedSessions).toBe(1);
    expect(result.unmatchedTasks).toBe(1);
    expect(result.otherEvents).toBe(1);
    expect(result.duplicateLines).toBe(1);
    expect(result.malformedLines).toBe(1);
  });

  it("fails closed on an invalid or oversized correlation request", () => {
    expect(() => parseOpenCodeToolTelemetry("{}", " ", "TASK.md")).toThrow("telemetry_session_id_invalid");
    expect(() => parseOpenCodeToolTelemetry("{}", "session", "../TASK.md")).toThrow("telemetry_task_file_invalid");
    expect(() => parseOpenCodeToolTelemetry("x".repeat(256 * 1024 + 1), "session", "TASK.md")).toThrow("telemetry_log_exceeds_262144_bytes");
  });
});
