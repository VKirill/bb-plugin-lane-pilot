import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokenWireReason, readWires, wiresCommand } from "../../src/rooms/wires";
import { planFactOutcome, type PlanFactCheck } from "../../src/rooms/tasks/plan-fact";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "lp-wires-"));
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  write("src/settings.ts", "export function loadSettings() { return read('ui.theme'); }\n");
  write("src/app.tsx", "import { loadSettings } from './settings';\nexport const App = () => <ThemeProvider value={loadSettings()} />;\n");
  write("tests/app.test.ts", "loadSettings(); ThemeProvider; ui.theme; Footer;\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  write("src/new-untracked.ts", "export const footer = () => Banner;\n");
  return dir;
}
const run = (dir: string, command: string) => execSync(command, { cwd: dir, shell: "/bin/sh", encoding: "utf8" });

describe("declared wires", () => {
  it("finds each hop in a source file, untracked ones included, and names the first hop that meets nowhere (tests do not count)", () => {
    const dir = repo();
    const wires = [
      { chain: ["ui.theme", "loadSettings", "ThemeProvider"], why: "the saved theme reaches the page" },
      { chain: ["loadSettings", "Footer"] },
      { chain: ["footer", "Banner"] },
    ];
    const results = readWires(wires, run(dir, wiresCommand(wires)));
    expect(results[0]).toMatchObject({ broken: null, hops: [{ from: "ui.theme", to: "loadSettings", file: "src/settings.ts" }, { from: "loadSettings", to: "ThemeProvider", file: "src/app.tsx" }] });
    expect(results[1]!.broken).toEqual({ from: "loadSettings", to: "Footer", file: null });
    expect(results[2]!.broken).toBeNull();
    expect(brokenWireReason(results)).toBe("plan_fact_wire_broken: loadSettings -> Footer stops between «loadSettings» and «Footer» (no source file names both)");
  });

  it("quotes names with quotes and spaces safely, and a missing line is a broken hop", () => {
    const dir = repo();
    expect(() => run(dir, wiresCommand([{ chain: ["it's", "a b; rm -rf /"] }]))).not.toThrow();
    expect(readWires([{ chain: ["a", "b"] }], "")[0]!.broken).toEqual({ from: "a", to: "b", file: null });
  });

  it("a broken wire fails plan-fact even when the writer gave no table; intact wires change nothing", () => {
    const base: PlanFactCheck = { table: "missing", tableReason: null, items: [], extraRows: [], blocking: [], notChecked: [] };
    const broken = readWires([{ chain: ["a", "b"] }], "");
    expect(planFactOutcome({ ...base, wires: broken })).toMatchObject({ state: "failed", reason: expect.stringMatching(/^plan_fact_wire_broken: a -> b/) });
    expect(planFactOutcome({ ...base, wires: readWires([{ chain: ["a", "b"] }], "__lp_wire__ 0 0 src/x.ts") })).toMatchObject({ state: "skipped" });
  });
});
