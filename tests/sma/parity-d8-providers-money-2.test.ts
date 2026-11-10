/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { attemptSessionLayers, terminalParity } from "../../src/rooms/native-agent";
import { featureRegistry, featureRegistryGaps } from "../../src/rooms/native-install";
import { checkTickDeps, TICK_DEPS } from "../../src/rooms/platform/server";
import { GUARD_INVENTORY, guardInventoryGaps, STREAMS } from "../../src/rooms/session-hooks";
import { createAttempt, createRun, createTask, openDatabase, recordSkillMetric, saveReasoningTrace } from "../../src/rooms/plugin-db";

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb");
  return { bb, db };
}

describe("parity d8-2: providers and money", () => {
  it("[sma:m_tl_terminal_parity] the six layers of one attempt come back in fixed order, and a tool the terminal lost is named as the permissions difference", () => {
    const { db } = world();
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, {
      attemptId: "a1", runId: "run", threadId: "thr1", providerId: "claude-code", model: "m",
      effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: "", memoryPicked: ["mem1"], rulesPicked: { total: 1, picked: ["rule1"] }, executionPacket: "", executionPacketSha256: "x", pmReadContext: "", agent: "writer", helperMode: "", helperRequired: false },
    } as never);
    recordSkillMetric(db, { id: "skm1", attemptId: "a1", taskId: "t1", runId: "run", projectId: "proj", skillCount: 1, switchCount: 0, skillsJson: JSON.stringify(["skill-a"]), outcome: "accepted", recordedAt: 1 });
    const session = attemptSessionLayers(db, "a1");
    expect(session).not.toBeNull();
    const terminal = { ...session!, skills: ["skill-a"], model: ["claude-code/m"] };
    const lines = terminalParity(session!, terminal);
    expect(lines.map((line) => line.layer)).toEqual(["hooks", "memory", "rules", "skills", "permissions", "model"]);
    expect(lines.find((line) => line.layer === "skills")?.same).toBe(true);
    expect(lines.find((line) => line.layer === "model")?.same).toBe(true);
    const dropped = terminal.permissions[0]!;
    const after = terminalParity(session!, { ...terminal, permissions: terminal.permissions.slice(1) });
    const permissions = after.find((line) => line.layer === "permissions");
    expect(permissions?.same).toBe(false);
    expect(permissions?.detail).toContain(dropped);
  });

  it("[sma:k_t_capreg] every agent, skill and hook of the registry is shipped by the bundle, the streams or the capability contract, and an unknown skill is reported", () => {
    const registry = featureRegistry();
    expect(registry.length).toBeGreaterThan(1);
    const guard = registry.find((feature) => feature.id === "session-guard");
    expect(guard?.hooks.claude).toEqual([...STREAMS]);
    expect(guard?.hooks.opencode?.every((hook) => hook.startsWith("opencode.hook."))).toBe(true);
    expect(featureRegistryGaps(registry)).toEqual([]);
    const broken = [...registry, { id: "made-up", agents: {}, skills: { claude: ["no-such-skill"] }, hooks: {} }];
    expect(featureRegistryGaps(broken).some((gap) => gap.includes("no-such-skill"))).toBe(true);
  });

  it("[sma:m_tick_deps] an empty bag reports every tick dep missing and a full bag reports none", () => {
    expect(checkTickDeps({}).missing).toEqual([...TICK_DEPS]);
    const full = Object.fromEntries(TICK_DEPS.map((name) => [name, {}]));
    const report = checkTickDeps(full);
    expect(report.missing).toEqual([]);
    expect(report.wired).toEqual([...TICK_DEPS]);
  });

  it("[sma:k_d_ref_gates_inv] every stream and every pretask deny tag has a row with matcher, text and switch; an unknown deny tag is reported", () => {
    const ids = new Set(GUARD_INVENTORY.map((row) => row.id));
    for (const stream of STREAMS) expect(ids.has(stream)).toBe(true);
    for (const tag of ["execution-without-agent", "subagent-foreground", "subagent-cap"]) expect(ids.has(tag)).toBe(true);
    for (const row of GUARD_INVENTORY) {
      expect(row.matcher.length).toBeGreaterThan(0);
      expect(row.text.length).toBeGreaterThan(0);
      expect(row.switch.length).toBeGreaterThan(0);
    }
    expect(guardInventoryGaps(["no-such-deny"]).unknown).toEqual(["no-such-deny"]);
    expect(guardInventoryGaps().empty).toEqual([]);
  });
});
