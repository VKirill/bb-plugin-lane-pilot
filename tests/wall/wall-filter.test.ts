import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevClient } from "@lane-pilot/jev";
import {
  WALL_FILTER_ID,
  wallFilterJudgment,
  buildWallFilterState,
  type WallFilterInput,
} from "../../src/rooms/wall";
import { createWall, type WallPorts, type WallDeps } from "../../src/rooms/wall/service";
import type { EvidencePack } from "../../src/rooms/wall/pack";

function createMockJev(top: string, p: number, db: any) {
  const asked: unknown[] = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      asked.push(request.state);
      const rest = (1 - p) / 2;
      const probabilities = {
        hunt: top === "hunt" ? p : rest,
        infra_noise: top === "infra_noise" ? p : rest,
        duplicate: top === "duplicate" ? p : rest,
      };
      return {
        ok: true,
        model: "jev-test",
        usage: { input_tokens: 300, output_tokens: 10 },
        latencyMs: 75,
        attempts: 1,
        answers: {
          [Object.keys(request.questions)[0]!]: {
            type: "choice",
            choice: top,
            probabilities,
            confidence: 0.9,
          },
        },
      };
    },
  };
  const instance = createJev({ client, db });
  return { instance, asked };
}

describe("Wall hunt filter judgment", () => {
  it("stateBuilder selects only whitelisted fields and clips values", () => {
    const input: WallFilterInput = {
      wallKey: "class:1234567890abcdef",
      subject: "task:failed",
      kind: "class",
      facts: ["fact 1", "fact 2"],
      reasons: ["ENOSPC: no space left on device"],
      checkOutputs: ["exit code 1"],
    };
    const state = buildWallFilterState(input);
    expect(Object.keys(state).sort()).toEqual([
      "check_outputs",
      "facts",
      "kind",
      "reasons",
      "subject",
      "wall_key",
    ]);
    expect(state.wall_key).toBe("class:1234567890abcdef");
    expect(state.kind).toBe("class");
  });

  it("decides to skip on confident infra noise or duplicate", () => {
    const t = { min_p: 0.8, min_margin: 0.35 };
    const infraAnswers = {
      triage: {
        type: "choice" as const,
        choice: "infra_noise",
        confidence: 0.9,
        probabilities: { infra_noise: 0.85, hunt: 0.1, duplicate: 0.05 },
      },
    };
    const input: WallFilterInput = {
      wallKey: "k",
      subject: "s",
      kind: "class",
      facts: [],
      reasons: [],
    };
    expect(wallFilterJudgment.decide(infraAnswers, t, input)).toEqual({
      decision: {
        action: "skip",
        category: "infra_noise",
        reason: "high-confidence infra noise (0.85)",
      },
    });

    const dupAnswers = {
      triage: {
        type: "choice" as const,
        choice: "duplicate",
        confidence: 0.9,
        probabilities: { duplicate: 0.82, hunt: 0.1, infra_noise: 0.08 },
      },
    };
    expect(wallFilterJudgment.decide(dupAnswers, t, input)).toEqual({
      decision: {
        action: "skip",
        category: "duplicate",
        reason: "high-confidence duplicate fingerprint (0.82)",
      },
    });
  });

  it("falls back to hunt on uncertain probabilities or low margin", () => {
    const t = { min_p: 0.8, min_margin: 0.35 };
    const uncertainAnswers = {
      triage: {
        type: "choice" as const,
        choice: "infra_noise",
        confidence: 0.5,
        probabilities: { infra_noise: 0.55, hunt: 0.45, duplicate: 0.0 },
      },
    };
    const input: WallFilterInput = {
      wallKey: "k",
      subject: "s",
      kind: "class",
      facts: [],
      reasons: [],
    };
    expect(wallFilterJudgment.decide(uncertainAnswers, t, input)).toEqual({
      decision: {
        action: "hunt",
        category: "uncertain",
        reason: "uncertain pick: proceed to hunters",
      },
    });
    expect(wallFilterJudgment.fallback(input)).toEqual({
      action: "hunt",
      category: "fallback",
      reason: "fallback: proceed to hunters",
    });
    expect(wallFilterJudgment.defaultMode).toBe("shadow");
  });
});

