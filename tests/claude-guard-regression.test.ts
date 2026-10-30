import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { guardTool } from "../lane-stack/opencode/opencode-lane/guard";
import { recordTool, recentAttempts } from "../lane-stack/opencode/opencode-lane/budget";
import { NATIVE_OPENCODE_SOURCES } from "../src/rooms/native-install/native-opencode-sources";

it("embeds the slim OpenCode plugin that reconcile writes", () => {
  const guard = readFileSync(new URL("../lane-stack/opencode/opencode-lane/guard.ts", import.meta.url), "utf8");
  expect(NATIVE_OPENCODE_SOURCES["opencode-lane/guard.ts"]).toBe(guard);
});

it("A-033 read-only git before forbidden git must not hide the forbidden command", () => {
  expect(guardTool("shell", { command: "git push origin main" }, "/fixture")).toContain("blocked");
  expect(guardTool("shell", { command: "rg -n 'git push' docs/README.md" }, "/fixture")).toBe("");
  expect(guardTool("shell", { command: "git status && git push origin main" }, "/fixture")).toContain("blocked");
});

it("A-033 a shell wrapper must inspect all commands in its script", () => {
  expect(guardTool("shell", { command: "bash -c 'echo ready; git reset --hard'" }, "/fixture")).toContain("blocked");
  expect(guardTool("shell", { command: "sh -c 'git status || git merge topic'" }, "/fixture")).toContain("blocked");
});

it("A-015 fixed history retains a bounded useful tail after 100 full outputs", () => {
  const sid = "audit-fixed-history-" + Date.now();
  for (let i = 0; i < 100; i++) recordTool(sid, "shell", { command: `printf fixture-${i}` }, "x".repeat(8000));
  const recent = recentAttempts(sid);
  expect(recent.length).toBeGreaterThan(0);
  expect(recent.length).toBeLessThanOrEqual(24);
  expect(recent.reduce((n, row) => n + row.tail.length, 0)).toBeLessThanOrEqual(12000);
  expect(recent.at(-1)?.cmd).toContain("99");
});

it("leaves skills and MCP servers open: a browser task may load browser-automation (owner, 2026-10-30)", () => {
  expect(guardTool("skill", { name: "browser-automation" }, "/fixture")).toBe("");
  expect(guardTool("mcp__chrome-devtools__navigate_page", { url: "https://example.com" }, "/fixture")).toBe("");
  expect(guardTool("mcp", { serverIdentifier: "metamcp" }, "/fixture")).toBe("");
});
