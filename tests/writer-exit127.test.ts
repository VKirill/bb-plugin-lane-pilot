import { describe, expect, it } from "vitest";
import { previousAttemptBrief } from "../src/rooms/writer/server/writer-task";

describe("a check the sandbox could not run", () => {
  it("tells the writer that exit 127 is the check environment, not its code (Vampirism Fire, 2026-10-23)", () => {
    const last = { status: "validation_failed", reason: "verification failed (cd game && scripts/check.sh): exit 127",
      verification: [{ command: "cd game && scripts/check.sh", exitCode: 127, stdout: "", stderr: "scripts/check.sh: line 51: stylua: command not found" }] };
    const brief = previousAttemptBrief(last, { owns_paths: ["game/src/**"] });
    expect(brief).toMatch(/could not find a program the check calls: that is the check environment, not your code/);
    expect(brief).toMatch(/NEEDS_HUMAN: cd game && scripts\/check.sh cannot find <program>/);
  });

  it("says nothing of the kind for an ordinary failing check", () => {
    const last = { status: "validation_failed", reason: "verification failed (npm test): exit 1",
      verification: [{ command: "npm test", exitCode: 1, stdout: "1 failed", stderr: "" }] };
    expect(previousAttemptBrief(last, { owns_paths: ["src/**"] })).not.toMatch(/check environment/);
  });
});
