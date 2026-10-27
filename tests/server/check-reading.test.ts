import { describe, expect, it } from "vitest";
import { readCheckRun } from "../../src/rooms/tasks/server/check-reading";

// One reading for the writer's check, the replay, the post-merge check and the integration gate (Astra's recheck of 0.1.336, P1).
describe("readCheckRun", () => {
  const studioDown = "studio_test error: Unable to reach Roblox Studio right now.";

  it("pass: exit 0 that ran a test, or output that is no runner's", () => {
    expect(readCheckRun({ exitCode: 0, stdout: "19 checks, 0 failed" }).verdict).toBe("pass");
    expect(readCheckRun({ exitCode: 0, stdout: "built in 2s" }).verdict).toBe("pass");
  });

  it("product_fail: a non-zero exit that does not blame the machine, timeouts included", () => {
    expect(readCheckRun({ exitCode: 1, stdout: "19 checks, 1 failed", stderr: "AssertionError: incorrect damage" }).verdict).toBe("product_fail");
    expect(readCheckRun({ exitCode: 124, stderr: "verification timed out after 90s" }).verdict).toBe("product_fail");
  });

  it("environment_error: the machine broke it, the host failed, or the call threw", () => {
    expect(readCheckRun({ exitCode: 1, stderr: studioDown }).verdict).toBe("environment_error");
    expect(readCheckRun({ exitCode: 1, stderr: "host offline", hostError: true }).verdict).toBe("environment_error");
    expect(readCheckRun({ exitCode: 1, stderr: "sandbox_backend_unavailable", threw: true }).verdict).toBe("environment_error");
  });

  it("not_run: exit 0 with no test run, a hollow re-run, and the red failIfNoTestRan already wrote", () => {
    expect(readCheckRun({ exitCode: 0, stdout: "0 checks, 0 failed" }).verdict).toBe("not_run");
    expect(readCheckRun({ exitCode: 0, stdout: "3 checks, 0 failed\n0 checks, 0 failed" }, { command: "python3 a_test.py && python3 b_test.py" }).verdict).toBe("not_run");
    const first = { stdout: "FAIL x\n19 checks, 1 failed" };
    expect(readCheckRun({ exitCode: 0, stdout: "python3: error: couldn't create cache file '/x' (errno=Operation not permitted)" }, { first }).verdict).toBe("not_run");
    expect(readCheckRun({ exitCode: 0, stdout: "19 checks, 0 failed" }, { first }).verdict).toBe("pass");
    expect(readCheckRun({ exitCode: 1, stderr: "check failed: the check exited 0 but ran no test: 4 skipped (vitest)" }).verdict).toBe("not_run");
  });
});
