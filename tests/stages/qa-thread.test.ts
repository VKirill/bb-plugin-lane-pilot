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

  it("tells the agent to drive the BB browser on the QA machine and says a local target is unreachable without a VPN address", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:3000/wizard", cases: ["Wizard has no captcha"], viewports: "375,1280", envClass: "local", authorized: false, qaHostId: "host_mini" });
    expect(prompt).toContain("bb browser-automation open --backend local --headless --machine host_mini");
    expect(prompt).toContain("bb browser instances --host host_mini");
    expect(prompt).not.toContain("bb connect expose");
    expect(prompt).toContain("no VPN address for the browser machine");
    expect(prompt).toContain("do not guess an address");
    expect(prompt).toContain("1. Wizard has no captcha");
    expect(prompt).toContain("do not submit, pay, delete or send");
    expect(prompt).not.toContain("Dev server");
  });

  it("opens a localhost target on another machine at its VPN address, without bb connect", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:8765/", cases: ["Page loads"], viewports: "375", envClass: "local", authorized: false,
      qaHostId: "host_mini", vpnAddress: "10.8.0.4" });
    expect(prompt).toContain("http://10.8.0.4:<port>/");
    expect(prompt).toContain("Do not use bb connect.");
    expect(prompt).not.toContain("bb connect expose");
  });

  it("starts a given dev server in a BB terminal of the check's thread and closes it", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:5173/", cases: ["Page loads"], viewports: "375", envClass: "local", authorized: false,
      qaHostId: "host_mini", devServer: "npm run dev -- --port 5173" });
    expect(prompt).toContain('bb terminal create --thread "$BB_THREAD_ID" --title "Dev server" --json -- npm run dev -- --port 5173');
    expect(prompt).toContain("bb terminal close <id>");
    expect(prompt.indexOf("0. The target")).toBeLessThan(prompt.indexOf("1. Load the browser-automation skill"));
  });
});
