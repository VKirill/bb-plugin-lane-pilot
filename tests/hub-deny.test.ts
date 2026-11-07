import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HUB_ADDRESS_INTS, HUB_ADDRESSES, HUB_NAMES } from "../src/rooms/contracts/hub-deny";

// The hub deny list's source is lane-stack/hooks/guard_shell.py; the OpenCode lane's hub-guard.ts runs in another runtime
// and keeps its own copy. This test fails when any of the three spellings drifts.
const guardPy = readFileSync("lane-stack/hooks/guard_shell.py", "utf8");
const hubGuard = readFileSync("lane-stack/opencode/opencode-lane/hub-guard.ts", "utf8");

const pySet = (name: string): string[] => {
  const match = new RegExp(`${name} = \\{([^}]*)\\}`).exec(guardPy);
  return match ? match[1]!.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
};

describe("hub deny list", () => {
  it("guard_shell.py names the same aliases", () => {
    expect(new Set(pySet("_HUB_NAMES"))).toEqual(new Set(HUB_NAMES));
  });

  it("guard_shell.py blocks the same addresses", () => {
    // _HUB_ADDRESSES holds ints as Python bit math like `(10 << 24) | (8 << 16) | 1` — evaluate them.
    const evalInt = (expr: string) => expr.split("|").reduce((acc, term) => {
      const shift = /(\d+)\s*<<\s*(\d+)/.exec(term.trim());
      return acc | (shift ? Number(shift[1]) << Number(shift[2]) : Number(term.trim()));
    }, 0);
    const ints = pySet("_HUB_ADDRESSES").map(evalInt);
    expect(new Set(ints)).toEqual(new Set(HUB_ADDRESS_INTS));
  });

  it("hub-guard.ts covers every name and address", () => {
    const match = /const HUB_HOSTS = \[([\s\S]*?)\]/.exec(hubGuard);
    const hosts = match ? match[1]!.split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
    for (const name of [...HUB_NAMES, ...HUB_ADDRESSES]) expect(hosts, name).toContain(name);
  });

  it("address numbers are the inet_aton values of the dotted addresses", () => {
    const num = (addr: string) => addr.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
    expect(HUB_ADDRESSES.map(num)).toEqual([...HUB_ADDRESS_INTS]);
  });
});
