import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WAY_OUT } from "../src/rooms/contracts/way-out";

/**
 * WAY_OUT is the one source for «what to do when the reason is X»; the lane-pilot-ops runbook quotes it
 * row for row. Every WAY_OUT row carries a key (the reason prefix); the runbook keeps that key in the
 * first cell of its row in backticks. This test refuses the drift the 2026-11-02 audit caught: the same
 * advice living twice and disagreeing (plan_critique_blocked, question_unanswered).
 */
const SKILL = ["SKILL.md", "references/blocked.md", "references/graphs-and-review.md"].map((file) => readFileSync(`skills/lane-pilot-ops/${file}`, "utf8")).join("\n");

const PM_TOOL = /lane_pilot_[a-z_]+/g;
const toolsOf = (text: string) => new Set([...text.matchAll(PM_TOOL)].map((m) => m[0]));

/** A code cell is the first table cell's backticked codes, with `<…>` and `…` placeholders stripped. */
const normCode = (code: string) => code.replace(/<[^>]*>/g, "").replace(/…|\.\.\./g, "").replace(/\s+/g, " ").trim();
const covers = (code: string, key: string) => {
  const norm = normCode(code);
  return norm === key || key.startsWith(norm) || norm.includes(key);
};

type Row = { codes: string[]; tools: Set<string>; line: string };
const rows: Row[] = SKILL.split("\n")
  .filter((line) => line.trimStart().startsWith("|") && !/^\|[\s-]+\|/.test(line.trim()))
  .map((line) => ({
    codes: [...(line.split("|")[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
    tools: toolsOf(line),
    line: line.slice(0, 140),
  }))
  .filter((row) => row.codes.length > 0);

it("every WAY_OUT row has a runbook row naming the same lane_pilot tools", () => {
  const missing: string[] = [];
  for (const [key, , wayOutText] of WAY_OUT) {
    const want = toolsOf(wayOutText);
    const candidates = rows.filter((row) => row.codes.some((code) => covers(code, key)));
    const agreed = candidates.some((row) => row.tools.size === want.size && [...row.tools].every((tool) => want.has(tool)));
    if (!agreed) {
      missing.push(`${key} wants {${[...want].join(", ") || "no tools"}} — rows: ${candidates.map((row) => `${row.line} {${[...row.tools].join(",")}}`).join(" || ") || "none"}`);
    }
  }
  expect(missing, missing.join("\n")).toEqual([]);
});

it("the runbook tells that a rerun re-runs the node and every step after it", () => {
  expect(SKILL).toContain("every step after it");
});
