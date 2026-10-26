import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Fable review 2026-10-27 §2.1: the phase route has a live drill scenario (full set; it waits for two model stages, so it is not in --quick).
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));

/** Calls a pure function of the drill script with JSON arguments and returns its JSON result. */
function call(name: string, ...args: unknown[]): unknown {
  const code = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(getattr(m, sys.argv[1])(*json.loads(sys.argv[2]))))
`;
  const res = spawnSync("python3", ["-I", "-c", code, name, JSON.stringify(args)], { encoding: "utf8", timeout: 30_000 });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim().split("\n").pop()!);
}

const book = (...parts: Array<[string, string]>) => ["# Phase ph_1: T", "", "## 9. Decisions and returns", "", ...parts.map(([kind, text]) => `- 2026-10-27 12:00 **${kind}** — ${text}`)].join("\n");

describe("the drill of the phase route", () => {
  it("is named in the full set, has its function, and is not in the quick set", () => {
    expect(call("scout")).toMatchObject({ unlisted: [], undefined: [] });
    expect((call("scout") as { defined: string[] }).defined).toContain("phase_route");
    const quick = spawnSync("python3", ["-I", "-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("drill", ${JSON.stringify(drill)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps([m.QUICK, m.ALL]))`], { encoding: "utf8" });
    const [quickSet, fullSet] = JSON.parse(quick.stdout.trim().split("\n").pop()!) as [string[], string[]];
    expect(fullSet).toContain("phase_route");
    expect(quickSet).not.toContain("phase_route");
  });

  it("fails a book with an auto_failed for repo_edited or a refused binary read, and passes a clean one that reached execution", () => {
    const red = book(["auto_failed", "lp.analyze did not finish (repo_edited: the analyst helper edited repository files it may not touch: .agents/phases/ph_1/CONTEXT.md): run again"]);
    expect(call("route_problems", red, "execution")).toEqual([expect.stringContaining("repo_edited")]);
    const binary = book(["auto_failed", "lp.draw did not finish (cannot read x.png: lane_pilot_read_binary_rejected)"]);
    expect(call("route_problems", binary, "execution")).toEqual([expect.stringContaining("lane_pilot_read_binary_rejected")]);
    const other = book(["auto_failed", "lp.review did not finish (budget_exceeded:steps)"], ["auto_started", "Lane Pilot runs lp.analyze"]);
    expect(call("route_problems", other, "verification")).toEqual([]);
    expect(call("route_problems", book(["auto_started", "x"]), "planning")).toEqual([expect.stringContaining("did not carry the phase to execution")]);
  });

  it("holds only while the phase stays paused, starts no stage and issues no piece", () => {
    const at = (state: string, auto_started: number, issued: number) => ({ stage: "planning", state, auto_started, issued });
    expect(call("hold_problems", "pause", at("paused", 1, 0), at("paused", 1, 0))).toEqual([]);
    expect(call("hold_problems", "pause", at("paused", 1, 0), at("active", 1, 0))).toEqual([expect.stringContaining("did not stay paused")]);
    expect(call("hold_problems", "pause", at("paused", 1, 0), at("paused", 2, 0))).toEqual([expect.stringContaining("a stage was started")]);
    expect(call("hold_problems", "stop_wave", at("paused", 1, 2), at("paused", 1, 3))).toEqual([expect.stringContaining("a piece was issued")]);
  });

  it("reads the part lines of a rendered book", () => {
    expect(call("book_parts", book(["stage", "discussion → planning: ok"], ["auto_failed", "a — b"]))).toEqual([["stage", "discussion → planning: ok"], ["auto_failed", "a — b"]]);
  });
});
