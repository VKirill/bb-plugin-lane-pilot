import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createJev, type JevAnswer, type JevClient, type JevQuestion, type JevRequest } from "@lane-pilot/jev";
import { uiShotsJudgment } from "@lane-pilot/jev/judgments/ui-shots";
import { validateDeliverable } from "../../src/rooms/validators/deliverable";
import { setJevForTests } from "@lane-pilot/jev";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function clientReturning(over: Record<string, number>): { client: JevClient; last: () => JevRequest | null } {
  let last: JevRequest | null = null;
  return {
    last: () => last,
    client: {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request: JevRequest) {
        last = request;
        const answers: Record<string, JevAnswer> = {};
        for (const [id, q] of Object.entries(request.questions)) {
          if (q.type === "noul") answers[id] = { type: "noul", noul: over[id.split("::").pop()!] ?? 0.05 };
          else if (q.type === "box") answers[id] = { type: "box", box: { top: 0.1, bottom: 0.9, left: 0.6, right: 0.99 }, confidence: 0.9 };
          else answers[id] = { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 };
        }
        return { ok: true, answers, model: "jev-test", usage: { input_tokens: 10, output_tokens: 2 }, latencyMs: 5, attempts: 1 };
      },
    },
  };
}

function hostStub(dom: string | null, broken = false) {
  return {
    host: {
      async run(_id: string, _cwd: string, command: string, _t: number) {
        if (command.includes("curl")) return { exitCode: 0, stdout: "200", stderr: "" };
        if (command.includes("browser-automation open")) return { exitCode: 0, stdout: "", stderr: "" };
        if (command.includes("browser-automation run")) return dom === null ? { exitCode: 3, stdout: "", stderr: "" } : { exitCode: 0, stdout: `REPORT ${dom}`, stderr: "" };
        if (command.includes("base64")) return { exitCode: 0, stdout: PNG, stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    },
    hostId: "h1",
    ...(broken ? {} : {}),
  };
}

const CLEAN_DOM = JSON.stringify({ hscroll: false, offRight: [], overlaps: 0, brokenImgs: 0, scrollW: 375, innerW: 375 });
const OVERFLOW_DOM = JSON.stringify({ hscroll: true, offRight: ["div#banner"], overlaps: 0, brokenImgs: 0, scrollW: 812, innerW: 375 });

describe("ui.page_shots judgment", () => {
  it("decides cut only when overflow probability passes the band", () => {
    const input = { url: "http://x", shots: [{ name: "375px", format: "png" as const, data_base64: PNG }] };
    const clean = uiShotsJudgment.decide({ s0: { type: "noul", noul: 0.05 }, b0: { type: "box", box: { top: 0, bottom: 1, left: 0, right: 1 }, confidence: 0.5 } }, { cut_p: 0.7, unsure_p: 0.3 }, input);
    expect(clean.decision?.verdict).toBe("clean");
    const cut = uiShotsJudgment.decide({ s0: { type: "noul", noul: 0.92 }, b0: { type: "box", box: { top: 0.1, bottom: 0.5, left: 0.8, right: 1 }, confidence: 0.9 } }, { cut_p: 0.7, unsure_p: 0.3 }, input);
    expect(cut.decision?.verdict).toBe("cut");
    expect(cut.decision?.box?.left).toBeCloseTo(0.8);
    const unsure = uiShotsJudgment.decide({ s0: { type: "noul", noul: 0.45 } }, { cut_p: 0.7, unsure_p: 0.3 }, input);
    expect(unsure.decision?.verdict).toBe("uncertain");
  });

  it("stateBuilder whitelists fields: extra input keys never reach the request", async () => {
    const { client, last } = clientReturning({});
    const jev = createJev({ client, db: null });
    await jev.judge(uiShotsJudgment, { url: "http://x", shots: [{ name: "a", format: "png", data_base64: PNG }], evil: "drop-me", nested: { nope: 1 } } as never, {});
    expect(last()).not.toBeNull();
    const state = last()!.state as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["page", "shots"]);
    expect(JSON.stringify(last())).not.toContain("drop-me");
  });
});

describe("page validator layers", () => {
  it("DOM probe is the gate: an overflowing page fails before Jev is asked", async () => {
    const { client } = clientReturning({});
    let asked = false;
    setJevForTests(createJev({ client: { ...client, call: async (r) => { asked = true; return client.call(r); } }, db: null }));
    const verdict = await validateDeliverable("page", "http://x", hostStub(OVERFLOW_DOM));
    setJevForTests(null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/horizontal scroll|right edge/);
    expect(asked).toBe(false);
  });

  it("a clean page passes with shots taken", async () => {
    const verdict = await validateDeliverable("page", "http://x", hostStub(CLEAN_DOM));
    expect(verdict.ok).toBe(true);
  });

  it("jev active + cut screenshot fails the page with the box as evidence", async () => {
    const { client } = clientReturning({ s0: 0.95, s1: 0.5 });
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const jev = createJev({ client, db: openDatabase(bb) });
    setJevForTests(jev);
    const verdict = await validateDeliverable("page", "http://x", { ...hostStub(CLEAN_DOM), jevCtx: { settings: { "jev.modes": "ui.page_shots=active" } } });
    setJevForTests(null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/cut off/);
  });

  it("semantic doubt goes to the layer-3 reviewer, not to Jev", async () => {
    const { client } = clientReturning({ s0: 0.4, s1: 0.35 });
    setJevForTests(createJev({ client, db: null }));
    let reviewGot: unknown = null;
    const verdict = await validateDeliverable("page", "http://x", {
      ...hostStub(CLEAN_DOM),
      jevCtx: { settings: { "jev.modes": "ui.page_shots=active" } },
      review: async (req) => { reviewGot = req; return { ok: false, reason: "heading from the brief is missing" }; },
    });
    setJevForTests(null);
    expect(reviewGot).not.toBeNull();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/heading/);
  });

  it("brief secrets never reach the Jev request state", async () => {
    const { client, last } = clientReturning({});
    setJevForTests(createJev({ client, db: null }));
    await validateDeliverable("page", "http://x?token=sk-secret-AAA", hostStub(CLEAN_DOM));
    setJevForTests(null);
    expect(last()).not.toBeNull();
    const state = last()!.state as { page: string; shots: Record<string, string> };
    expect(Object.keys(state).sort()).toEqual(["page", "shots"]);
  });
});