describe("Wall service hunt with Jev filter", () => {
  const pack: EvidencePack = {
    kind: "class",
    subject: "class:test",
    facts: ["moves spent: 3"],
    attempts: [
      {
        id: "att_1",
        state: "failed",
        reason: "provider quota exceeded",
        project: "p1",
        version: "1.0.0",
        at: Date.now(),
      },
    ],
    receipts: [],
    files: [],
    checkOutputs: [],
    queries: [],
  };

  it("shadow mode (default): records receipt and runs hunters as usual", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const { instance: mockJev, asked } = createMockJev("infra_noise", 0.9, db);
    let huntersRan = false;

    const ports: WallPorts = {
      now: () => Date.now(),
      version: "1.0.0",
      loadScope: async () => ({ isReal: () => true, scopeOf: () => "real" }),
      logLines: () => [],
      codeFiles: async () => [],
      reader: async () => {
        huntersRan = true;
        return { text: JSON.stringify({ angle: "task", verdict: "unknown", summary: "none", evidence: [], action: "none" }), tokens: 100 };
      },
      tellPm: async () => true,
      repair: {
        view: async () => null,
        report: async () => "",
        tokens: async () => null,
        busy: async () => false,
        changedFiles: async () => null,
        revert: async () => ({ ok: true, detail: "" }),
      },
      release: { drill: async () => null, canary: async () => null },
      bench: {
        available: async () => true,
        armSet: async () => null,
        ensureArm: async () => "done",
        compare: async () => "pass",
        score: async () => 1.0,
      },
      restart: async () => ({ ok: true, note: "" }),
      deferrals: { open: () => {}, close: () => {} },
    };

    const wall = createWall({
      db,
      kv: { get: async () => ({}), set: async () => {} },
      ports,
      log: () => {},
      jev: () => mockJev,
      settings: async () => ({}), // shadow mode by default
    });

    const cls = {
      classKey: "c1",
      failureClass: "infra",
      reasonNorm: "provider quota exceeded",
      origin: "infra",
      firstSeen: 1,
      lastSeen: 2,
      total: 3,
      counts: [1, 2, 3] as [number, number, number],
      windows: [10, 100, 500] as [number, number, number],
      rung: 1 as const,
      state: "open" as const,
      recur7: 5,
      recur1: 2,
      failedMoves: 3,
      hunt: "none" as const,
      afterHuntFailed: 0,
      stage: "hunt" as const,
    };

    await (wall as any).huntClass(cls, { hunters: 1, huntShare: 0.5, nightTokenCap: 100_000 } as any, Date.now());

    expect(huntersRan).toBe(true);
    expect(asked.length).toBe(1);

    // Verify receipt was written in shadow mode
    const receipt = db.prepare("SELECT judgment, mode, decided_by FROM lane_pilot_jev_receipt WHERE judgment=?").get(WALL_FILTER_ID) as any;
    expect(receipt).toBeDefined();
    expect(receipt.judgment).toBe(WALL_FILTER_ID);
    expect(receipt.mode).toBe("shadow");
    expect(receipt.decided_by).toBe("fallback");
  });

  it("active mode: skips hunters and spends 0 tokens when infra noise is detected", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const { instance: mockJev } = createMockJev("infra_noise", 0.9, db);
    let huntersRan = false;

    const ports: WallPorts = {
      now: () => Date.now(),
      version: "1.0.0",
      loadScope: async () => ({ isReal: () => true, scopeOf: () => "real" }),
      logLines: () => [],
      codeFiles: async () => [],
      reader: async () => {
        huntersRan = true;
        return { text: "", tokens: 500 };
      },
      tellPm: async () => true,
      repair: {
        view: async () => null,
        report: async () => "",
        tokens: async () => null,
        busy: async () => false,
        changedFiles: async () => null,
        revert: async () => ({ ok: true, detail: "" }),
      },
      release: { drill: async () => null, canary: async () => null },
      bench: {
        available: async () => true,
        armSet: async () => null,
        ensureArm: async () => "done",
        compare: async () => "pass",
        score: async () => 1.0,
      },
      restart: async () => ({ ok: true, note: "" }),
      deferrals: { open: () => {}, close: () => {} },
    };

    const wall = createWall({
      db,
      kv: { get: async () => ({}), set: async () => {} },
      ports,
      log: () => {},
      jev: () => mockJev,
      settings: async () => ({ "jev.modes": `${WALL_FILTER_ID}=active` }),
    });

    const cls = {
      classKey: "c2",
      failureClass: "infra",
      reasonNorm: "provider quota exceeded",
      origin: "infra",
      firstSeen: 1,
      lastSeen: 2,
      total: 3,
      counts: [1, 2, 3] as [number, number, number],
      windows: [10, 100, 500] as [number, number, number],
      rung: 1 as const,
      state: "open" as const,
      recur7: 5,
      recur1: 2,
      failedMoves: 3,
      hunt: "none" as const,
      afterHuntFailed: 0,
      stage: "hunt" as const,
    };

    const result = await (wall as any).huntClass(cls, { hunters: 1, huntShare: 0.5, nightTokenCap: 100_000 } as any, Date.now());

    expect(huntersRan).toBe(false);
    expect(result.tokens).toBe(0);
    expect(result.state).toBe("unknown");

    const receipt = db.prepare("SELECT judgment, mode, decided_by, decision FROM lane_pilot_jev_receipt WHERE judgment=?").get(WALL_FILTER_ID) as any;
    expect(receipt).toBeDefined();
    expect(receipt.mode).toBe("active");
    expect(receipt.decided_by).toBe("jev");
    expect(receipt.decision).toBe("skip:infra_noise");
  });
});
