import { describe, expect, it } from "vitest";
import { errandCheck, errandVerdict } from "../src/rooms/qa/server/errands";
import { errandOutcome } from "../src/rooms/contracts/server";

const report = (...lines: string[]) => lines.join("\n");
const check = (text: string) => errandCheck(text, errandVerdict(text).state);

describe("errandCheck: a done is checked only when the helper says what it ran and what it showed", () => {
  it("reads CHECK lines with → and ->, also inside a code fence or a list, and makes the done checked", () => {
    const out = check(report("Sent.", "- CHECK: tg read @lyorqa --last 1 → message 977889 with the file", "```", "CHECK: curl -sI https://x.ru -> HTTP/2 200", "```", "ERRAND: done"));
    expect(out.verified).toBe("done_checked");
    expect(out.checks).toEqual([{ claim: "tg read @lyorqa --last 1", evidence: "message 977889 with the file" }, { claim: "curl -sI https://x.ru", evidence: "HTTP/2 200" }]);
  });

  it("calls a done without a usable CHECK line unchecked: none at all, an empty one, one without what it showed", () => {
    expect(check(report("All good.", "ERRAND: done")).verified).toBe("done_unchecked");
    expect(check(report("CHECK:", "ERRAND: done")).verified).toBe("done_unchecked");
    expect(check(report("CHECK: looked at the page →", "ERRAND: done")).verified).toBe("done_unchecked");
    expect(check(report("CHECK: looked at the page and it was fine", "ERRAND: done")).verified).toBe("done_unchecked");
  });

  it("leaves blocked blocked, with or without checks, and keeps the «blocked without a reason» rule", () => {
    expect(check(report("CHECK: login page → asks for a code", "ERRAND: blocked: needs the SMS code")).verified).toBe("blocked");
    expect(errandVerdict("ERRAND: blocked")).toEqual({ state: "blocked", reason: "blocked without a reason" });
  });
});

describe("errandOutcome carries what the code saw", () => {
  it("reads verified from a finished run's output, and is unknown for an old run, a running, a failed and a canceled one", () => {
    expect(errandOutcome("succeeded", { state: "done", verified: "done_checked" }, null)).toMatchObject({ outcome: "done", verified: "done_checked" });
    expect(errandOutcome("succeeded", { state: "done" }, null)).toMatchObject({ outcome: "done", verified: "unknown" });
    expect(errandOutcome("running", null, null).verified).toBe("unknown");
    expect(errandOutcome("failed", { verified: "done_checked" }, "step_failed:work").verified).toBe("unknown");
    expect(errandOutcome("canceled", null, null).verified).toBe("unknown");
    expect(errandOutcome("succeeded", { state: "done", verified: "whatever" }, null).verified).toBe("unknown");
  });
});
