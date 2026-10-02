import { describe, expect, it } from "vitest";
import { parseQaVerdict, qaThreadPrompt } from "../../src/server/stages/qa-thread";

describe("browser check thread", () => {
  it("reads the last verdict block and never turns a bare pass into a pass", () => {
    const pass = "Done.\n```json\n{\"verdict\":\"passed\",\"summary\":\"ok\",\"cases\":[{\"case\":\"wizard\",\"viewport\":\"375\",\"result\":\"passed\"}]}\n```";
    expect(parseQaVerdict(pass)).toMatchObject({ verdict: "passed", summary: "ok" });
    const bare = "```json\n{\"verdict\":\"passed\",\"summary\":\"looks fine\",\"cases\":[]}\n```";
    expect(parseQaVerdict(bare).verdict).toBe("blocked");
    const mixed = "```json\n{\"verdict\":\"passed\",\"cases\":[{\"case\":\"a\",\"viewport\":\"375\",\"result\":\"passed\"},{\"case\":\"b\",\"viewport\":\"768\",\"result\":\"failed\"}]}\n```";
    expect(parseQaVerdict(mixed).verdict).toBe("blocked");
    const fail = "```json\n{\"verdict\":\"passed\"}\n```\nthen\n```json\n{\"verdict\":\"failed\",\"summary\":\"button hidden\",\"cases\":[{\"case\":\"a\",\"viewport\":\"375\",\"result\":\"failed\"}]}\n```";
    expect(parseQaVerdict(fail)).toMatchObject({ verdict: "failed", summary: "button hidden" });
    expect(parseQaVerdict("no json here")).toMatchObject({ verdict: "blocked", summary: "browser_qa_thread_returned_no_verdict" });
  });

  it("tells the agent to drive the BB browser on the QA machine and to expose a localhost target", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:3000/wizard", cases: ["Wizard has no captcha"], viewports: "375,1280", envClass: "local", authorized: false, qaHostId: "host_mini" });
    expect(prompt).toContain("bb browser-automation open --backend local --headless --machine host_mini");
    expect(prompt).toContain("bb browser instances --host host_mini");
    expect(prompt).toContain("bb connect expose");
    expect(prompt).toContain("1. Wizard has no captcha");
    expect(prompt).toContain("do not submit, pay, delete or send");
  });
});
