import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { SMA_CARDS, SMA_CONTRACT_TESTS, SMA_LINKS, SMA_NODES, brokenProof, isDone, runSmaMapCli, smaHoles, smaRows } from "../src/rooms/sma-map";

// Only this repository's links: a link into Lane Stack or the core is navigation, and a rename there must not fail Lane Pilot's
// suite (2026-10-29 Grok audit F-004). What a card promises is checked by its [sma:<id>] contract test, not by its link.
const roots = { lanePilot: process.cwd() };

// A ratchet (only shrinks): region 10's proof links were written as body text while the Telegram plugin was not on any
// machine; in a module an anchor must name a declared unit, so they are broken wherever the plugin is checked out
// (siblings.ts). Fixing one = pointing its entry at the declared unit that implements the card, and deleting it here.
const TELEGRAM_TEXT_ANCHORS = new Set([
  "telegram:server.ts#pairing: async () => {", "telegram:server.ts#getUpdates", "telegram:server.ts#if (!cfg.enabled", "telegram:server.ts#timeout: 25,",
  "telegram:server.ts#Backoff after a failure", "telegram:ingress.ts#A stranger chat gets one sentence", "telegram:ingress.ts#/^\\/start",
  "telegram:server.ts#store.put(\"owner:id\", route.userId);", "telegram:ingress.ts#Not text: a sticker", "telegram:chat.ts#this.d.sdk.threads.send({",
  "telegram:server.ts#Conversation not connected", "telegram:chat.ts#sendChatAction", "telegram:chat.ts#A draft waits for «yes»",
  "telegram:test/settings.test.ts#never token", "telegram:server.ts#The pairing code: 8 characters", "telegram:server.ts#https://t.me/${username}?start=${code}",
  "telegram:server.ts#Off, awaiting code, linked", "telegram:server.ts#settings.onChange(() => {", "telegram:server.ts#store.put(\"pair:code\", code);",
  "telegram:server.ts#unpair: async () => {",
]);

describe("the SMA map registry", () => {
  it("is the whole site map: every node, link and card, with one entry each and none left out", () => {
    expect(SMA_NODES.length).toBe(1798);
    expect(SMA_LINKS.length).toBe(2654);
    expect(SMA_LINKS.filter(([, , kind]) => kind === "retries")).toHaveLength(9);
    expect(SMA_NODES.filter(([id]) => !SMA_CARDS[id])).toEqual([]);
    expect(smaHoles()).toEqual([]);
  });

  it("links only nodes of the map", () => {
    const ids = new Set(SMA_NODES.map(([id]) => id));
    expect(SMA_LINKS.filter(([from, to]) => !ids.has(from) || !ids.has(to))).toEqual([]);
  });

  it("marks upstream only the nodes SMA itself leaves unwired", () => {
    expect(smaRows().filter((row) => row.status === "upstream" && !row.unsure).map((row) => row.smaId)).toEqual([]);
  });

  it("marks void only with the reason said: no proof link, no gap line, and the text names why there is nothing to guard", () => {
    const voids = smaRows().filter((row) => row.status === "void");
    expect(voids.filter((row) => row.proof || row.gaps.length || !row.ours.startsWith("нет предмета: ")).map((row) => row.id)).toEqual([]);
  });

  it("knows the contract tests: contracts.ts is current and every [sma:<id>] names a card of the map", () => {
    execFileSync("node", ["scripts/sma-contracts.mjs", "--check"], { stdio: "pipe" });
    const cards = new Set(Object.values(SMA_CARDS).map(([smaId]) => smaId));
    expect(Object.keys(SMA_CONTRACT_TESTS).filter((id) => !cards.has(id))).toEqual([]);
  });

  it("points every proof at a file that holds the named symbol", () => {
    const broken = smaRows().flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter(Boolean);
    expect(broken).toEqual([]);
  });

  it("is mapped: every node has an entry — a proof link, SMA leaving it unwired, or an honest missing", () => {
    const unmapped = smaRows().filter((row) => !row.ours).map((row) => `${row.id} ${row.status} ${row.label}`);
    expect(unmapped).toEqual([]);
  });

  it("counts a card whose gap register names a missing behaviour as partial, not have", () => {
    const gapped = smaRows().filter((row) => row.gaps.length);
    expect(gapped.length).toBeGreaterThan(0);
    for (const row of gapped) expect(row.status).not.toBe("have");
  });

  it("prints the share done and the regions", () => {
    const result = runSmaMapCli([]);
    expect(result.stdout).toMatch(/SMA map \(code 481d75c2\): 1798 nodes, 2654 links — checked by a contract test \d+ \([\d.]+%\); mapped [\d.]+%/);
    expect(runSmaMapCli(["--region", "18", "--status", "missing"]).stdout).toContain("Claude Code session hooks");
  });
});

describe("the split evidence states (X-2)", () => {
  it("--states counts the four proofs (tests/sma-states.test.ts); --live adds observed and outcome-verified", () => {
    const result = runSmaMapCli(["--states"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/proof links \(the weaker ladder\): resolved \d+, broken \d+, unjudged \d+/);
    const json = JSON.parse(runSmaMapCli(["--states", "--json"]).stdout!);
    expect(json.states).toMatchObject({ total: 1798 });
    expect(json.states.checked).toBeGreaterThan(0);
    expect(json.states.observed).toBeNull();
  });

  it("judges no proof on a machine without the sources, and counts the unjudged ones (the hub called 1509 proofs broken, 2026-11-10)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // A machine without the sources has no sibling either (the proofs worktrees under ~/.lane-pilot are found from any folder).
    const saved = { core: process.env.SMA_SIBLING_CORE, telegram: process.env.SMA_SIBLING_TELEGRAM };
    process.env.SMA_SIBLING_CORE = "off";
    process.env.SMA_SIBLING_TELEGRAM = "off";
    let built: ReturnType<typeof runSmaMapCli>;
    try { built = runSmaMapCli(["--check-proofs", "--states"], mkdtempSync(`${tmpdir()}/lp-built-`)); }
    finally {
      for (const [key, value] of [["SMA_SIBLING_CORE", saved.core], ["SMA_SIBLING_TELEGRAM", saved.telegram]] as const) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    expect(built.exitCode).toBe(0);
    expect(built.stdout).not.toMatch(/Broken proofs/);
    expect(built.stdout).toMatch(/resolved 0 \(0 broken, 1\d{3} unjudged\)/);
    expect(built.stdout).toMatch(/Proofs not judged: 1\d{3} point .*this one included/);
    const here = runSmaMapCli(["--check-proofs", "--states"]);
    const unjudged = Number(/Proofs not judged: (\d+)/.exec(here.stdout ?? "")?.[1] ?? 0);
    // The only broken proofs allowed are the Telegram text anchors below, and only where the Telegram plugin is on the machine.
    const broken = [...(here.stdout ?? "").matchAll(/^ {2}(telegram:[^#\n]*#(.+)): \2 is not declared in the module$/gm)].map((hit) => hit[1]!);
    expect(broken.filter((proof) => !TELEGRAM_TEXT_ANCHORS.has(proof))).toEqual([]);
    expect(here.stdout).toContain(`${broken.length} broken, ${unjudged} unjudged`);
  });
});
