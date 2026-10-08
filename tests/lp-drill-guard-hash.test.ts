import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Audit 2026-10-08 round 3, P0-3: the guard that runs is the installed copy on each machine; the drill compares it with the repository's.
const drill = fileURLToPath(new URL("../scripts/lp-drill.py", import.meta.url));
const repoHooks = fileURLToPath(new URL("../lane-stack/hooks", import.meta.url));
const temp = () => mkdtempSync(join(tmpdir(), "lp-drill-guard-"));

function machine(files: Record<string, string | null>) {
  const home = temp();
  mkdirSync(join(home, ".agents/hooks"), { recursive: true });
  for (const [name, text] of Object.entries(files)) if (text !== null) writeFileSync(join(home, ".agents/hooks", name), text);
  return home;
}
const same = () => ({ "guard_shell.py": readFileSync(join(repoHooks, "guard_shell.py"), "utf8"), "lib_payload.py": readFileSync(join(repoHooks, "lib_payload.py"), "utf8") });

function runDrill(machines: object[], extra: string[] = []) {
  const receipts = temp();
  const res = spawnSync("python3", ["-I", drill, "--scenario", "guard_hash", ...extra], {
    encoding: "utf8", timeout: 60_000,
    env: { ...process.env, LP_DRILL_GUARD_HOSTS: JSON.stringify(machines), LP_DRILL_RECEIPT_DIR: receipts, BB_CLI: "/nonexistent/bb", TMPDIR: temp() },
  });
  const file = readdirSync(receipts).find((name) => name.endsWith(".json"));
  const receipt = file ? JSON.parse(readFileSync(join(receipts, file), "utf8")) as { result: string; problems: string[]; scenarios: Array<{ machines: Array<{ machine: string; reachable: boolean; files: Record<string, { state: string }> }>; unreachable: string[] }> } : null;
  return { res, receipt };
}

describe("the drill's guard hash check", () => {
  it("passes when every machine has the repository's guard", () => {
    const { res, receipt } = runDrill([{ name: "a", kind: "local", home: machine(same()) }, { name: "b", kind: "local", home: machine(same()) }]);
    expect(res.status).toBe(0);
    expect(receipt!.result).toBe("pass");
    expect(receipt!.scenarios[0]!.machines.map((m) => m.files["guard_shell.py"]!.state)).toEqual(["ok", "ok"]);
  });

  it("fails on a drifted or missing copy and gives the install command per machine", () => {
    const drifted = machine({ ...same(), "guard_shell.py": "# an older guard\n" });
    const missing = machine({ "lib_payload.py": same()["lib_payload.py"], "guard_shell.py": null });
    const { res, receipt } = runDrill([{ name: "mini", kind: "local", home: machine(same()) }, { name: "book", kind: "local", home: drifted }, { name: "ovh", kind: "local", home: missing }]);
    expect(res.status).toBe(1);
    expect(receipt!.result).toBe("fail");
    const problems = receipt!.problems.join("\n");
    expect(problems).toMatch(/book: guard_shell\.py differs from the repository/);
    expect(problems).toMatch(/ovh: guard_shell\.py is missing/);
    expect(problems).toContain(`install -m 755 ${join(repoHooks, "guard_shell.py")} ${join(drifted, ".agents/hooks/guard_shell.py")}`);
    expect(problems).not.toMatch(/mini:/);
    expect(readFileSync(join(drifted, ".agents/hooks/guard_shell.py"), "utf8")).toBe("# an older guard\n");
  });

  it("checks the other files the guard imports too", () => {
    const { receipt } = runDrill([{ name: "book", kind: "local", home: machine({ ...same(), "lib_payload.py": "# old\n" }) }]);
    expect(receipt!.problems.join("\n")).toMatch(/book: lib_payload\.py differs/);
  });

  it("repairs with --repair-guard: installs the repository copy, keeps the old one, and the machine reads back equal", () => {
    const drifted = machine({ ...same(), "guard_shell.py": "# an older guard\n" });
    const missing = machine({ "lib_payload.py": same()["lib_payload.py"], "guard_shell.py": null });
    const { res, receipt } = runDrill([{ name: "book", kind: "local", home: drifted }, { name: "ovh", kind: "local", home: missing }], ["--repair-guard"]);
    expect(res.status).toBe(0);
    expect(receipt!.result).toBe("pass");
    for (const home of [drifted, missing]) expect(readFileSync(join(home, ".agents/hooks/guard_shell.py"), "utf8")).toBe(same()["guard_shell.py"]);
    expect(readdirSync(join(drifted, ".agents/hooks")).some((name) => name.startsWith("guard_shell.py.bak-"))).toBe(true);
    expect(receipt!.scenarios[0]!.machines.map((m) => m.files["guard_shell.py"]!.state)).toEqual(["repaired", "repaired"]);
  });

  it("fails a repair that cannot write, and says why", () => {
    const locked = machine({ ...same(), "guard_shell.py": "# an older guard\n" });
    chmodSync(join(locked, ".agents/hooks"), 0o500);
    try {
      const { res, receipt } = runDrill([{ name: "book", kind: "local", home: locked }], ["--repair-guard"]);
      if (process.getuid?.() === 0) return; // root writes anywhere
      expect(res.status).toBe(1);
      expect(receipt!.scenarios[0]!.machines[0]!.files["guard_shell.py"]!.state).toMatch(/repair failed/);
    } finally { chmodSync(join(locked, ".agents/hooks"), 0o700); }
  });

  it("notes a machine that cannot be reached and does not fail on it", () => {
    const { res, receipt } = runDrill([
      { name: "mini", kind: "local", home: machine(same()) },
      { name: "off", kind: "ssh", host: "lp-drill-host-that-does-not-exist.invalid" },
    ]);
    expect(res.status).toBe(0);
    expect(receipt!.result).toBe("pass");
    expect(receipt!.scenarios[0]!.unreachable).toEqual(["off"]);
    expect(existsSync(join(tmpdir(), "lp-drill.lock"))).toBe(false);
  });
});
