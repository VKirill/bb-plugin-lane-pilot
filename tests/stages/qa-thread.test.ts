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

  it("K2: the old verdict maps onto the unified status, and the new answer is read with its findings and evidence", () => {
    const fenced = (json: unknown) => `Done.\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
    const cases = (result: string) => [{ case: "wizard", viewport: "375", result }];
    expect(parseQaVerdict(fenced({ verdict: "passed", summary: "ok", cases: cases("passed") }))).toMatchObject({ verdict: "passed", status: "pass" });
    expect(parseQaVerdict(fenced({ verdict: "failed", summary: "x", cases: cases("failed") }))).toMatchObject({ verdict: "failed", status: "rework" });
    expect(parseQaVerdict("no json here")).toMatchObject({ verdict: "blocked", status: "block" });
    const pass = parseQaVerdict(fenced({ status: "pass", summary: "all green", findings: [], evidence: "375 and 1280 px, three layers per case", cases: cases("passed") }));
    expect(pass).toMatchObject({ verdict: "passed", status: "pass", evidence: "375 and 1280 px, three layers per case" });
    const fail = parseQaVerdict(fenced({ status: "rework", summary: "button hidden", cases: cases("failed"), evidence: "snapshot at 375",
      findings: [{ file: "/wizard", severity: "high", evidence: "the Next button is not in the snapshot at 375 px", finding: "no entry point" }] }));
    expect(fail).toMatchObject({ verdict: "failed", status: "rework" });
    expect(fail.findings?.[0]).toMatchObject({ file: "/wizard", severity: "high" });
    expect(parseQaVerdict(fenced({ status: "block", summary: "no VPN address", evidence: "tried", findings: [], cases: cases("blocked") }))).toMatchObject({ verdict: "blocked", status: "block" });
  });

  it("K2: a new-format pass is still no pass without every case passed, or with a serious finding", () => {
    const fenced = (json: unknown) => `\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
    expect(parseQaVerdict(fenced({ status: "pass", summary: "s", evidence: "e", findings: [], cases: [] })).verdict).toBe("blocked");
    expect(parseQaVerdict(fenced({ status: "pass", summary: "s", evidence: "e", findings: [], cases: [{ case: "a", viewport: "375", result: "passed" }, { case: "b", viewport: "375", result: "failed" }] })).verdict).toBe("blocked");
    const serious = parseQaVerdict(fenced({ status: "pass", summary: "s", evidence: "e", cases: [{ case: "a", viewport: "375", result: "passed" }],
      findings: [{ file: "/cart", severity: "high", evidence: "the Pay button sends no POST request" }] }));
    expect(serious).toMatchObject({ verdict: "failed", status: "rework" });
  });

  it("K2: the prompt asks for the unified answer and says when each status applies", () => {
    const prompt = qaThreadPrompt({ url: "http://localhost:3000/", cases: ["Loads"], viewports: "375", envClass: "local", authorized: false, qaHostId: "h" });
    expect(prompt).toContain('"status":"pass|rework|block"');
    expect(prompt).toMatch(/pass only when every case passed on every viewport; rework when a case failed; block when you could not check/);
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
